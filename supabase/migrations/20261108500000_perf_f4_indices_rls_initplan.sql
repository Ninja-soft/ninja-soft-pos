-- =============================================================================
-- 20261108500000_perf_f4_indices_rls_initplan  (ADR-090 · F4 escalado, primer corte)
--
-- Rendimiento de base, sin cambiar reglas de acceso. Sale de la auditoría
-- scripts/db-audit-perf.mjs (estática sobre todas las migraciones) cruzada con
-- el catálogo de producción (sólo lectura: pg_indexes, pg_stat_user_tables,
-- EXPLAIN sin ANALYZE).
--
-- A) Índices faltantes en las tablas operativas grandes
--    * FKs sin índice que las cubra: un DELETE / UPDATE del padre o un join
--      por esa columna recorre la tabla entera. Las columnas casi siempre
--      nulas llevan índice parcial "where col is not null" (sirve igual para
--      "col = $1", que es lo que hacen la FK y los joins).
--    * Listas por negocio y fecha que hoy hacen index scan por tenant_id y
--      después ordenan en memoria todo el historial del negocio (EXPLAIN en
--      producción: payments usa payments_tenant_method_idx + Sort;
--      cash_movements usa cash_movements_tenant_id_idx + Filter + Sort).
--    * Tres índices redundantes (prefijo de otro) se borran.
--    Todos con "create index if not exists": en una base que ya los tenga, no
--    hacen nada. EN PRODUCCIÓN CON VOLUMEN conviene crearlos ANTES con
--    scripts/prod-indexes-concurrently.sql (CREATE INDEX CONCURRENTLY, fuera
--    de transacción, sin bloquear escrituras): esta migración después los
--    encuentra hechos. Un CREATE INDEX normal bloquea INSERT / UPDATE /
--    DELETE de la tabla mientras dura (con el volumen de hoy, milisegundos).
--
-- B) RLS: toda llamada a una función sin dependencia de la fila pasa a
--    "(select f())" (initplan: una vez por consulta, no una vez por fila).
--    ADR-083 lo hizo para current_tenant_id(); quedaban sueltos
--    internal_scope(), is_internal() (en policies RESTRICTIVE de sucursal),
--    is_tenant_manager() (SECURITY DEFINER: no se inlinea, una consulta a
--    tenant_users por fila) y tax_can_write('...') con argumento constante.
--    perf_initplan_wrap(expr) hace la reescritura de forma idempotente y
--    rls_policies_without_initplan() es el guardarraíl (debe dar 0, lo
--    verifica tests/integration/perf-f4-indices.test.ts).
--    No cambia ninguna regla: la misma expresión, evaluada una vez. Nunca
--    agrega "or is_internal()": los is_internal() que ya estaban en policies
--    RESTRICTIVE (ADR-045 / ADR-052) quedan iguales, sólo envueltos.
--
-- C) Guardarraíles de sólo lectura para service_role:
--    perf_fk_without_index(tablas) y perf_indexes_present(nombres).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Índices
-- -----------------------------------------------------------------------------

-- payments: lista de cobros del negocio por fecha (Ventas, Cobros QR,
-- conciliación) y FK reconciled_by -> users.
create index if not exists payments_tenant_created_idx
  on public.payments (tenant_id, created_at desc);
create index if not exists payments_reconciled_by_idx
  on public.payments (reconciled_by) where reconciled_by is not null;

-- sales: FKs a promociones y cupones (borrar una promo o un cupón recorría
-- todas las ventas).
create index if not exists sales_promo_idx
  on public.sales (promo_id) where promo_id is not null;
create index if not exists sales_coupon_idx
  on public.sales (coupon_id) where coupon_id is not null;

-- cash_movements: movimientos del negocio por fecha (Caja, reportes).
create index if not exists cash_movements_tenant_created_idx
  on public.cash_movements (tenant_id, created_at desc);

-- stock_movements: kardex por sucursal ordenado por fecha.
create index if not exists stock_movements_store_created_idx
  on public.stock_movements (store_id, created_at desc);

-- table_order_items: FK product_id -> products (on delete set null).
create index if not exists table_order_items_product_idx
  on public.table_order_items (product_id) where product_id is not null;

-- fiscal_documents: lista de comprobantes por estado (ARCA: pendientes,
-- errores, aprobados), por sucursal, y FKs sin índice.
create index if not exists fiscal_documents_tenant_status_created_idx
  on public.fiscal_documents (tenant_id, status, created_at desc);
create index if not exists fiscal_documents_store_created_idx
  on public.fiscal_documents (store_id, created_at desc) where store_id is not null;
create index if not exists fiscal_documents_return_idx
  on public.fiscal_documents (return_id) where return_id is not null;
create index if not exists fiscal_documents_assoc_idx
  on public.fiscal_documents (assoc_document_id) where assoc_document_id is not null;
create index if not exists fiscal_documents_caea_idx
  on public.fiscal_documents (caea_id) where caea_id is not null;

-- Redundantes: prefijo exacto de otro índice (mismo predicado). Cuestan en
-- cada insert y no aportan lecturas; las FKs siguen cubiertas por el índice
-- que los contiene (P7 de scripts/db-audit-perf.mjs).
--   audit_logs_tenant_idx         = audit_logs_tenant_created_idx (tenant_id, created_at)
--   cash_movements_tenant_id_idx  ⊂ cash_movements_tenant_created_idx
--   stock_movements_store_id_idx  ⊂ stock_movements_store_created_idx
drop index if exists public.audit_logs_tenant_idx;
drop index if exists public.cash_movements_tenant_id_idx;
drop index if exists public.stock_movements_store_id_idx;

-- -----------------------------------------------------------------------------
-- B) RLS initplan
-- -----------------------------------------------------------------------------

-- Envuelve en "(select ...)" las llamadas de una expresión de policy (texto
-- de pg_policies) a funciones de public o auth que no dependen de la fila:
-- sin argumentos, o con un único argumento literal ('x'::text). Sólo
-- funciones STABLE o IMMUTABLE que no devuelven conjuntos. Lo que ya está
-- envuelto queda igual (idempotente).
create or replace function public.perf_initplan_wrap(p_expr text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v text := p_expr;
  m text[];
  v_call text;
  v_schema text;
  v_args int;
  v_done text[] := '{}';
  v_kept text[] := '{}';
  v_seg text;
  v_pos int;
  i int;
begin
  if v is null then
    return null;
  end if;

  -- 1) Proteger lo ya envuelto, "( SELECT f() AS f)", con un marcador que
  --    después se restaura tal cual (una expresión sin cambios vuelve
  --    idéntica, con cualquier search_path).
  loop
    v_seg := (regexp_match(
                v,
                '(\( SELECT (?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*\((?:''[^'']*''::[a-z ]+)?\) AS [a-z_][a-z0-9_]*\))'))[1];
    exit when v_seg is null;
    v_kept := v_kept || v_seg;
    v_pos := position(v_seg in v);
    v := overlay(v placing '@@w' || cardinality(v_kept) || '@@' from v_pos for length(v_seg));
  end loop;

  -- 2) Llamadas sueltas elegibles -> "(select f())".
  for m in
    select regexp_matches(
             v,
             '(?:^|[^a-zA-Z0-9_.@])((?:([a-z_][a-z0-9_]*)\.)?([a-z_][a-z0-9_]*)\(((?:''[^'']*''::[a-z ]+)?)\))',
             'g')
  loop
    v_call := m[1];
    if v_call = any (v_done) then
      continue;
    end if;
    v_done := v_done || v_call;
    v_schema := coalesce(m[2], 'public');
    v_args := case when m[4] = '' then 0 else 1 end;
    if v_schema not in ('public', 'auth') then
      continue;
    end if;
    if not exists (
      select 1
        from pg_catalog.pg_proc f
        join pg_catalog.pg_namespace n on n.oid = f.pronamespace
       where n.nspname = v_schema
         and f.proname = m[3]
         and f.pronargs = v_args
         and f.provolatile in ('s', 'i')
         and not f.proretset
    ) then
      continue;
    end if;
    v := regexp_replace(
           v,
           '(^|[^a-zA-Z0-9_.@])' || regexp_replace(v_call, '([.()\[\]{}*+?^$|\\])', '\\\1', 'g'),
           '\1(select ' || replace(v_call, '\', '\\') || ')',
           'g');
  end loop;

  -- 3) Restaurar lo protegido.
  for i in reverse coalesce(cardinality(v_kept), 0) .. 1 loop
    v := replace(v, '@@w' || i || '@@', v_kept[i]);
  end loop;
  return v;
end;
$$;
revoke all on function public.perf_initplan_wrap(text) from public, anon, authenticated;
grant execute on function public.perf_initplan_wrap(text) to service_role;

comment on function public.perf_initplan_wrap(text) is
  'Reescribe una expresión de policy envolviendo en (select ...) las llamadas sin dependencia de la fila (initplan). Idempotente. ADR-090.';

do $$
declare
  r record;
  v_qual text;
  v_check text;
  v_using_sql text;
  v_check_sql text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
      from pg_catalog.pg_policies
     where schemaname = 'public'
  loop
    v_qual := public.perf_initplan_wrap(r.qual);
    v_check := public.perf_initplan_wrap(r.with_check);
    if v_qual is not distinct from r.qual and v_check is not distinct from r.with_check then
      continue;
    end if;
    v_using_sql := case when v_qual is null then '' else format(' using (%s)', v_qual) end;
    v_check_sql := case when v_check is null then '' else format(' with check (%s)', v_check) end;
    execute format('alter policy %I on %I.%I%s%s', r.policyname, r.schemaname, r.tablename, v_using_sql, v_check_sql);
  end loop;
end $$;

-- Guardarraíl: policies de public con alguna llamada que podría ser initplan
-- y no lo es. Debe dar 0 filas. Sólo service_role.
create or replace function public.rls_policies_without_initplan()
returns table (tablename name, policyname name)
language sql
stable
security definer
set search_path = ''
as $$
  select p.tablename, p.policyname
    from pg_catalog.pg_policies p
   where p.schemaname = 'public'
     and (public.perf_initplan_wrap(p.qual) is distinct from p.qual
          or public.perf_initplan_wrap(p.with_check) is distinct from p.with_check)
   order by 1, 2;
$$;
revoke all on function public.rls_policies_without_initplan() from public, anon, authenticated;
grant execute on function public.rls_policies_without_initplan() to service_role;

-- -----------------------------------------------------------------------------
-- C) Guardarraíles de índices (sólo lectura, service_role)
-- -----------------------------------------------------------------------------

-- FKs de las tablas pedidas sin un índice cuyas columnas iniciales sean las de
-- la FK (un índice parcial "col is not null" cuenta para FKs de una columna).
create or replace function public.perf_fk_without_index(p_tables text[])
returns table (table_name text, constraint_name name, columns text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.conrelid::regclass::text,
         c.conname,
         (select string_agg(a.attname, ', ' order by k.ord)
            from unnest(c.conkey) with ordinality k(attnum, ord)
            join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
   where c.contype = 'f'
     and n.nspname = 'public'
     and t.relname = any (p_tables)
     and not exists (
       select 1
         from pg_catalog.pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
          and (
            i.indpred is null
            or (cardinality(c.conkey) = 1
                and pg_catalog.pg_get_expr(i.indpred, i.indrelid) = format(
                      '(%s IS NOT NULL)',
                      (select quote_ident(a.attname) from pg_catalog.pg_attribute a
                        where a.attrelid = c.conrelid and a.attnum = c.conkey[1])))
          )
     )
   order by 1, 2;
$$;
revoke all on function public.perf_fk_without_index(text[]) from public, anon, authenticated;
grant execute on function public.perf_fk_without_index(text[]) to service_role;

-- Cuáles de los índices pedidos existen en public.
create or replace function public.perf_indexes_present(p_names text[])
returns table (indexname name)
language sql
stable
security definer
set search_path = ''
as $$
  select i.indexname
    from pg_catalog.pg_indexes i
   where i.schemaname = 'public'
     and i.indexname = any (p_names)
   order by 1;
$$;
revoke all on function public.perf_indexes_present(text[]) from public, anon, authenticated;
grant execute on function public.perf_indexes_present(text[]) to service_role;
