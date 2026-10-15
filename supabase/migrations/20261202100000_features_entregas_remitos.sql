-- =============================================================================
-- 20261202100000_features_entregas_remitos  (F11 · H33 + H32, ADR-136)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • entregas_remitos (OPTIONAL, grupo ventas): vender stock de otras
--     sucursales o de otros depósitos habilitados, partir la entrega de una
--     venta (retira ahora, retira en otra sucursal, envío) con estados por
--     entrega en la expedición, y remitos de entrega y de envío con COT.
--     Pro, Business y Enterprise: el mismo corte que depositos y
--     pedidos_despacho (ADR-085, ADR-129), de las que depende. Vender de otra
--     sucursal pide además stock_sucursales (Business+), que el servidor
--     exige aparte.
--
-- La configuración de cada depósito (vendible, prioridad y sucursales que lo
-- usan) es parte de `depositos`, no de esta feature.
--
-- El gating real vive en las RPC de 20261202100100 y 20261202100200
-- (tenant_has_feature_for). La UI es sólo cortesía.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('entregas_remitos', 'Entregas partidas y remitos',
   'Vender stock de otras sucursales o depósitos habilitados, partir la entrega de una venta (retira ahora, retira en otra sucursal o envío) con estados por entrega, y remitos de entrega y de envío con COT',
   'ventas', false, 57)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('entregas_remitos', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'entregas_remitos');
