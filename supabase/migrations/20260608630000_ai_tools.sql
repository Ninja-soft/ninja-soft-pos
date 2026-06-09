-- =============================================================================
-- 20260608630000_ai_tools  (SaaS — Asistente IA con function-calling)
--
-- Catálogo CURADO de herramientas de SOLO LECTURA para el Asistente IA (edge fn
-- ai_assistant, vía function-calling de Gemini). El modelo elige QUÉ tool llamar
-- y con qué parámetros seguros (query string, period, limit); la edge function
-- ejecuta la RPC correspondiente con su admin client (service_role) pasando
-- SIEMPRE el p_tenant_id resuelto SERVER-SIDE del usuario autenticado — NUNCA un
-- tenant que venga del modelo.
--
-- Reglas comunes a TODAS las funciones de este archivo:
--   • SECURITY DEFINER + set search_path = public, pg_temp.
--   • SOLO LECTURA (sin INSERT/UPDATE/DELETE). language sql, stable.
--   • Scope ESTRICTO por p_tenant_id: cada filtro lleva tenant_id = p_tenant_id;
--     jamás cruzan tenants.
--   • Límites CLAMPEADOS en SQL: least(coalesce(p_limit,25), 50). Nunca row-dumps
--     masivos (hay tenants con cientos de miles de productos) → caps + agregados.
--   • EXECUTE solo para service_role: revoke a public/anon/authenticated. Ningún
--     cliente autenticado las llama directo; solo la edge function con su admin.
--   • NUNCA tocan datos sensibles: platform_secrets, tokens/credenciales de
--     Mercado Pago, claves API, contraseñas/hashes, audit_logs, ni datos de otros
--     tenants. Solo exponen contacto NO sensible y agregados de negocio.
--
-- Funciones:
--   ai_search_products  — buscar productos (nombre, precio, costo, stock, cat, ean)
--   ai_sales_summary    — totales de ventas por período (+ desglose opcional)
--   ai_top_products     — más vendidos por período
--   ai_list_customers   — clientes (nombre, saldo cta cte, contacto no sensible)
--   ai_cash_status      — estado de caja (turnos abiertos, efectivo esperado)
--   ai_stock_report     — stock + valor de inventario (con detalle acotado)
--   ai_business_overview— overview agregado (espejo de ai_tenant_snapshot)
-- =============================================================================

-- ── Helper interno: resuelve el inicio (UTC) de un período nombrado ──────────
-- 'today'|'yesterday'|'week'(7d)|'month'(día 1). Cualquier otro → 'today'.
-- IMMUTABLE-ish: depende de now(); lo marcamos stable. No es SECURITY DEFINER
-- (no toca tablas); solo aritmética de fechas. EXECUTE abierto es inocuo, pero
-- lo restringimos igual por prolijidad.
create or replace function ai__period_start(p_period text)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_period, 'today'))
    when 'yesterday' then date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '1 day'
    when 'week'      then now() - interval '7 days'
    when 'month'     then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
    else                  date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  end;
$$;

-- Fin (exclusivo) del período. Solo 'yesterday' tiene techo (inicio de hoy); el
-- resto corre hasta 'ahora'.
create or replace function ai__period_end(p_period text)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select case lower(coalesce(p_period, 'today'))
    when 'yesterday' then date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    else now()
  end;
$$;

revoke all on function ai__period_start(text) from public, anon, authenticated;
revoke all on function ai__period_end(text) from public, anon, authenticated;
grant execute on function ai__period_start(text) to service_role;
grant execute on function ai__period_end(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_search_products(p_tenant_id, p_query?, p_only_low_stock?, p_limit?)
-- Busca productos activos del tenant por nombre/sku/barcode (ILIKE). Devuelve
-- nombre, precio, costo, stock, mínimo, categoría y código de barras (ean). Cap
-- 25 (máx 50). Orden: stock bajo primero (si aplica), luego nombre.
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
    limit least(coalesce(p_limit, 25), 50)
  )
  select jsonb_build_object(
    'count', (select count(*) from rows),
    'products', coalesce((select jsonb_agg(to_jsonb(r)) from rows r), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_sales_summary(p_tenant_id, p_period?, p_group_by?)
-- Totales de ventas COMPLETADAS del período (today|yesterday|week|month). Sin
-- p_group_by → totales globales (cantidad, monto, ticket promedio). Con
-- p_group_by:
--   'day'            → serie por día (fecha, ventas, total)
--   'payment_method' → por medio de pago (sobre payments del período)
--   'category'       → por categoría de producto (sobre sale_items del período)
-- Series acotadas a 50 filas. Montos agregados EN SQL (sin volcar filas).
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
            'date', to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD'),
            'sales_count', count(*),
            'total_amount', coalesce(sum(total),0)
          ) as x
          from base
          group by (created_at at time zone 'utc')::date
          order by (created_at at time zone 'utc')::date
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
-- ai_top_products(p_tenant_id, p_period?, p_limit?)
-- Productos más vendidos (por cantidad) en el período, sobre sale_items de
-- ventas COMPLETADAS. Devuelve nombre, unidades y monto. Cap 10 (máx 50).
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
    limit least(coalesce(p_limit, 10), 50)
  )
  select jsonb_build_object(
    'period', lower(coalesce(p_period, 'week')),
    'products', coalesce((select jsonb_agg(to_jsonb(a)) from agg a), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_list_customers(p_tenant_id, p_query?, p_only_debtors?, p_limit?)
-- Lista clientes del tenant con su saldo de cuenta corriente (suma de delta en
-- customer_account_movements; >0 = debe). Contacto NO sensible: email/teléfono
-- (datos de contacto comercial del propio tenant; NO se exponen documento ni
-- credenciales). Filtro por nombre (ILIKE) y/o solo deudores. Cap 25 (máx 50).
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
    limit least(coalesce(p_limit, 25), 50)
  )
  select jsonb_build_object(
    'count', (select count(*) from rows),
    'total_debt', (select coalesce(sum(balance),0) from rows where balance > 0.5),
    'customers', coalesce((select jsonb_agg(to_jsonb(r)) from rows r), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_cash_status(p_tenant_id)
-- Estado de caja: turnos abiertos y efectivo esperado por turno + total. Mismo
-- cálculo canónico que close_cash_shift: apertura + ingresos − egresos + ventas
-- cash − anulaciones cash. Si no hay turno abierto, lo informa.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_cash_status(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with shifts as (
    select id, opening_amount, opened_at
    from cash_shifts
    where tenant_id = p_tenant_id and status = 'open'
    order by opened_at desc
    limit 20
  ),
  expected as (
    select
      sh.id,
      sh.opening_amount,
      sh.opened_at,
      sh.opening_amount + coalesce((
        select sum(case
          when cm.type = 'income' then cm.amount
          when cm.type = 'expense' then -cm.amount
          when cm.type = 'sale' and cm.payment_method = 'cash' then cm.amount
          when cm.type = 'sale_void' and cm.payment_method = 'cash' then -cm.amount
          else 0 end)
        from cash_movements cm
        where cm.tenant_id = p_tenant_id and cm.cash_shift_id = sh.id
      ), 0) as expected_cash
    from shifts sh
  )
  select jsonb_build_object(
    'open_shifts', (select count(*) from shifts),
    'total_expected_cash', (select coalesce(sum(expected_cash),0) from expected),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'opened_at', to_char(e.opened_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI"Z"'),
        'opening_amount', e.opening_amount,
        'expected_cash', round(e.expected_cash, 2)
      ) order by e.opened_at desc)
      from expected e
    ), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_stock_report(p_tenant_id, p_only_low?, p_limit?)
-- Reporte de stock: valor de inventario (a costo y a venta) + cantidad de
-- productos con stock bajo (agregados en SQL), y un DETALLE acotado de productos
-- (los de stock más bajo primero). Cap 25 (máx 50).
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
    limit least(coalesce(p_limit, 25), 50)
  )
  select jsonb_build_object(
    'inventory_value_cost', (select coalesce(sum(coalesce(cost,0) * coalesce(stock,0)),0) from tracked),
    'inventory_value_sale', (select coalesce(sum(coalesce(price,0) * coalesce(stock,0)),0) from tracked),
    'tracked_products', (select count(*) from tracked),
    'low_stock_count', (select count(*) from tracked where low_stock),
    'products', coalesce((select jsonb_agg(to_jsonb(d)) from detail d), '[]'::jsonb)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- ai_business_overview(p_tenant_id)
-- Overview agregado del negocio (espejo de ai_tenant_snapshot, reusándolo): nº
-- de productos activos, stock bajo, valor de inventario, clientes y addons
-- activos. Pensado como "panorama" base de drill-down.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function ai_business_overview(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ai_tenant_snapshot(p_tenant_id);
$$;

-- ── Permisos: SOLO service_role ejecuta estas RPCs ───────────────────────────
revoke all on function ai_search_products(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function ai_sales_summary(uuid, text, text)          from public, anon, authenticated;
revoke all on function ai_top_products(uuid, text, int)            from public, anon, authenticated;
revoke all on function ai_list_customers(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function ai_cash_status(uuid)                        from public, anon, authenticated;
revoke all on function ai_stock_report(uuid, boolean, int)         from public, anon, authenticated;
revoke all on function ai_business_overview(uuid)                  from public, anon, authenticated;

grant execute on function ai_search_products(uuid, text, boolean, int) to service_role;
grant execute on function ai_sales_summary(uuid, text, text)          to service_role;
grant execute on function ai_top_products(uuid, text, int)            to service_role;
grant execute on function ai_list_customers(uuid, text, boolean, int) to service_role;
grant execute on function ai_cash_status(uuid)                        to service_role;
grant execute on function ai_stock_report(uuid, boolean, int)         to service_role;
grant execute on function ai_business_overview(uuid)                  to service_role;
