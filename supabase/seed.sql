-- =============================================================================
-- seed.sql — datos base del SaaS (idempotente). Ejecutar tras las migraciones.
-- NOTA: monthly_price_ars/yearly_price_ars están en 0 como PLACEHOLDER.
--       Los precios comerciales reales se definen fuera de docs (ver
--       docs/16-subscription-model.md §1) y deben cargarse antes de producción.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Planes. `limits` consolida limits + modules + support (ver docs/16 §4).
-- -----------------------------------------------------------------------------
insert into plans (key, name, description, monthly_price_ars, yearly_price_ars, limits, is_active) values
('start', 'Start', 'Plan de entrada: 1 sucursal, POS básico.', 0, 0,
  '{"limits":{"max_stores":1,"max_users":3,"max_products":5000,"max_sales_per_month":10000},
    "modules":{"pos":true,"afip_integration":false,"multi_branch":false,"advanced_promotions":false,"api_access":false},
    "support":{"level":"email","response_sla_hours":48}}'::jsonb, true),
('pro', 'Pro', 'Hasta 3 sucursales, AFIP y multi-caja.', 0, 0,
  '{"limits":{"max_stores":3,"max_users":10,"max_products":20000,"max_sales_per_month":50000},
    "modules":{"pos":true,"afip_integration":true,"multi_branch":true,"advanced_promotions":false,"api_access":false},
    "support":{"level":"email_chat","response_sla_hours":24}}'::jsonb, true),
('business', 'Business', 'Hasta 10 sucursales, promociones avanzadas.', 0, 0,
  '{"limits":{"max_stores":10,"max_users":30,"max_products":100000,"max_sales_per_month":200000},
    "modules":{"pos":true,"afip_integration":true,"multi_branch":true,"advanced_promotions":true,"api_access":false},
    "support":{"level":"priority","response_sla_hours":8}}'::jsonb, true),
('enterprise', 'Enterprise', 'A medida: sucursales/usuarios ilimitados, API pública.', 0, 0,
  '{"limits":{"max_stores":null,"max_users":null,"max_products":null,"max_sales_per_month":null},
    "modules":{"pos":true,"afip_integration":true,"multi_branch":true,"advanced_promotions":true,"api_access":true},
    "support":{"level":"dedicated","response_sla_hours":4}}'::jsonb, true)
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  limits = excluded.limits,
  is_active = excluded.is_active;

-- -----------------------------------------------------------------------------
-- Catálogo de feature flags (ver docs/07-feature-flags.md §4).
-- La estrategia de rollout se anota en la descripción (la tabla actual no tiene
-- columna rollout_strategy; ver nota de drift en docs/04-database.md).
-- -----------------------------------------------------------------------------
insert into feature_flags (key, description, default_enabled) values
('afip_enabled',             '[per_tenant] Facturación electrónica AFIP.', false),
('multi_branch',             '[per_plan] Múltiples sucursales (Business+).', false),
('advanced_promotions',      '[per_plan] Motor de promociones (Pro+).', false),
('restaurant_mode',          '[per_tenant] Flujos de mesas/comandas.', false),
('mercadopago_integration',  '[per_tenant] Cobros con MP Point.', false),
('whatsapp_notifications',   '[per_plan] Notificaciones por WhatsApp (Business+).', false),
('customer_credit',          '[per_plan] Cuenta corriente de clientes (Pro+).', false),
('customer_loyalty',         '[per_plan] Programa de fidelidad (Business+).', false),
('api_access',               '[per_plan] API pública (Enterprise).', false),
('pin_for_voids',            '[all] PIN de manager para anulaciones.', true),
('auto_print_ticket',        '[per_tenant] Imprimir ticket automáticamente al cerrar venta.', true),
('negative_stock_warning',   '[all] Avisar al vender producto sin stock.', true),
('force_customer_on_sale',   '[per_tenant] Obligar a asignar cliente a cada venta.', false),
('dark_mode_only',           '[per_tenant] Forzar modo oscuro.', false)
on conflict (key) do update set
  description = excluded.description,
  default_enabled = excluded.default_enabled;
