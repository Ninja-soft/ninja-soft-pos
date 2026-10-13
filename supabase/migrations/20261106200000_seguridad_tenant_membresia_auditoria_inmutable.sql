-- =============================================================================
-- 20261106200000_seguridad_tenant_membresia_auditoria_inmutable  (ADR-083)
--
-- H118 · current_tenant_id() valida la membresía
--   Antes devolvía app_metadata.current_tenant_id del JWT sin mirar nada más:
--   un ex miembro (baja, suspensión de la membresía) o un JWT con un negocio
--   que no es suyo seguían pasando la RLS hasta que el token vencía (residual
--   S-07 de ADR-051). Ahora devuelve el negocio del JWT sólo si:
--     * el usuario tiene una membresía ACTIVA en ese negocio
--       (tenant_users.status = 'active'), o
--     * es staff interno operando en el panel interno (internal_scope(), ADR-052).
--   Si no, null: las policies "tenant_id = current_tenant_id()" no matchean.
--   STABLE + SECURITY DEFINER + search_path fijo. Para que se evalúe una sola
--   vez por consulta (initplan) todas las policies de public pasan a
--   "(select current_tenant_id())".
--   ensure_current_tenant() además corrige un negocio activo que dejó de ser
--   válido (lo cambia por la primera membresía activa).
--
-- H117 · audit_logs inmutable, con retención y hash encadenado
--   A) Inmutable: sin UPDATE / DELETE / TRUNCATE para anon, authenticated ni
--      service_role (grants), y un trigger que rechaza UPDATE y DELETE para
--      cualquier rol salvo dos procesos internos: el sellado de la cadena
--      (sólo completa columnas de la cadena vacías, el contenido no cambia) y
--      la retención (sólo borra lo vencido). Ambos son SECURITY DEFINER, sin
--      execute para clientes, y marcan la transacción.
--   B) Hash por fila (row_hash) al insertar y cadena por negocio
--      (chain_seq, prev_hash, hash) que sella un cron cada 5 minutos, fuera
--      de la transacción de la venta (no serializa las escrituras del negocio).
--      audit_chain_verify() la recorre para el panel interno.
--   C) Retención configurable: 24 meses por defecto (audit_retention_policy),
--      con override por plan (plans.limits.audit_retention_months, mínimo 12).
--      Las acciones fiscales y comerciales (ventas, cobros, caja, ARCA, IVA,
--      contabilidad, compras, cuenta corriente) quedan FUERA de la retención:
--      el Código Civil y Comercial (art. 328) pide conservar 10 años la
--      documentación respaldatoria y la Ley 11.683 la exige mientras no
--      prescriban los tributos. Lo borrado deja una lápida (seq + hashes) para
--      que la cadena se siga verificando.
--   D) El insert desde el cliente ya no puede escribir en otro negocio
--      (antes: "o current_tenant_id() is null") y no elige created_at.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- H118 · current_tenant_id()
-- -----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select case
             when j.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then j.v::uuid
           end as claimed
      from (select auth.jwt() -> 'app_metadata' ->> 'current_tenant_id' as v) j
  )
  select c.claimed
    from c
   where c.claimed is not null
     and (
       exists (
         select 1
           from public.tenant_users tu
          where tu.tenant_id = c.claimed
            and tu.user_id = auth.uid()
            and tu.status = 'active'
       )
       or public.internal_scope()
     );
$$;

comment on function public.current_tenant_id() is
  'Negocio activo del JWT sólo si el usuario es miembro activo (tenant_users.status = active) o staff en internal_scope(). Si no, null. ADR-083.';

grant execute on function public.current_tenant_id() to anon, authenticated, service_role;

-- Las policies de public pasan a "(select current_tenant_id())" para que la
-- membresía se valide una vez por consulta (initplan) y no una vez por fila.
do $$
declare
  r record;
  v_qual text;
  v_check text;
  v_using_sql text;
  v_check_sql text;
  c_wrapped constant text := '( SELECT current_tenant_id() AS current_tenant_id)';
  c_wrapped_pub constant text := '( SELECT public.current_tenant_id() AS current_tenant_id)';
  c_mark constant text := '@@ninja_ctid@@';
  c_new constant text := '(select current_tenant_id())';
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') like '%current_tenant_id()%'
            or coalesce(with_check, '') like '%current_tenant_id()%')
  loop
    v_qual := r.qual;
    v_check := r.with_check;
    if v_qual is not null then
      v_qual := replace(replace(v_qual, c_wrapped_pub, c_mark), c_wrapped, c_mark);
      v_qual := replace(v_qual, 'public.current_tenant_id()', 'current_tenant_id()');
      v_qual := replace(v_qual, 'current_tenant_id()', c_new);
      v_qual := replace(v_qual, c_mark, c_new);
    end if;
    if v_check is not null then
      v_check := replace(replace(v_check, c_wrapped_pub, c_mark), c_wrapped, c_mark);
      v_check := replace(v_check, 'public.current_tenant_id()', 'current_tenant_id()');
      v_check := replace(v_check, 'current_tenant_id()', c_new);
      v_check := replace(v_check, c_mark, c_new);
    end if;
    if v_qual is not distinct from r.qual and v_check is not distinct from r.with_check then
      continue;
    end if;
    v_using_sql := case when v_qual is null then '' else format(' using (%s)', v_qual) end;
    v_check_sql := case when v_check is null then '' else format(' with check (%s)', v_check) end;
    execute format('alter policy %I on %I.%I%s%s', r.policyname, r.schemaname, r.tablename, v_using_sql, v_check_sql);
  end loop;
end $$;

-- Guardarraíl de rendimiento: policies de public que llaman a
-- current_tenant_id() sin el "(select ...)". Sólo service_role.
create or replace function public.rls_bare_current_tenant_policies()
returns table (tablename name, policyname name)
language sql
stable
security definer
set search_path = ''
as $$
  select p.tablename, p.policyname
    from pg_catalog.pg_policies p
   where p.schemaname = 'public'
     and (
       replace(replace(coalesce(p.qual, ''), '( SELECT current_tenant_id() AS current_tenant_id)', ''),
               '( SELECT public.current_tenant_id() AS current_tenant_id)', '') like '%current_tenant_id()%'
       or
       replace(replace(coalesce(p.with_check, ''), '( SELECT current_tenant_id() AS current_tenant_id)', ''),
               '( SELECT public.current_tenant_id() AS current_tenant_id)', '') like '%current_tenant_id()%'
     );
$$;
revoke all on function public.rls_bare_current_tenant_policies() from public, anon, authenticated;
grant execute on function public.rls_bare_current_tenant_policies() to service_role;

-- Autocuración: también corrige un negocio activo que dejó de ser válido
-- (baja, membresía suspendida). Devuelve true sólo si el JWT del usuario tiene
-- que refrescarse, así el cliente no entra en un bucle de recargas.
create or replace function public.ensure_current_tenant()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
begin
  if auth.uid() is null or current_tenant_id() is not null then
    return false;
  end if;
  select tu.tenant_id into v_tenant
    from tenant_users tu
   where tu.user_id = auth.uid() and tu.status = 'active'
   order by tu.joined_at nulls last, tu.created_at
   limit 1;
  if v_tenant is null then
    return false;
  end if;
  begin
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                               || jsonb_build_object('current_tenant_id', v_tenant)
     where id = auth.uid()
       and coalesce(raw_app_meta_data ->> 'current_tenant_id', '') <> v_tenant::text;
  exception when others then
    raise warning 'ensure_current_tenant: %', sqlerrm;
    return false;
  end;
  return coalesce(auth.jwt() -> 'app_metadata' ->> 'current_tenant_id', '') <> v_tenant::text;
end;
$$;
revoke all on function public.ensure_current_tenant() from public, anon;
grant execute on function public.ensure_current_tenant() to authenticated;

-- -----------------------------------------------------------------------------
-- H117 · A) Columnas de la cadena e índices
-- -----------------------------------------------------------------------------
alter table public.audit_logs
  add column if not exists row_hash  text,
  add column if not exists chain_seq bigint,
  add column if not exists prev_hash text,
  add column if not exists hash      text;

comment on column public.audit_logs.row_hash  is 'sha256 del contenido de la fila (se calcula al insertar). ADR-083.';
comment on column public.audit_logs.chain_seq is 'Posición en la cadena del negocio (null = todavía sin sellar). ADR-083.';
comment on column public.audit_logs.prev_hash is 'hash de la fila anterior de la cadena del negocio. ADR-083.';
comment on column public.audit_logs.hash      is 'sha256(prev_hash:chain_seq:row_hash). ADR-083.';

-- Pendientes de sellar (se vacía a medida que corre el cron).
create index if not exists audit_logs_unsealed_idx
  on public.audit_logs (created_at, id)
  where chain_seq is null;

-- Recorrido de la cadena por negocio.
create index if not exists audit_logs_chain_idx
  on public.audit_logs (tenant_id, chain_seq)
  where chain_seq is not null;

-- Retención: búsqueda por antigüedad barata (created_at crece con la inserción).
create index if not exists audit_logs_created_brin
  on public.audit_logs using brin (created_at);

-- -----------------------------------------------------------------------------
-- H117 · B) Funciones de hash
-- -----------------------------------------------------------------------------
create or replace function public.audit_log_row_hash(
  p_id uuid, p_tenant uuid, p_actor uuid, p_store uuid,
  p_entity_type text, p_entity_id uuid, p_action text,
  p_before jsonb, p_after jsonb, p_reason text,
  p_ip inet, p_ua text, p_created timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    jsonb_build_array(
      p_id, p_tenant, p_actor, p_store, p_entity_type, p_entity_id, p_action,
      p_before, p_after, p_reason, p_ip::text, p_ua,
      to_char(p_created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
    )::text, 'UTF8')), 'hex');
$$;

-- Misma cuenta desde una fila en jsonb (to_jsonb(audit_logs) o el JSON de PostgREST).
create or replace function public.audit_log_row_hash_json(p jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select public.audit_log_row_hash(
    (p ->> 'id')::uuid, (p ->> 'tenant_id')::uuid, (p ->> 'actor_user_id')::uuid,
    (p ->> 'store_id')::uuid, p ->> 'entity_type', (p ->> 'entity_id')::uuid,
    p ->> 'action', p -> 'before_data', p -> 'after_data', p ->> 'reason',
    (p ->> 'ip_address')::inet, p ->> 'user_agent', (p ->> 'created_at')::timestamptz
  );
$$;

create or replace function public.audit_chain_link_hash(p_prev text, p_seq bigint, p_row_hash text)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    coalesce(p_prev, '') || ':' || p_seq::text || ':' || coalesce(p_row_hash, ''), 'UTF8')), 'hex');
$$;

revoke all on function public.audit_log_row_hash(uuid, uuid, uuid, uuid, text, uuid, text, jsonb, jsonb, text, inet, text, timestamptz) from public, anon;
revoke all on function public.audit_log_row_hash_json(jsonb) from public, anon;
revoke all on function public.audit_chain_link_hash(text, bigint, text) from public, anon;
-- authenticated: el trigger de insert corre con el rol del cliente (write_audit_log es INVOKER).
grant execute on function public.audit_log_row_hash(uuid, uuid, uuid, uuid, text, uuid, text, jsonb, jsonb, text, inet, text, timestamptz) to authenticated, service_role;
grant execute on function public.audit_log_row_hash_json(jsonb) to authenticated, service_role;
grant execute on function public.audit_chain_link_hash(text, bigint, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- H117 · C) Trigger de insert: hash de la fila, columnas de cadena vacías y,
-- desde el cliente, created_at = now().
-- (El nombre ordena después de audit_logs_fill_store, que completa store_id.)
-- -----------------------------------------------------------------------------
create or replace function public.audit_logs_before_insert_hash()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.created_at := now();
  end if;
  new.chain_seq := null;
  new.prev_hash := null;
  new.hash := null;
  new.row_hash := audit_log_row_hash(
    new.id, new.tenant_id, new.actor_user_id, new.store_id,
    new.entity_type, new.entity_id, new.action,
    new.before_data, new.after_data, new.reason,
    new.ip_address, new.user_agent, new.created_at
  );
  return new;
end;
$$;

drop trigger if exists audit_logs_zz_row_hash on public.audit_logs;
create trigger audit_logs_zz_row_hash
  before insert on public.audit_logs
  for each row execute function public.audit_logs_before_insert_hash();

-- -----------------------------------------------------------------------------
-- H117 · D) Inmutabilidad
-- -----------------------------------------------------------------------------
create or replace function public.audit_logs_guard_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- Los procesos internos corren como dueño de la función (SECURITY DEFINER);
  -- un cliente o el service_role por PostgREST nunca pasan esta condición.
  v_internal boolean := current_user not in ('anon', 'authenticated', 'service_role', 'authenticator');
  c_chain constant text[] := array['row_hash', 'chain_seq', 'prev_hash', 'hash'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'audit_logs_immutable' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if v_internal and current_setting('ninja.audit_retention', true) = 'on' then
      return old;
    end if;
    raise exception 'audit_logs_immutable'
      using errcode = '42501',
            hint = 'audit_logs es de solo agregado; lo vencido lo borra audit_retention_run().';
  end if;

  -- UPDATE: sólo el sellado de la cadena (columnas vacías que se completan,
  -- contenido idéntico).
  if v_internal
     and current_setting('ninja.audit_seal', true) = 'on'
     and old.chain_seq is null
     and new.chain_seq is not null
     and (old.row_hash is null or new.row_hash = old.row_hash)
     and (to_jsonb(new) - c_chain) = (to_jsonb(old) - c_chain)
  then
    return new;
  end if;
  raise exception 'audit_logs_immutable' using errcode = '42501';
end;
$$;

drop trigger if exists audit_logs_immutable on public.audit_logs;
create trigger audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_guard_immutable();

drop trigger if exists audit_logs_no_truncate on public.audit_logs;
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.audit_logs_guard_immutable();

revoke update, delete, truncate on public.audit_logs from public, anon, authenticated, service_role;

-- Insert desde el cliente: sólo en su negocio (validado por membresía),
-- registros de sistema sin negocio cuando no tiene ninguno, o staff en el
-- panel interno. Antes "current_tenant_id() is null" dejaba escribir en
-- cualquier negocio.
drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert
  with check (
    tenant_id = (select current_tenant_id())
    or (tenant_id is null and (select current_tenant_id()) is null)
    or (select internal_scope())
  );

-- -----------------------------------------------------------------------------
-- H117 · E) Cabeza de la cadena y lápidas
-- -----------------------------------------------------------------------------
create table if not exists public.audit_chain_heads (
  tenant_key uuid primary key,          -- tenant_id, o 0000... para los registros de sistema
  last_seq   bigint not null default 0,
  last_hash  text,
  updated_at timestamptz not null default now()
);
comment on table public.audit_chain_heads is
  'Último eslabón sellado de la cadena de audit_logs por negocio. Sólo procesos internos. ADR-083.';
alter table public.audit_chain_heads enable row level security;
revoke all on public.audit_chain_heads from public, anon, authenticated;

create table if not exists public.audit_log_tombstones (
  tenant_key  uuid not null,
  chain_seq   bigint not null,
  row_hash    text,
  prev_hash   text,
  hash        text not null,
  created_at  timestamptz not null,
  entity_type text not null,
  action      text not null,
  purged_at   timestamptz not null default now(),
  primary key (tenant_key, chain_seq)
);
comment on table public.audit_log_tombstones is
  'Lápidas de lo que borró la retención (sin contenido): mantienen verificable la cadena. ADR-083.';
alter table public.audit_log_tombstones enable row level security;
revoke all on public.audit_log_tombstones from public, anon, authenticated;

create or replace function public.audit_tombstones_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_log_tombstones_immutable' using errcode = '42501';
end;
$$;
drop trigger if exists audit_log_tombstones_immutable on public.audit_log_tombstones;
create trigger audit_log_tombstones_immutable
  before update or delete on public.audit_log_tombstones
  for each row execute function public.audit_tombstones_guard();

-- -----------------------------------------------------------------------------
-- H117 · F) Política de retención y reglas fiscales
-- -----------------------------------------------------------------------------
create table if not exists public.audit_retention_policy (
  id             boolean primary key default true check (id),
  enabled        boolean not null default true,
  default_months integer not null default 24 check (default_months >= 12),
  batch_limit    integer not null default 50000 check (batch_limit between 100 and 1000000),
  updated_at     timestamptz not null default now()
);
comment on table public.audit_retention_policy is
  'Retención de audit_logs (una fila). Override por plan: plans.limits.audit_retention_months (mínimo 12). Lo fiscal no se borra. ADR-083.';
insert into public.audit_retention_policy (id) values (true) on conflict (id) do nothing;
alter table public.audit_retention_policy enable row level security;
revoke all on public.audit_retention_policy from public, anon, authenticated;
grant select on public.audit_retention_policy to authenticated;
drop policy if exists audit_retention_policy_select on public.audit_retention_policy;
create policy audit_retention_policy_select on public.audit_retention_policy
  for select using ((select internal_scope()));

create table if not exists public.audit_fiscal_rules (
  prefix     text primary key check (char_length(prefix) between 2 and 60),
  note       text not null,
  created_at timestamptz not null default now()
);
comment on table public.audit_fiscal_rules is
  'Prefijos de entity_type o action que la retención NUNCA borra (documentación fiscal y comercial). Ante la duda se conserva. ADR-083.';
alter table public.audit_fiscal_rules enable row level security;
revoke all on public.audit_fiscal_rules from public, anon, authenticated;
grant select on public.audit_fiscal_rules to authenticated;
drop policy if exists audit_fiscal_rules_select on public.audit_fiscal_rules;
create policy audit_fiscal_rules_select on public.audit_fiscal_rules
  for select using ((select internal_scope()));

insert into public.audit_fiscal_rules (prefix, note) values
  ('sale',             'Ventas, anulaciones y devoluciones (comprobantes)'),
  ('payment',          'Cobros y medios de pago'),
  ('refund',           'Reintegros'),
  ('mp_refund',        'Reintegros por Mercado Pago'),
  ('cash_',            'Caja: turnos, movimientos, cierres'),
  ('z_',               'Cierres Z'),
  ('arca_',            'Facturación electrónica ARCA'),
  ('fiscal_',          'Comprobantes fiscales'),
  ('invoice',          'Facturas'),
  ('libro_iva',        'Libro IVA Digital'),
  ('tax_',             'Impuestos, padrones y regímenes'),
  ('perception',       'Percepciones'),
  ('retention',        'Retenciones'),
  ('acc_',             'Contabilidad'),
  ('purchase',         'Compras y comprobantes de proveedor'),
  ('supplier_invoice', 'Facturas de proveedor'),
  ('supplier_payment', 'Pagos a proveedores'),
  ('supplier_return',  'Devoluciones a proveedor'),
  ('treasury',         'Tesorería'),
  ('cheque',           'Cheques'),
  ('account_',         'Cuenta corriente de clientes (recibos y cargos)'),
  ('customer_account', 'Cuenta corriente de clientes'),
  ('store_credit',     'Vales y saldo a favor'),
  ('settlement',       'Liquidaciones de procesadores'),
  ('voucher',          'Cupones de tarjeta')
on conflict (prefix) do nothing;

create or replace function public.audit_is_fiscal(p_entity_type text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from audit_fiscal_rules r
     where starts_with(lower(coalesce(p_entity_type, '')), r.prefix)
        or starts_with(lower(coalesce(p_action, '')), r.prefix)
  );
$$;
revoke all on function public.audit_is_fiscal(text, text) from public, anon, authenticated;
grant execute on function public.audit_is_fiscal(text, text) to service_role;

create or replace function public.audit_retention_months_for(p_tenant uuid, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(12, coalesce(
    (select (p.limits ->> 'audit_retention_months')::integer
       from subscriptions s
       join plans p on p.id = s.plan_id
      where s.tenant_id = p_tenant
        and (p.limits ->> 'audit_retention_months') ~ '^[0-9]{1,4}$'
      limit 1),
    p_default,
    24));
$$;
revoke all on function public.audit_retention_months_for(uuid, integer) from public, anon, authenticated;
grant execute on function public.audit_retention_months_for(uuid, integer) to service_role;

-- -----------------------------------------------------------------------------
-- H117 · G) Sellado de la cadena (cron cada 5 minutos)
-- -----------------------------------------------------------------------------
create or replace function public.audit_chain_seal(p_tenant uuid default null, p_limit integer default 20000)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_key uuid;
  v_seq bigint;
  v_prev text;
  v_row_hash text;
  v_hash text;
  v_n integer := 0;
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  perform set_config('ninja.audit_seal', 'on', true);
  for r in
    select a.*
      from audit_logs a
     where a.chain_seq is null
       and (p_tenant is null or a.tenant_id = p_tenant)
     order by a.created_at, a.id
     limit greatest(coalesce(p_limit, 20000), 1)
       for update skip locked
  loop
    v_key := coalesce(r.tenant_id, c_zero);
    insert into audit_chain_heads (tenant_key) values (v_key) on conflict (tenant_key) do nothing;
    select h.last_seq, h.last_hash into v_seq, v_prev
      from audit_chain_heads h where h.tenant_key = v_key for update;
    -- Filas anteriores a esta migración no tienen row_hash: se calcula ahora.
    -- Si ya lo tenían se respeta el original (una alteración previa al
    -- sellado queda a la vista en la verificación).
    v_row_hash := coalesce(r.row_hash, audit_log_row_hash(
      r.id, r.tenant_id, r.actor_user_id, r.store_id, r.entity_type, r.entity_id,
      r.action, r.before_data, r.after_data, r.reason, r.ip_address, r.user_agent, r.created_at));
    v_seq := v_seq + 1;
    v_hash := audit_chain_link_hash(v_prev, v_seq, v_row_hash);
    update audit_logs
       set chain_seq = v_seq, prev_hash = v_prev, hash = v_hash, row_hash = v_row_hash
     where id = r.id;
    update audit_chain_heads
       set last_seq = v_seq, last_hash = v_hash, updated_at = now()
     where tenant_key = v_key;
    v_n := v_n + 1;
  end loop;
  perform set_config('ninja.audit_seal', 'off', true);
  return v_n;
end;
$$;
revoke all on function public.audit_chain_seal(uuid, integer) from public, anon, authenticated;
grant execute on function public.audit_chain_seal(uuid, integer) to service_role;

-- -----------------------------------------------------------------------------
-- H117 · H) Verificación (panel interno)
-- -----------------------------------------------------------------------------
-- Pura: recibe filas ordenadas por chain_seq (filas de audit_logs o lápidas
-- con "pruned": true) y devuelve los problemas. La usa audit_chain_verify y
-- sirve para probar la detección con una copia alterada.
create or replace function public.audit_chain_check(p_rows jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  e jsonb;
  v_seq bigint;
  v_prev_seq bigint;
  v_prev_hash text;
  v_first boolean := true;
  v_n integer := 0;
  v_issues jsonb := '[]'::jsonb;
  v_pruned boolean;
begin
  for e in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_seq := (e ->> 'chain_seq')::bigint;
    if v_seq is null then
      continue;
    end if;
    v_n := v_n + 1;
    v_pruned := coalesce((e ->> 'pruned')::boolean, false);

    if v_first then
      if v_seq = 1 and (e ->> 'prev_hash') is not null then
        v_issues := v_issues || jsonb_build_object('seq', v_seq, 'kind', 'bad_genesis');
      end if;
    elsif v_seq <> v_prev_seq + 1 then
      v_issues := v_issues || jsonb_build_object('seq', v_seq, 'kind', 'gap', 'expected', v_prev_seq + 1);
    elsif (e ->> 'prev_hash') is distinct from v_prev_hash then
      v_issues := v_issues || jsonb_build_object('seq', v_seq, 'kind', 'link_broken');
    end if;

    if not v_pruned and audit_log_row_hash_json(e) is distinct from (e ->> 'row_hash') then
      v_issues := v_issues || jsonb_build_object('seq', v_seq, 'kind', 'altered', 'id', e ->> 'id');
    end if;
    if audit_chain_link_hash(e ->> 'prev_hash', v_seq, e ->> 'row_hash') is distinct from (e ->> 'hash') then
      v_issues := v_issues || jsonb_build_object('seq', v_seq, 'kind', 'hash_mismatch');
    end if;

    v_prev_seq := v_seq;
    v_prev_hash := e ->> 'hash';
    v_first := false;
    exit when jsonb_array_length(v_issues) >= 100;
  end loop;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_issues) = 0,
    'checked', v_n,
    'last_seq', v_prev_seq,
    'last_hash', v_prev_hash,
    'issues', v_issues
  );
end;
$$;
revoke all on function public.audit_chain_check(jsonb) from public, anon;
grant execute on function public.audit_chain_check(jsonb) to authenticated, service_role;

-- Recorre la cadena de un negocio (p_tenant null = registros de sistema).
-- Sólo staff en el panel interno o service_role.
create or replace function public.audit_chain_verify(
  p_tenant uuid,
  p_from_seq bigint default null,
  p_limit integer default 20000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_key uuid := coalesce(p_tenant, c_zero);
  v_limit integer := least(greatest(coalesce(p_limit, 20000), 1), 200000);
  v_rows jsonb;
  v_res jsonb;
  v_issues jsonb;
  v_head_seq bigint;
  v_unsealed integer := 0;
  v_unsealed_bad jsonb := '[]'::jsonb;
  r record;
begin
  if not (coalesce(auth.jwt() ->> 'role', '') = 'service_role' or internal_scope()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_agg(x.j order by x.seq) into v_rows
    from (
      select s.j, s.seq
        from (
          select to_jsonb(a) as j, a.chain_seq as seq
            from audit_logs a
           where a.chain_seq is not null
             and ((p_tenant is null and a.tenant_id is null) or a.tenant_id = p_tenant)
             and (p_from_seq is null or a.chain_seq >= p_from_seq)
          union all
          select jsonb_build_object(
                   'chain_seq', t.chain_seq, 'row_hash', t.row_hash,
                   'prev_hash', t.prev_hash, 'hash', t.hash, 'pruned', true),
                 t.chain_seq
            from audit_log_tombstones t
           where t.tenant_key = v_key
             and (p_from_seq is null or t.chain_seq >= p_from_seq)
        ) s
       order by s.seq
       limit v_limit
    ) x;

  v_res := audit_chain_check(v_rows);
  v_issues := v_res -> 'issues';

  select h.last_seq into v_head_seq from audit_chain_heads h where h.tenant_key = v_key;
  if v_head_seq is not null and (v_res ->> 'checked')::integer < v_limit
     and (v_res ->> 'last_seq')::bigint is distinct from v_head_seq then
    v_issues := v_issues || jsonb_build_object('seq', v_head_seq, 'kind', 'tail_missing');
  end if;

  -- Filas todavía sin sellar: se controla su hash propio.
  for r in
    select a.*
      from audit_logs a
     where a.chain_seq is null
       and ((p_tenant is null and a.tenant_id is null) or a.tenant_id = p_tenant)
     limit v_limit
  loop
    v_unsealed := v_unsealed + 1;
    if r.row_hash is not null and r.row_hash is distinct from audit_log_row_hash(
         r.id, r.tenant_id, r.actor_user_id, r.store_id, r.entity_type, r.entity_id,
         r.action, r.before_data, r.after_data, r.reason, r.ip_address, r.user_agent, r.created_at) then
      v_unsealed_bad := v_unsealed_bad || jsonb_build_object('id', r.id, 'kind', 'altered_unsealed');
    end if;
  end loop;
  v_issues := v_issues || v_unsealed_bad;

  return jsonb_build_object(
    'ok', jsonb_array_length(v_issues) = 0,
    'tenant_id', p_tenant,
    'checked', (v_res ->> 'checked')::integer,
    'last_seq', (v_res ->> 'last_seq')::bigint,
    'head_seq', v_head_seq,
    'unsealed', v_unsealed,
    'issues', v_issues,
    'verified_at', now()
  );
end;
$$;
revoke all on function public.audit_chain_verify(uuid, bigint, integer) from public, anon;
grant execute on function public.audit_chain_verify(uuid, bigint, integer) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- H117 · I) Retención (cron diario)
-- -----------------------------------------------------------------------------
create or replace function public.audit_retention_run(p_tenant uuid default null, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_default integer;
  v_batch integer;
  v_ids uuid[];
  v_fiscal_kept bigint;
  v_deleted integer := 0;
  v_sealed integer := 0;
  c_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  select p.enabled, p.default_months, p.batch_limit
    into v_enabled, v_default, v_batch
    from audit_retention_policy p where p.id;
  v_enabled := coalesce(v_enabled, true);
  v_default := greatest(coalesce(v_default, 24), 12);
  v_batch := coalesce(v_batch, 50000);

  if not v_enabled then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  -- Lo que se borra tiene que estar sellado (deja lápida con su eslabón).
  if not p_dry_run then
    v_sealed := audit_chain_seal(p_tenant, v_batch);
  end if;

  select array_agg(c.id) into v_ids
    from (
      select a.id
        from audit_logs a
       where (p_tenant is null or a.tenant_id = p_tenant)
         and a.created_at < now() - interval '12 months'
         and a.chain_seq is not null
         and not audit_is_fiscal(a.entity_type, a.action)
         and a.created_at < now() - make_interval(months => audit_retention_months_for(a.tenant_id, v_default))
       order by a.created_at
       limit v_batch
    ) c;

  select count(*) into v_fiscal_kept
    from audit_logs a
   where (p_tenant is null or a.tenant_id = p_tenant)
     and a.created_at < now() - make_interval(months => v_default)
     and audit_is_fiscal(a.entity_type, a.action);

  if not p_dry_run and coalesce(array_length(v_ids, 1), 0) > 0 then
    insert into audit_log_tombstones (tenant_key, chain_seq, row_hash, prev_hash, hash, created_at, entity_type, action)
    select coalesce(a.tenant_id, c_zero), a.chain_seq, a.row_hash, a.prev_hash, a.hash, a.created_at, a.entity_type, a.action
      from audit_logs a
     where a.id = any (v_ids)
    on conflict (tenant_key, chain_seq) do nothing;

    perform set_config('ninja.audit_retention', 'on', true);
    delete from audit_logs a where a.id = any (v_ids);
    get diagnostics v_deleted = row_count;
    perform set_config('ninja.audit_retention', 'off', true);

    insert into audit_logs (tenant_id, entity_type, action, after_data)
    values (p_tenant, 'audit_logs', 'audit_retention_run',
            jsonb_build_object('deleted', v_deleted, 'fiscal_kept', v_fiscal_kept,
                               'default_months', v_default, 'scope_tenant', p_tenant));
  end if;

  return jsonb_build_object(
    'ok', true,
    'dry_run', p_dry_run,
    'sealed', v_sealed,
    'candidates', coalesce(array_length(v_ids, 1), 0),
    'deleted', v_deleted,
    'fiscal_kept', v_fiscal_kept,
    'default_months', v_default
  );
end;
$$;
revoke all on function public.audit_retention_run(uuid, boolean) from public, anon, authenticated;
grant execute on function public.audit_retention_run(uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- H117 · J) Crons (sin pg_cron, como en CI, se omiten)
-- -----------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron no disponible; se omiten audit-chain-seal y audit-retention.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'audit-chain-seal') then
    perform cron.unschedule('audit-chain-seal');
  end if;
  perform cron.schedule('audit-chain-seal', '*/5 * * * *', 'select public.audit_chain_seal(null, 20000);');
  if exists (select 1 from cron.job where jobname = 'audit-retention') then
    perform cron.unschedule('audit-retention');
  end if;
  perform cron.schedule('audit-retention', '37 4 * * *', 'select public.audit_retention_run(null, false);');
end;
$cron$;
