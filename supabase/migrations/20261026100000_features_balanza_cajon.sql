-- =============================================================================
-- 20261026100000_features_balanza_cajon  (ADR-063)
--
-- Features de plan (convención CLAUDE.md §6) para el hardware de mostrador:
--
--   • `balanza` · BASE (is_basic=true, grupo pos). Productos pesables con
--     balanza: códigos de barra de balanza (EAN-13 con prefijo 20 a 29 y
--     precio o peso embebido) y lectura del peso en vivo por Web Serial o el
--     puente local. Cualquier verdulería, carnicería o fiambrería lo necesita
--     para vender: es parte de pagar cualquier plan.
--   • `cajon_dinero` · BASE (is_basic=true, grupo pos). Apertura del cajón de
--     dinero por pulso ESC/POS de la impresora de la caja, al cobrar en
--     efectivo y "sin venta" con la política de la sucursal (permitido, con
--     PIN de supervisor o prohibido), cada apertura auditada.
--
--   Gating real (migración siguiente): pos_settings y config_overrides no
--   dejan prender la balanza ni tocar la política del cajón sin la feature,
--   register_hardware_set valida cada feature por la parte que escribe y
--   cash_drawer_open exige `cajon_dinero`. Como son BASE, sólo un apagado
--   explícito (`modules[key] = false`) en un plan a medida las corta.
-- =============================================================================

insert into features (key, label, description, grupo, is_basic, sort) values
  ('balanza', 'Balanza y códigos pesables',
   'Productos pesables: códigos de barra de balanza con precio o peso embebido y lectura del peso en vivo desde la balanza de la caja',
   'pos', true, 62),
  ('cajon_dinero', 'Cajón de dinero',
   'Apertura del cajón por la impresora de la caja al cobrar en efectivo y sin venta (permitida, con PIN o prohibida), con auditoría de cada apertura',
   'pos', true, 63)
on conflict (key) do nothing;

-- Planes globales: en todos (BASE).
update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('balanza', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'balanza');

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb), '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('cajon_dinero', true), true)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'cajon_dinero');

-- Planes a medida: no se tocan. Una feature BASE entra por defecto en todo
-- plan salvo apagado explícito (tenant_has_feature_for con is_basic).
