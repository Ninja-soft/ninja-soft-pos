-- =============================================================================
-- 20261123100000_features_pedidos_despacho  (F11 · H32, ADR-129)
--
-- Feature de plan nueva (convención CLAUDE.md §6):
--   • pedidos_despacho (OPTIONAL, grupo ventas): pedidos de salón que arma el
--     vendedor y cobra la caja, con reserva de stock por minutos, y la cola de
--     expedición (armado, listo, entregado o despachado) con retiro en
--     sucursal, envío a domicilio y retiro en otra sucursal.
--     Pro, Business y Enterprise: mismo corte que reservas_stock (ADR-091) y
--     presupuestos (ADR-122); un local con salón y caja separados ya lo usa.
--
-- El gating real vive en las RPC y el trigger de 20261123100100
-- (tenant_has_feature_for). La UI es sólo cortesía.
-- Idempotente: sólo escribe la key en los planes globales que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('pedidos_despacho', 'Pedidos de salón y expedición',
   'El vendedor arma el pedido con stock reservado por minutos, la caja lo levanta y lo cobra, y expedición lo arma y lo entrega o despacha (retiro en el momento, retiro en sucursal con código, envío a domicilio y retiro en otra sucursal)',
   'ventas', false, 56)
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
    || jsonb_build_object('pedidos_despacho', (p.key in ('pro', 'business', 'enterprise'))),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'pedidos_despacho');
