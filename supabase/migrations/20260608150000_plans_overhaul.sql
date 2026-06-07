-- =============================================================================
-- 20260608150000_plans_overhaul  (SAAS — fundación del rediseño de planes)
--
-- Keystone del overhaul de planes SaaS. Una sola migración, idempotente,
-- aplicada en remoto vía MCP. Estilo de policies "interno" (lectura pública /
-- escritura solo staff) salvo donde la data es secreta (email_providers).
--
-- A) features: extiende el catálogo con los módulos granulares que el creador de
--    planes necesita (efectivo, transferencia, modo, categorias, promociones,
--    descuentos, roles_permisos, facturacion_afip, metricas_avanzadas,
--    auditoria, backup, soporte_prioritario, personalizacion_marca, panel_dueno).
--    Inserta on conflict do nothing: las filas existentes quedan intactas.
-- B) plans: columnas nuevas del rediseño (secondary_name "nombre ninja",
--    image_url, is_recommended).
-- C) seed de los 4 planes globales (start/pro/business/enterprise): nombres,
--    nombres ninja, precios ARS, trial, sort, recomendado, icono y limits jsonb
--    {limits, modules<feature_key>:bool, support} con la matriz definitiva.
-- D) subscription_addons: campos de cobro separado (período, precio, provider).
-- E) email_providers: tabla de proveedores de email (Resend + failover dual),
--    deny-all RLS (solo service_role) + RPC get_email_providers() sin secretos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo de features — extensión granular (idempotente, conserva filas).
--    sort incremental dentro de cada grupo, sin pisar los existentes.
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  -- grupo ventas (existentes llegan hasta sort 50)
  ('promociones',          'Promociones',            'Promociones y combos',                       'ventas',        false, 60),
  ('descuentos',           'Descuentos',             'Descuentos manuales en venta',               'ventas',        false, 70),
  -- grupo pagos (nuevo): efectivo y transferencia son básicos; mobbex se reubica
  ('efectivo',             'Efectivo',               'Cobro en efectivo',                          'pagos',         true,  10),
  ('transferencia',        'Transferencia',          'Cobro por transferencia bancaria',           'pagos',         true,  20),
  ('modo',                 'MODO',                   'Cobros con MODO',                            'pagos',         false, 30),
  ('mobbex',               'Mobbex',                 'Cobros con Mobbex',                           'pagos',         false, 40),
  -- grupo catalogo (existentes llegan hasta sort 110)
  ('categorias',           'Categorías',             'Categorías de productos',                    'catalogo',      true,  120),
  -- grupo clientes (existentes llegan hasta sort 130)
  ('roles_permisos',       'Roles y permisos',       'Roles y permisos de usuarios',               'clientes',      false, 140),
  -- grupo integraciones
  ('facturacion_afip',     'Facturación AFIP',       'Facturación electrónica AFIP/ARCA',          'integraciones', false, 220),
  -- grupo reportes (existentes llegan hasta sort 170)
  ('metricas_avanzadas',   'Métricas avanzadas',     'Dashboards y métricas avanzadas',            'reportes',      false, 180),
  -- grupo extras (existentes llegan hasta sort 230)
  ('auditoria',            'Auditoría',              'Registro de auditoría de acciones',          'extras',        false, 240),
  ('backup',               'Backups',                'Copias de seguridad de datos',               'extras',        false, 250),
  ('soporte_prioritario',  'Soporte prioritario',    'Soporte prioritario y SLA reducido',         'extras',        false, 260),
  ('personalizacion_marca','Personalización de marca','Logo, colores y branding del comercio',      'extras',        false, 270),
  ('panel_dueno',          'Panel del dueño',        'Panel exclusivo del dueño del comercio',     'extras',        false, 280)
on conflict (key) do nothing;

-- Reubica mobbex al grupo pagos (la fila ya existía en 'integraciones').
update features
   set grupo = 'pagos', sort = 40
 where key = 'mobbex' and grupo <> 'pagos';

-- -----------------------------------------------------------------------------
-- B) Columnas nuevas de plans para el rediseño (icon/trial_days/sort ya existen).
-- -----------------------------------------------------------------------------
alter table plans add column if not exists secondary_name text;
alter table plans add column if not exists image_url text;
alter table plans add column if not exists is_recommended boolean not null default false;

-- -----------------------------------------------------------------------------
-- C) Seed de los 4 planes globales (UPDATE por key: ya existen).
--    limits = { limits:{...}, modules:{<feature_key>:bool}, support:{level} }.
--    null en limits.limits => se OMITE la key para que el gating lea ilimitado.
-- -----------------------------------------------------------------------------

-- START — "Aprendiz" · 60.000 ARS · trial 14 · sort 1 · icon Sprout
update plans set
  name           = 'Start',
  secondary_name = 'Aprendiz',
  monthly_price_ars = 60000,
  trial_days     = 14,
  sort           = 1,
  is_recommended = false,
  icon           = 'Sprout',
  limits = jsonb_build_object(
    'limits', jsonb_build_object(
      'max_stores', 1,
      'max_users', 2,
      'max_products', 500,
      'max_sales_per_month', 1000
    ),
    'modules', jsonb_build_object(
      'pos', true,
      'caja', true,
      'productos', true,
      'categorias', true,
      'stock', true,
      'clientes', true,
      'reportes', true,
      'notificaciones', true,
      'efectivo', true,
      'transferencia', true,
      'email_comprobantes', true,
      'devoluciones', false,
      'tickets_pro', false,
      'mercado_pago', false,
      'catalogo_publico', false,
      'importacion_excel', false,
      'variantes', false,
      'grupos_clientes', false,
      'promociones', false,
      'descuentos', false,
      'personalizacion_marca', false,
      'panel_dueno', false,
      'facturacion_afip', false,
      'export_xlsx', false,
      'modo', false,
      'mobbex', false,
      'listas_precios', false,
      'cuenta_corriente', false,
      'garantias', false,
      'multi_sucursal', false,
      'roles_permisos', false,
      'metricas_avanzadas', false,
      'auditoria', false,
      'soporte_prioritario', false,
      'backup', false,
      'api_publica', false,
      'asistente_ia', false
    ),
    'support', jsonb_build_object('level', 'email')
  )
where key = 'start' and tenant_id is null;

-- PRO — "Discípulo" · 90.000 ARS · trial 14 · sort 2 · icon Swords · RECOMENDADO
update plans set
  name           = 'Pro',
  secondary_name = 'Discípulo',
  monthly_price_ars = 90000,
  trial_days     = 14,
  sort           = 2,
  is_recommended = true,
  icon           = 'Swords',
  limits = jsonb_build_object(
    'limits', jsonb_build_object(
      'max_stores', 1,
      'max_users', 5,
      'max_products', 5000
      -- max_sales_per_month null => omitido (ilimitado)
    ),
    'modules', jsonb_build_object(
      'pos', true,
      'caja', true,
      'productos', true,
      'categorias', true,
      'stock', true,
      'clientes', true,
      'reportes', true,
      'notificaciones', true,
      'efectivo', true,
      'transferencia', true,
      'email_comprobantes', true,
      'devoluciones', true,
      'tickets_pro', true,
      'mercado_pago', true,
      'catalogo_publico', true,
      'importacion_excel', true,
      'variantes', true,
      'grupos_clientes', true,
      'promociones', true,
      'descuentos', true,
      'personalizacion_marca', true,
      'panel_dueno', true,
      'facturacion_afip', true,
      'export_xlsx', true,
      'modo', false,
      'mobbex', false,
      'listas_precios', false,
      'cuenta_corriente', false,
      'garantias', false,
      'multi_sucursal', false,
      'roles_permisos', false,
      'metricas_avanzadas', false,
      'auditoria', false,
      'soporte_prioritario', false,
      'backup', false,
      'api_publica', false,
      'asistente_ia', false
    ),
    'support', jsonb_build_object('level', 'email')
  )
where key = 'pro' and tenant_id is null;

-- BUSINESS — "Maestro" · 140.000 ARS · trial 14 · sort 3 · icon Crown
update plans set
  name           = 'Business',
  secondary_name = 'Maestro',
  monthly_price_ars = 140000,
  trial_days     = 14,
  sort           = 3,
  is_recommended = false,
  icon           = 'Crown',
  limits = jsonb_build_object(
    'limits', jsonb_build_object(
      'max_stores', 3,
      'max_users', 15
      -- max_products null => omitido (ilimitado)
      -- max_sales_per_month null => omitido (ilimitado)
    ),
    'modules', jsonb_build_object(
      'pos', true,
      'caja', true,
      'productos', true,
      'categorias', true,
      'stock', true,
      'clientes', true,
      'reportes', true,
      'notificaciones', true,
      'efectivo', true,
      'transferencia', true,
      'email_comprobantes', true,
      'devoluciones', true,
      'tickets_pro', true,
      'mercado_pago', true,
      'catalogo_publico', true,
      'importacion_excel', true,
      'variantes', true,
      'grupos_clientes', true,
      'promociones', true,
      'descuentos', true,
      'personalizacion_marca', true,
      'panel_dueno', true,
      'facturacion_afip', true,
      'export_xlsx', true,
      'modo', true,
      'mobbex', true,
      'listas_precios', true,
      'cuenta_corriente', true,
      'garantias', true,
      'multi_sucursal', true,
      'roles_permisos', true,
      'metricas_avanzadas', true,
      'auditoria', true,
      'soporte_prioritario', true,
      'backup', false,
      'api_publica', false,
      'asistente_ia', false
    ),
    'support', jsonb_build_object('level', 'priority')
  )
where key = 'business' and tenant_id is null;

-- ENTERPRISE — "Sensei" · 220.000 ARS · trial 0 · sort 4 · icon Gem
update plans set
  name           = 'Enterprise',
  secondary_name = 'Sensei',
  monthly_price_ars = 220000,
  trial_days     = 0,
  sort           = 4,
  is_recommended = false,
  icon           = 'Gem',
  limits = jsonb_build_object(
    'limits', jsonb_build_object(),  -- todo ilimitado => objeto vacío
    'modules', jsonb_build_object(
      'pos', true,
      'caja', true,
      'productos', true,
      'categorias', true,
      'stock', true,
      'clientes', true,
      'reportes', true,
      'notificaciones', true,
      'efectivo', true,
      'transferencia', true,
      'email_comprobantes', true,
      'devoluciones', true,
      'tickets_pro', true,
      'mercado_pago', true,
      'catalogo_publico', true,
      'importacion_excel', true,
      'variantes', true,
      'grupos_clientes', true,
      'promociones', true,
      'descuentos', true,
      'personalizacion_marca', true,
      'panel_dueno', true,
      'facturacion_afip', true,
      'export_xlsx', true,
      'modo', true,
      'mobbex', true,
      'listas_precios', true,
      'cuenta_corriente', true,
      'garantias', true,
      'multi_sucursal', true,
      'roles_permisos', true,
      'metricas_avanzadas', true,
      'auditoria', true,
      'soporte_prioritario', true,
      'backup', true,
      'api_publica', true,
      'asistente_ia', false  -- IA siempre addon, nunca incluida en plan
    ),
    'support', jsonb_build_object('level', 'dedicated')
  )
where key = 'enterprise' and tenant_id is null;

-- -----------------------------------------------------------------------------
-- D) subscription_addons — campos de cobro separado (idempotente).
-- -----------------------------------------------------------------------------
alter table subscription_addons add column if not exists current_period_start date;
alter table subscription_addons add column if not exists current_period_end   date;
alter table subscription_addons add column if not exists monthly_price_ars     numeric(12,2);
alter table subscription_addons add column if not exists provider              text default null;

-- -----------------------------------------------------------------------------
-- E) email_providers — Resend + failover dual (hasta 2 slots).
--    La clave/credenciales son secretas: RLS sin policies => solo service_role
--    (mismo criterio que system_email_smtp). get_email_providers() expone la
--    config SIN secretos para el formulario interno.
-- -----------------------------------------------------------------------------
create table if not exists email_providers (
  slot        int primary key check (slot in (1, 2)),
  kind        text not null default 'resend' check (kind in ('resend','smtp')),
  is_active   boolean not null default false,
  api_key     text,
  smtp_host   text,
  smtp_port   int,
  smtp_secure boolean,
  smtp_user   text,
  smtp_pass   text,
  from_name   text not null default 'NinjaPos',
  from_email  text,
  updated_at  timestamptz not null default now()
);

-- Dos slots vacíos (1 = principal, 2 = failover).
insert into email_providers (slot, kind) values
  (1, 'resend'),
  (2, 'resend')
on conflict (slot) do nothing;

drop trigger if exists set_updated_at_email_providers on email_providers;
create trigger set_updated_at_email_providers
  before update on email_providers
  for each row execute function set_updated_at();

alter table email_providers enable row level security;  -- sin policies: solo service_role

-- get_email_providers(): config de ambos slots SIN secretos (api_key/smtp_pass).
create or replace function get_email_providers()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when not is_internal() then null else (
    select coalesce(
      jsonb_object_agg(
        ep.slot::text,
        jsonb_build_object(
          'kind', ep.kind,
          'is_active', ep.is_active,
          'from_name', ep.from_name,
          'from_email', ep.from_email,
          'has_key', (ep.api_key is not null and ep.api_key <> ''),
          'smtp_host', ep.smtp_host,
          'smtp_port', ep.smtp_port,
          'smtp_secure', ep.smtp_secure,
          'smtp_user', ep.smtp_user,
          'has_smtp_pass', (ep.smtp_pass is not null and ep.smtp_pass <> '')
        )
      ),
      '{}'::jsonb
    )
    from email_providers ep
  ) end;
$$;
revoke all on function get_email_providers() from public, anon;
grant execute on function get_email_providers() to authenticated;
