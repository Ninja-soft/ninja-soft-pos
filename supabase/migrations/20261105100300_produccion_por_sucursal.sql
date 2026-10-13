-- =============================================================================
-- 20261105100300_produccion_por_sucursal  (F17 · H94 · ADR-080)
--
-- Producción (batch) por sucursal, igual que la merma (20261015200000). Hasta
-- acá register_production (única definición: 20260609200000_stock_production)
-- no recibía sucursal y el trigger de stock_movements mandaba todo a la
-- principal: la heladería de Norte que preparaba 20 kg los sumaba en Centro.
--
-- Suma p_store_id opcional al final: null = como antes (principal). Con
-- sucursal: tiene que ser del negocio, estar viva y el usuario tener acceso;
-- fuera de la principal exige multi_sucursal + stock_sucursales (mismo
-- criterio que adjust_store_stock y register_stock_waste). Sigue SECURITY
-- INVOKER + RLS. Se dropea la firma vieja (como la merma) para que PostgREST
-- no tenga dos candidatas.
--
-- Auditoría: el movimiento queda en stock_movements (libro de stock, con
-- created_by y sucursal) como la merma y el ajuste; no es una acción crítica
-- nueva.
-- =============================================================================

drop function if exists register_production(uuid, numeric, text);
create or replace function register_production(
  p_product_id uuid,
  p_qty        numeric,
  p_notes      text default null,
  p_store_id   uuid default null
)
returns numeric
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_new_stock numeric;
  v_tenant    uuid := current_tenant_id();
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'invalid_qty';
  end if;

  if p_store_id is not null then
    if not exists (
      select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
    ) then
      raise exception 'store_not_found';
    end if;
    if not coalesce(user_can_access_store(p_store_id), false) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if p_store_id is distinct from stock_default_store(v_tenant) then
      if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
        raise exception 'feature_not_in_plan: multi_sucursal';
      end if;
      if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
        raise exception 'feature_not_in_plan: stock_sucursales';
      end if;
    end if;
  end if;

  -- RLS limita el UPDATE al tenant actual; si no matchea, no actualiza nada.
  update products
     set stock = stock + p_qty,
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_product_id
     and tenant_id = v_tenant
     and deleted_at is null
  returning stock into v_new_stock;

  if v_new_stock is null then
    raise exception 'product_not_found_or_forbidden';
  end if;

  insert into stock_movements (tenant_id, product_id, delta, reason, notes, created_by, store_id)
  values (v_tenant, p_product_id, p_qty, 'production', p_notes, auth.uid(), p_store_id);

  return v_new_stock;
end;
$$;
revoke all on function register_production(uuid, numeric, text, uuid) from public, anon;
grant execute on function register_production(uuid, numeric, text, uuid) to authenticated;
