-- =============================================================================
-- 20261110300000_features_envios  (Envíos y logística, fase 1 · ADR-103)
--
-- Features de plan nuevas (convención CLAUDE.md §6):
--   • envios (OPTIONAL, grupo envios): módulo de envíos con etiquetas de
--     logísticas integradas (cotizar, crear, etiqueta, seguimiento, cancelar).
--     Pro, Business y Enterprise.
--   • Una key por carrier, igual a shipping_providers.key (como los medios de
--     pago con payment_providers.key): andreani, correo_argentino y oca en Pro,
--     Business y Enterprise; enviopack (agregador) en Business y Enterprise.
--     Correo Argentino, OCA y Envíopack son esqueletos en esta fase (la UI los
--     muestra como "próximamente" y el servidor rechaza operar con ellos hasta
--     que exista el adaptador): por ahora su key sólo reserva el nivel
--     comercial (MARKETING-FUTURO, deuda en ADR-103).
--   • El simulador no tiene key propia: lo habilita `envios` (como el efectivo
--     en pagos, que no depende de un proveedor).
--
-- El gating real vive en 20261110300200 (shipment_create y las demás RPC con
-- tenant_has_feature_for(tenant, 'envios') y la key del carrier) y en la Edge
-- `shipping` (shipping_access_check). La UI es cortesía.
-- Los planes a medida no la reciben: el equipo comercial la prende a mano.
-- Idempotente: sólo escribe la key en los planes que no la tienen.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('envios', 'Envíos y logística',
   'Envíos con etiquetas de logísticas integradas: cotizar entre carriers, crear el envío desde una venta o a mano, imprimir la etiqueta y seguir el estado',
   'envios', false, 300),
  ('andreani', 'Andreani',
   'Envíos con tu contrato de Andreani: cotización, alta, etiqueta PDF, sucursales y seguimiento',
   'envios', false, 301),
  ('correo_argentino', 'Correo Argentino',
   'Envíos con tu cuenta de Correo Argentino (MiCorreo o PAQ.AR). Próximamente',
   'envios', false, 302),
  ('oca', 'OCA',
   'Envíos con tu cuenta e-Pak de OCA. Próximamente',
   'envios', false, 303),
  ('enviopack', 'Envíopack (agregador)',
   'Varios carriers con una sola cuenta de Envíopack. Próximamente',
   'envios', false, 304)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      grupo = excluded.grupo,
      is_basic = false;

-- Planes globales: Pro+ para el módulo y los carriers nativos; Business+ para
-- el agregador. Lo ya declarado gana.
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  jsonb_build_object(
    'envios',           (p.key in ('pro', 'business', 'enterprise')),
    'andreani',         (p.key in ('pro', 'business', 'enterprise')),
    'correo_argentino', (p.key in ('pro', 'business', 'enterprise')),
    'oca',              (p.key in ('pro', 'business', 'enterprise')),
    'enviopack',        (p.key in ('business', 'enterprise'))
  ) || coalesce(p.limits -> 'modules', '{}'::jsonb),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise');
