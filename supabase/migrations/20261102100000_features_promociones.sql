-- =============================================================================
-- 20261102100000_features_promociones  (F9 · H53-H56, ADR-074)
--
-- `promociones` deja de ser MARKETING-FUTURO y pasa a OPTIONAL real (convención
-- CLAUDE.md §6): motor de promociones con cálculo autoritativo en create_sale.
--
--   • Categoría: OPTIONAL (is_basic=false, grupo ventas), desde Pro. Start no
--     la trae: es una herramienta comercial (campañas, combos, bancos) que
--     paga quien tiene volumen para aprovecharla.
--   • Gating real (migraciones siguientes): la policy de escritura de
--     `promotions` exige tenant_has_feature_for(tenant, 'promociones');
--     _promo_evaluate devuelve "sin promos" sin la feature, así create_sale no
--     descuenta nada aunque el POS lo pida (y rechaza el pedido con
--     feature_not_in_plan); promotion_preview y promotion_usage también la
--     exigen. La UI (Configuración → Promociones y el carrito del POS) es sólo
--     cortesía.
--   • Los cupones (`coupons`) siguen como estaban: no dependen de esta key.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('promociones', 'Promociones',
   'Motor de promociones: 2x1 y NxM, segunda unidad al %, escalas por cantidad, combos a precio fijo, descuentos por medio de pago, tarjeta o banco con días y horarios, por categoría, marca, producto, lista o sucursal, con topes y combinables. El POS las aplica solas y el ticket muestra cada una',
   'ventas', false, 60)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

-- Planes globales: Pro, Business y Enterprise sí; Start no. Sólo se agrega la
-- clave donde falta (los planes ya la traían desde 20260608150000).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb)
    || jsonb_build_object('promociones', (p.key in ('pro', 'business', 'enterprise'))), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'promociones');

-- Planes a medida: no se tocan (se activa desde el editor de planes o como add-on).
