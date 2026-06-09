-- =============================================================================
-- 20260608670000_ai_tz_limit_fixes  (SaaS — Asistente IA: fixes TZ y LIMIT)
--
-- Correcciones a las RPCs de solo lectura del Asistente IA (definidas en
-- 20260608630000_ai_tools.sql). Dos bugs:
--
--  • BUG 10 — Bordes de fecha en UTC, no en hora Argentina (-03). ai__period_start
--    /ai__period_end calculaban "hoy"/"ayer"/"mes" con date_trunc(... 'utc'). A
--    las 22:00 AR el día UTC ya rotó a medianoche, así que la ventana "hoy"
--    arrancaba a las 21:00 AR del mismo día → excluía las ventas de la tarde y
--    metía las de anoche. Acá pasan a usar el día/mes CIVIL argentino
--    (America/Argentina/Buenos_Aires). 'week' sigue siendo ventana rodante (7d).
--    El espejo del lado edge (buildContext en ai_assistant/index.ts) se corrige
--    en paralelo. También el desglose group_by:'day' de ai_sales_summary etiqueta
--    la fecha por día AR (consistente con los nuevos bordes).
--
--  • BUG 21 — Clamp de p_limit no protegía negativos. least(coalesce(p_limit,25),50)
--    con p_limit=-5 daba -5 → "LIMIT must not be negative" (crash). Hoy lo tapa
--    clampLimit en TS, pero defensa en profundidad: ahora
--    greatest(least(coalesce(p_limit,N),50),1) — piso 1, techo 50.
--
-- Solo se recrean las funciones afectadas; el resto de 20260608630000 sigue
-- vigente. Mismas reglas (SECURITY DEFINER, search_path, SOLO LECTURA, scope por
-- p_tenant_id, EXECUTE solo service_role). NO deployar la edge fn acá (lo hace el
-- controller). Las funciones cuyo único cambio era el LIMIT pero que dependen de
-- los bordes (ai_sales_summary, ai_top_products) se benefician automáticamente
-- del fix de los helpers; ai_top_products se recrea además por el piso del LIMIT.
-- =============================================================================

-- ── Helper: inicio del período en HORA ARGENTINA ─────────────────────────────
-- 'today'    → 00:00 AR del día actual.
-- 'yesterday'→ 00:00 AR del día anterior.
-- 'week'     → ahora − 7 días (ventana rodante; agnóstica a la zona).
-- 'month'    → 00:00 AR del día 1 del mes actual.
-- Cualquier otro → 'today'.
-- date_trunc('day'|'month', now() at time zone <AR>) trunca en el reloj AR, y el
-- segundo `at time zone <AR>` reinterpreta ese timestamp local AR como timestamptz
-- (instante UTC del inicio del día/mes civil argentino).
create or replace function ai__period_start(p_period text)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_period, 'today'))
    when 'yesterday' then (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires') - interval '1 day'
    when 'week'      then now() - interval '7 days'
    when 'month'     then date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'
    else                  date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'
  end;
$$;

-- Fin (exclusivo) del período. Solo 'yesterday' tiene techo (inicio de HOY en
-- hora AR); el resto corre hasta 'ahora'.
create or replace function ai__period_end(p_period text)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_period, 'today'))
    when 'yesterday' then date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'
    else now()
  end;
$$;

revoke all on function ai__period_start(text) from public, anon, authenticated;
revoke all on function ai__period_end(text) from public, anon, authenticated;
grant execute on function ai__period_start(text) to service_role;
grant execute on function ai__period_end(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_search_products — BUG 21: piso de LIMIT en 1. (Sin otros cambios.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_search_products(
  p_tenant_id uuid,
  p_query text default null,
  p_only_low_stock boolean default false,
  p_limit int default 25
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with rows as (
    select
      p.name,
      p.price,
      p.cost,
      p.stock,
      p.stock_min,
      p.barcode as ean,
      p.sku,
      p.track_stock,
      c.name as category,
      (coalesce(p.track_stock,false) and coalesce(p.stock_min,0) > 0
         and coalesce(p.stock,0) <= coalesce(p.stock_min,0)) as low_stock
    from products p
    left join categories c
      on c.id = p.category_id and c.tenant_id = p_tenant_id
    where p.tenant_id = p_tenant_id
      and p.deleted_at is null
      and p.is_active = true
      and (
        p_query is null or btrim(p_query) = ''
        or p.name ilike '%' || btrim(p_query) || '%'
        or coalesce(p.sku,'') ilike '%' || btrim(p_query) || '%'
        or coalesce(p.barcode,'') ilike '%' || btrim(p_query) || '%'
      )
      and (
        coalesce(p_only_low_stock,false) = false
        or (coalesce(p.track_stock,false) and coalesce(p.stock_min,0) > 0
            and coalesce(p.stock,0) <= coalesce(p.stock_min,0))
      )
    order by low_stock desc, p.name asc
    limit greatest(least(coalesce(p_limit, 25), 50), 1)
  )
  select jsonb_build_object(
    'count', (select count(*) from rows),
    'products', coalesce((select jsonb_agg(to_jsonb(r)) from rows r), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_sales_summary — BUG 10: el desglose 'day' etiqueta por día ARGENTINA (los
-- totales y bounds ya vienen de los helpers AR recreados arriba).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_sales_summary(
  p_tenant_id uuid,
  p_period text default 'today',
  p_group_by text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select ai__period_start(p_period) as t0, ai__period_end(p_period) as t1
  ),
  base as (
    select s.id, s.total, s.created_at
    from sales s, bounds b
    where s.tenant_id = p_tenant_id
      and s.status = 'completed'
      and s.created_at >= b.t0
      and s.created_at <  b.t1
  )
  select jsonb_build_object(
    'period', lower(coalesce(p_period, 'today')),
    'group_by', lower(coalesce(p_group_by, 'none')),
    'totals', jsonb_build_object(
      'sales_count', (select count(*) from base),
      'total_amount', (select coalesce(sum(total),0) from base),
      'avg_ticket', (select case when count(*) > 0 then round(sum(total)/count(*), 2) else 0 end from base)
    ),
    'breakdown', case lower(coalesce(p_group_by, 'none'))
      when 'day' then coalesce((
        select jsonb_agg(x order by x->>'date')
        from (
          select jsonb_build_object(
            'date', to_char((created_at at time zone 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD'),
            'sales_count', count(*),
            'total_amount', coalesce(sum(total),0)
          ) as x
          from base
          group by (created_at at time zone 'America/Argentina/Buenos_Aires')::date
          order by (created_at at time zone 'America/Argentina/Buenos_Aires')::date
          limit 50
        ) d
      ), '[]'::jsonb)
      when 'payment_method' then coalesce((
        select jsonb_agg(x order by (x->>'amount')::numeric desc)
        from (
          select jsonb_build_object(
            'method', pay.method,
            'amount', coalesce(sum(pay.amount),0)
          ) as x
          from payments pay
          join base on base.id = pay.sale_id
          where pay.tenant_id = p_tenant_id
          group by pay.method
          order by coalesce(sum(pay.amount),0) desc
          limit 50
        ) m
      ), '[]'::jsonb)
      when 'category' then coalesce((
        select jsonb_agg(x order by (x->>'total_amount')::numeric desc)
        from (
          select jsonb_build_object(
            'category', coalesce(c.name, 'Sin categoría'),
            'qty', coalesce(sum(si.quantity),0),
            'total_amount', coalesce(sum(si.subtotal),0)
          ) as x
          from sale_items si
          join base on base.id = si.sale_id
          left join products p on p.id = si.product_id and p.tenant_id = p_tenant_id
          left join categories c on c.id = p.category_id and c.tenant_id = p_tenant_id
          where si.tenant_id = p_tenant_id
          group by coalesce(c.name, 'Sin categoría')
          order by coalesce(sum(si.subtotal),0) desc
          limit 50
        ) g
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_top_products — BUG 21: piso de LIMIT en 1. (Bounds ya AR vía helpers.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_top_products(
  p_tenant_id uuid,
  p_period text default 'week',
  p_limit int default 10
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select ai__period_start(p_period) as t0, ai__period_end(p_period) as t1
  ),
  agg as (
    select
      coalesce(nullif(btrim(si.product_name), ''), 'Sin nombre') as name,
      sum(si.quantity) as qty,
      sum(si.subtotal) as amount
    from sale_items si
    join sales s
      on s.id = si.sale_id and s.tenant_id = p_tenant_id and s.status = 'completed'
    , bounds b
    where si.tenant_id = p_tenant_id
      and si.created_at >= b.t0
      and si.created_at <  b.t1
    group by 1
    order by sum(si.quantity) desc
    limit greatest(least(coalesce(p_limit, 10), 50), 1)
  )
  select jsonb_build_object(
    'period', lower(coalesce(p_period, 'week')),
    'products', coalesce((select jsonb_agg(to_jsonb(a)) from agg a), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_list_customers — BUG 21: piso de LIMIT en 1. (Sin otros cambios.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_list_customers(
  p_tenant_id uuid,
  p_query text default null,
  p_only_debtors boolean default false,
  p_limit int default 25
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bal as (
    select customer_id, sum(delta) as balance
    from customer_account_movements
    where tenant_id = p_tenant_id
    group by customer_id
  ),
  rows as (
    select
      c.name,
      round(coalesce(b.balance, 0), 2) as balance,
      c.email,
      c.phone
    from customers c
    left join bal b on b.customer_id = c.id
    where c.tenant_id = p_tenant_id
      and c.deleted_at is null
      and (
        p_query is null or btrim(p_query) = ''
        or c.name ilike '%' || btrim(p_query) || '%'
      )
      and (
        coalesce(p_only_debtors, false) = false
        or coalesce(b.balance, 0) > 0.5
      )
    order by coalesce(b.balance, 0) desc, c.name asc
    limit greatest(least(coalesce(p_limit, 25), 50), 1)
  )
  select jsonb_build_object(
    'count', (select count(*) from rows),
    'total_debt', (select coalesce(sum(balance),0) from rows where balance > 0.5),
    'customers', coalesce((select jsonb_agg(to_jsonb(r)) from rows r), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_stock_report — BUG 21: piso de LIMIT en 1. (Sin otros cambios.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_stock_report(
  p_tenant_id uuid,
  p_only_low boolean default false,
  p_limit int default 25
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with tracked as (
    select p.name, p.stock, p.stock_min, p.cost, p.price,
      (coalesce(p.stock_min,0) > 0 and coalesce(p.stock,0) <= coalesce(p.stock_min,0)) as low_stock
    from products p
    where p.tenant_id = p_tenant_id
      and p.deleted_at is null
      and p.is_active = true
      and coalesce(p.track_stock, false) = true
  ),
  detail as (
    select name, stock, stock_min, low_stock
    from tracked
    where coalesce(p_only_low, false) = false or low_stock = true
    order by low_stock desc, stock asc
    limit greatest(least(coalesce(p_limit, 25), 50), 1)
  )
  select jsonb_build_object(
    'inventory_value_cost', (select coalesce(sum(coalesce(cost,0) * coalesce(stock,0)),0) from tracked),
    'inventory_value_sale', (select coalesce(sum(coalesce(price,0) * coalesce(stock,0)),0) from tracked),
    'tracked_products', (select count(*) from tracked),
    'low_stock_count', (select count(*) from tracked where low_stock),
    'products', coalesce((select jsonb_agg(to_jsonb(d)) from detail d), '[]'::jsonb)
  );
$$;

-- ── Permisos: SOLO service_role ejecuta estas RPCs (re-otorgados tras recrear) ─
revoke all on function ai_search_products(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function ai_sales_summary(uuid, text, text)          from public, anon, authenticated;
revoke all on function ai_top_products(uuid, text, int)            from public, anon, authenticated;
revoke all on function ai_list_customers(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function ai_stock_report(uuid, boolean, int)         from public, anon, authenticated;

grant execute on function ai_search_products(uuid, text, boolean, int) to service_role;
grant execute on function ai_sales_summary(uuid, text, text)          to service_role;
grant execute on function ai_top_products(uuid, text, int)            to service_role;
grant execute on function ai_list_customers(uuid, text, boolean, int) to service_role;
grant execute on function ai_stock_report(uuid, boolean, int)         to service_role;
