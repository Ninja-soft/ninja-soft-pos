-- =============================================================================
-- 20260608610000_ai_tenant_snapshot  (SaaS Fix — Asistente IA)
--
-- ai_tenant_snapshot(p_tenant_id uuid) -> jsonb
--
-- Agregados EN VIVO de un tenant para el contexto del Asistente IA (edge fn
-- ai_assistant). Todo se calcula con COUNT/SUM EN SQL (cero transferencia de
-- filas): seguro incluso para tenants con cientos de miles de productos. Así la
-- IA responde "¿cuántos productos tengo cargados?" con el número real.
--
-- Devuelve: catálogo (productos activos, stock bajo, valor de inventario a costo
-- y a precio de venta), clientes activos, y addons activos (claves) del tenant.
--
-- SECURITY DEFINER + scoped ESTRICTAMENTE por p_tenant_id (todos los filtros
-- llevan tenant_id = p_tenant_id, nunca cruza tenants). EXECUTE solo para
-- service_role: lo invoca la edge function con su admin client; ningún cliente
-- autenticado lo llama directo (revoke a public/anon/authenticated).
-- =============================================================================
create or replace function ai_tenant_snapshot(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Catálogo: productos activos (no borrados).
    'products_active', (
      select count(*)
      from products p
      where p.tenant_id = p_tenant_id
        and p.deleted_at is null
        and p.is_active = true
    ),
    -- Stock bajo: con control de stock y por debajo (o igual) del mínimo.
    'low_stock', (
      select count(*)
      from products p
      where p.tenant_id = p_tenant_id
        and p.deleted_at is null
        and p.is_active = true
        and coalesce(p.track_stock, false) = true
        and coalesce(p.stock_min, 0) > 0
        and coalesce(p.stock, 0) <= coalesce(p.stock_min, 0)
    ),
    -- Valor de inventario a costo (sum stock*cost) — solo productos con control
    -- de stock; aproximado y orientativo.
    'inventory_value_cost', (
      select coalesce(sum(coalesce(p.cost, 0) * coalesce(p.stock, 0)), 0)
      from products p
      where p.tenant_id = p_tenant_id
        and p.deleted_at is null
        and p.is_active = true
        and coalesce(p.track_stock, false) = true
    ),
    -- Valor de inventario a precio de venta (sum stock*price).
    'inventory_value_sale', (
      select coalesce(sum(coalesce(p.price, 0) * coalesce(p.stock, 0)), 0)
      from products p
      where p.tenant_id = p_tenant_id
        and p.deleted_at is null
        and p.is_active = true
        and coalesce(p.track_stock, false) = true
    ),
    -- Clientes activos (no borrados).
    'customers_active', (
      select count(*)
      from customers c
      where c.tenant_id = p_tenant_id
        and c.deleted_at is null
    ),
    -- Addons activos del tenant (claves). Incluye los marcados para no renovar
    -- pero todavía vigentes (cancel_at_period_end con período en curso).
    'active_addons', coalesce((
      select jsonb_agg(distinct a.addon_key)
      from subscription_addons a
      where a.tenant_id = p_tenant_id
        and (
          a.status = 'active'
          or (
            a.cancel_at_period_end = true
            and a.current_period_end is not null
            and a.current_period_end >= current_date
          )
        )
    ), '[]'::jsonb)
  );
$$;

revoke all on function ai_tenant_snapshot(uuid) from public, anon, authenticated;
grant execute on function ai_tenant_snapshot(uuid) to service_role;
