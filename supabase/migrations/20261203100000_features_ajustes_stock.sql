-- =============================================================================
-- 20261203100000_features_ajustes_stock  (ADR-137 · F14 · H64, H34)
--
-- Dos keys nuevas (convención CLAUDE.md §6):
--
--  * ajustes_stock        BASE · todos los planes.
--      Ajustes de stock con motivo obligatorio (rotura, vencimiento, robo,
--      error de carga, conteo...), por sucursal o depósito, con foto de
--      respaldo opcional e historial de quién lo pidió. Es la forma ordenada
--      de lo que el dueño ya podía hacer (adjust_store_stock es BASE): no se
--      cobra aparte.
--  * aprobacion_ajustes   OPTIONAL · Pro, Business y Enterprise.
--      Los ajustes desde un umbral (unidades o pesos al costo) quedan
--      pendientes hasta que los aprueba el dueño o un auditor (capacidad
--      stock.adjust.approve). Es control interno de Inventario PRO: el mismo
--      nivel que el conteo cíclico.
--
-- Gating real en el servidor (no sólo la UI): stock_adjustment_request,
-- stock_adjustment_decide y stock_adjustment_policy_save (20261203100100)
-- exigen tenant_has_feature_for(tenant, key).
--
-- Idempotente: sólo escribe las keys en los planes globales que no las tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('ajustes_stock', 'Ajustes de stock con motivo',
   'Sumar, restar o fijar stock por sucursal o depósito con motivo obligatorio, foto de respaldo opcional e historial de quién lo hizo',
   'catalogo', true, 71),
  ('aprobacion_ajustes', 'Aprobación de ajustes de stock',
   'Los ajustes desde un umbral de unidades o de pesos quedan pendientes hasta que los aprueba el dueño o un auditor, con todo el circuito auditado',
   'catalogo', false, 77)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = excluded.is_basic;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  -- Lo ya declarado gana: sólo se completan las keys que faltan.
  jsonb_build_object(
    'ajustes_stock', true,
    'aprobacion_ajustes', (p.key in ('pro', 'business', 'enterprise'))
  ) || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'ajustes_stock'
           and coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'aprobacion_ajustes');
-- Planes a medida: no se declaran (ajustes_stock cae al fallback is_basic;
-- aprobacion_ajustes queda apagada hasta que se marque en el editor).
