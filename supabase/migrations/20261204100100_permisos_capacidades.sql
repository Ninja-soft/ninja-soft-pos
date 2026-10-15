-- =============================================================================
-- 20261204100100_permisos_capacidades  (ADR-138, parte A)
--
-- Permisos por capacidad sobre los roles de hoy, SIN cambiar lo que puede hacer
-- nadie con un rol de sistema.
--
--   A) Catálogo de capacidades (permission_capabilities). Fuente única en
--      lib/permissions/capabilities.ts; tests/unit/permissionsCatalog.test.ts
--      compara este seed con el código.
--   B) Roles: de sistema (tenant_id null, uuid fijo, no se borran) y
--      personalizados por negocio. tenant_users.role sigue siendo el NIVEL BASE
--      (owner, manager, cashier, viewer) que usan las guardas que todavía son
--      por rol; tenant_users.role_id apunta al rol con capacidades (null = el
--      rol de sistema de su nivel). Igual por sucursal en
--      staff_branch_assignments (role + role_id). Permisos puntuales por
--      persona en permission_user_overrides.
--   C) Resolución: capabilities_for(negocio, usuario, sucursal) con caché por
--      transacción (set_config local) para los triggers por fila;
--      has_capability(cap) / has_capability_at(cap, sucursal) /
--      member_has_capability(negocio, cap) para RPC y triggers, siempre como
--      (select has_capability('...')) en policies (initplan).
--   D) Enforcement en las acciones críticas, con el mismo resultado que hoy
--      para los roles de sistema:
--        · trg_role_write_guard: catálogo, precios, stock y clientes por
--          capacidad (antes: "cajero no"); vender, anular, devolver, abrir y
--          cerrar caja, ingresos y retiros también dentro de RPC.
--        · void_sale (anular; días anteriores por sucursal), adjust_store_stock,
--          price_can_write / price_pro_can_write, purchase_can_write,
--          treasury_can_write, tax_can_write, acc_assert, _margin_assert
--          (costos y márgenes), _cycle_assert (conteos).
--        · pos_settings (configuración) y audit_logs (ver la auditoría).
--
-- Nunca "OR is_internal()" (ADR-052). Sin la feature roles_permisos los roles
-- personalizados caen a su nivel base y los permisos puntuales no cuentan,
-- salvo los de capacidades con grant_feature prendida en el plan.
--
-- Modelo ÚNICO (unificación con ADR-137): las capacidades de Inventario
-- (stock.view, .valuation, .export, .adjust, .count, .import, .adjust.approve,
-- .settings) viven en este catálogo con sus defaults por rol de sistema; sus
-- RPC (20261204100300_ajustes_stock_aprobacion) preguntan has_capability /
-- member_has_capability de acá. No hay otra tabla de capacidades.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Catálogo
-- -----------------------------------------------------------------------------
create table if not exists permission_capabilities (
  key          text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module       text not null,
  label        text not null check (char_length(label) between 1 and 80),
  description  text not null check (char_length(description) between 1 and 300),
  level        text not null check (level in ('view', 'operate', 'admin')),
  risk         text not null check (risk in ('low', 'medium', 'high', 'critical')),
  depends_on   text[] not null default '{}',
  -- Clausura transitiva de depends_on (la calcula el código al generar el seed).
  requires_all text[] not null default '{}',
  min_base     text not null default 'cashier' check (min_base in ('viewer', 'cashier', 'manager', 'owner')),
  enforced     text not null default 'server' check (enforced in ('server', 'ui')),
  -- Feature del plan con la que el dueño puede dar o quitar esta capacidad a
  -- una persona (permiso puntual) aunque el plan no tenga roles_permisos: las
  -- "otorgables" de Inventario (ADR-137). null = sólo con roles_permisos.
  grant_feature text,
  sort         int not null default 0,
  updated_at   timestamptz not null default now()
);

alter table permission_capabilities enable row level security;
drop policy if exists permission_capabilities_select on permission_capabilities;
create policy permission_capabilities_select on permission_capabilities
  for select to authenticated using (true);
revoke insert, update, delete on permission_capabilities from anon, authenticated;

-- -----------------------------------------------------------------------------
-- B) Roles, capacidades por rol y permisos puntuales
-- -----------------------------------------------------------------------------
create table if not exists permission_roles (
  id            uuid primary key default gen_random_uuid(),
  -- null = rol de sistema (igual para todos los negocios, no se edita ni borra).
  tenant_id     uuid references tenants(id) on delete cascade,
  key           text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  name          text not null check (char_length(btrim(name)) between 1 and 40),
  description   text check (description is null or char_length(description) <= 200),
  color         text not null default 'slate'
                  check (color in ('flame', 'gold', 'green', 'blue', 'violet', 'pink', 'teal', 'slate')),
  icon          text not null default 'user'
                  check (icon in ('crown', 'shield', 'store', 'eye', 'tag', 'search', 'user', 'wrench', 'truck', 'calculator')),
  base_role     text not null check (base_role in ('owner', 'manager', 'cashier', 'viewer')),
  template_key  text,
  sort          int not null default 100,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- Un rol personalizado nunca es de nivel dueño.
  constraint permission_roles_custom_base_chk check (tenant_id is null or base_role <> 'owner')
);

create unique index if not exists permission_roles_system_key_uq
  on permission_roles (key) where tenant_id is null;
create unique index if not exists permission_roles_tenant_key_uq
  on permission_roles (tenant_id, key) where tenant_id is not null and deleted_at is null;
create unique index if not exists permission_roles_tenant_name_uq
  on permission_roles (tenant_id, lower(btrim(name))) where tenant_id is not null and deleted_at is null;
create index if not exists permission_roles_tenant_idx
  on permission_roles (tenant_id, sort) where tenant_id is not null;

drop trigger if exists set_updated_at_permission_roles on permission_roles;
create trigger set_updated_at_permission_roles
  before update on permission_roles
  for each row execute function set_updated_at();

create table if not exists permission_role_capabilities (
  role_id    uuid not null references permission_roles(id) on delete cascade,
  capability text not null references permission_capabilities(key) on update cascade on delete cascade,
  -- Copia del negocio del rol (null en los de sistema) para la RLS sin join.
  tenant_id  uuid references tenants(id) on delete cascade,
  primary key (role_id, capability)
);
create index if not exists permission_role_capabilities_cap_idx on permission_role_capabilities (capability);
create index if not exists permission_role_capabilities_tenant_idx
  on permission_role_capabilities (tenant_id) where tenant_id is not null;

create table if not exists permission_user_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  capability  text not null references permission_capabilities(key) on update cascade on delete cascade,
  effect      text not null check (effect in ('grant', 'revoke')),
  reason      text check (reason is null or char_length(reason) <= 300),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id, capability)
);
create index if not exists permission_user_overrides_user_idx on permission_user_overrides (user_id);
create index if not exists permission_user_overrides_cap_idx on permission_user_overrides (capability);

alter table tenant_users add column if not exists role_id uuid references permission_roles(id);
create index if not exists tenant_users_role_id_idx on tenant_users (role_id) where role_id is not null;

alter table staff_branch_assignments add column if not exists role_id uuid references permission_roles(id);
create index if not exists staff_branch_role_id_idx on staff_branch_assignments (role_id) where role_id is not null;

-- RLS: lectura del negocio (los de sistema, todos); escritura sólo por RPC.
alter table permission_roles enable row level security;
drop policy if exists permission_roles_select on permission_roles;
create policy permission_roles_select on permission_roles
  for select to authenticated
  using (tenant_id is null or tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on permission_roles from anon, authenticated;

alter table permission_role_capabilities enable row level security;
drop policy if exists permission_role_capabilities_select on permission_role_capabilities;
create policy permission_role_capabilities_select on permission_role_capabilities
  for select to authenticated
  using (tenant_id is null or tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on permission_role_capabilities from anon, authenticated;

alter table permission_user_overrides enable row level security;
drop policy if exists permission_user_overrides_select on permission_user_overrides;
create policy permission_user_overrides_select on permission_user_overrides
  for select to authenticated
  using (tenant_id = (select current_tenant_id()) or (select internal_scope()));
revoke insert, update, delete on permission_user_overrides from anon, authenticated;

-- Seed generado desde lib/permissions/capabilities.ts (no editar a mano).
-- @@SEED-INICIO@@
insert into permission_capabilities (key, module, label, description, level, risk, depends_on, requires_all, min_base, enforced, grant_feature, sort) values
  ('sales.view', 'ventas', 'Ver ventas', 'Ver el listado y el detalle de las ventas de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 10),
  ('sales.create', 'ventas', 'Vender y cobrar', 'Cobrar ventas en el POS dentro de su turno de caja.', 'operate', 'medium', array['sales.view', 'products.view']::text[], array['products.view', 'sales.view']::text[], 'cashier', 'server', null, 20),
  ('sales.void', 'ventas', 'Anular ventas del día', 'Anular una venta de hoy: vuelve el stock y sale la plata de la caja.', 'operate', 'high', array['sales.view']::text[], array['sales.view']::text[], 'cashier', 'server', null, 30),
  ('sales.void.past_days', 'ventas', 'Anular ventas de días anteriores', 'Anular ventas de otros días (hora de Argentina). Toca cierres ya hechos.', 'admin', 'critical', array['sales.void']::text[], array['sales.view', 'sales.void']::text[], 'cashier', 'server', null, 40),
  ('sales.return', 'ventas', 'Devoluciones y cambios', 'Registrar devoluciones, cambios y reintegros de una venta.', 'operate', 'high', array['sales.view']::text[], array['sales.view']::text[], 'cashier', 'server', null, 50),
  ('cash.view', 'caja', 'Ver cajas y turnos', 'Ver las cajas, los turnos y los cierres de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 60),
  ('cash.open', 'caja', 'Abrir turno de caja', 'Abrir su propio turno en una caja de su sucursal.', 'operate', 'medium', array['cash.view']::text[], array['cash.view']::text[], 'cashier', 'server', null, 70),
  ('cash.close', 'caja', 'Cerrar turno de caja', 'Cerrar su turno con el arqueo y el cierre Z.', 'operate', 'medium', array['cash.open']::text[], array['cash.open', 'cash.view']::text[], 'cashier', 'server', null, 80),
  ('cash.movements', 'caja', 'Ingresos y retiros de caja', 'Cargar ingresos y retiros de plata en su turno.', 'operate', 'high', array['cash.open']::text[], array['cash.open', 'cash.view']::text[], 'cashier', 'server', null, 90),
  ('products.view', 'productos', 'Ver productos y precios', 'Ver el catálogo, las variantes y los precios.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 100),
  ('products.edit', 'productos', 'Crear y editar productos', 'Alta, edición y baja de productos, variantes, categorías y marcas.', 'admin', 'medium', array['products.view']::text[], array['products.view']::text[], 'cashier', 'server', null, 110),
  ('products.price', 'productos', 'Cambiar precios y costos', 'Cambiar el precio de venta y el costo de un producto.', 'admin', 'high', array['products.edit']::text[], array['products.edit', 'products.view']::text[], 'cashier', 'server', null, 120),
  ('prices.manage', 'productos', 'Listas de precios y cambios masivos', 'Listas de precios, escalas, condiciones de pago y aumentos masivos.', 'admin', 'high', array['products.price']::text[], array['products.edit', 'products.price', 'products.view']::text[], 'cashier', 'server', null, 130),
  ('stock.view', 'stock', 'Ver stock e inventario', 'Stock por sucursal y depósito, movimientos e historial de ajustes.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 140),
  ('stock.valuation', 'stock', 'Ver costos y valuación del stock', 'Costo de cada producto, valor del stock y valor de cada ajuste.', 'admin', 'medium', array['stock.view']::text[], array['stock.view']::text[], 'viewer', 'server', 'ajustes_stock', 150),
  ('stock.export', 'stock', 'Exportar planillas de stock', 'Descargar el stock en Excel y la planilla para contar.', 'operate', 'low', array['stock.view']::text[], array['stock.view']::text[], 'viewer', 'ui', 'ajustes_stock', 160),
  ('stock.adjust', 'stock', 'Ajustar stock a mano', 'Sumar, restar o fijar stock con motivo, mermas y producción. Desde el umbral, queda pendiente de aprobación.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'ajustes_stock', 170),
  ('stock.count', 'stock', 'Contar stock', 'Conteos cíclicos y ajustes con motivo Conteo (inventario físico), aunque no pueda hacer otros ajustes.', 'operate', 'medium', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'ajustes_stock', 180),
  ('stock.import', 'stock', 'Importar ajustes y conteos desde Excel', 'Carga rápida desde la planilla. Además pide la importación desde Excel en el plan.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'manager', 'server', 'ajustes_stock', 190),
  ('stock.adjust.approve', 'stock', 'Aprobar ajustes de stock', 'Aprobar o rechazar los ajustes pendientes que cargó otra persona (auditor de inventario).', 'admin', 'critical', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'aprobacion_ajustes', 200),
  ('stock.settings', 'stock', 'Configurar la aprobación de ajustes', 'Prender la aprobación, el umbral, la foto obligatoria y quién aprueba.', 'admin', 'high', array['stock.view']::text[], array['stock.view']::text[], 'cashier', 'server', 'aprobacion_ajustes', 210),
  ('customers.view', 'clientes', 'Ver clientes', 'Ver la lista y la ficha de los clientes.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 220),
  ('customers.create', 'clientes', 'Dar de alta clientes', 'Crear clientes nuevos desde Clientes o desde el POS.', 'operate', 'low', array['customers.view']::text[], array['customers.view']::text[], 'cashier', 'server', null, 230),
  ('customers.edit', 'clientes', 'Editar clientes', 'Cambiar datos de contacto y fiscales de un cliente.', 'operate', 'low', array['customers.view']::text[], array['customers.view']::text[], 'cashier', 'server', null, 240),
  ('customers.delete', 'clientes', 'Dar de baja clientes', 'Dar de baja un cliente (queda en la historia).', 'admin', 'medium', array['customers.edit']::text[], array['customers.edit', 'customers.view']::text[], 'cashier', 'server', null, 250),
  ('purchases.manage', 'compras', 'Compras y proveedores', 'Cargar compras, proveedores, recepciones y costos de compra.', 'admin', 'high', array['products.view']::text[], array['products.view']::text[], 'manager', 'server', null, 260),
  ('treasury.manage', 'finanzas', 'Tesorería', 'Cuentas, cheques, pagos y cobranzas de tesorería.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 270),
  ('taxes.manage', 'finanzas', 'Impuestos', 'Regímenes, alícuotas, percepciones y retenciones del negocio.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 280),
  ('accounting.manage', 'finanzas', 'Contabilidad', 'Plan de cuentas, asientos y períodos contables.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 290),
  ('reports.view', 'reportes', 'Ver reportes', 'Ver los reportes de ventas, caja y stock de sus sucursales.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 300),
  ('reports.costs', 'reportes', 'Ver costos y márgenes', 'Ver márgenes, costo de lo vendido y alertas de margen.', 'admin', 'medium', array['reports.view']::text[], array['reports.view']::text[], 'viewer', 'server', null, 310),
  ('audit.view', 'reportes', 'Ver la auditoría', 'Ver quién hizo qué en el negocio (no sólo lo propio).', 'admin', 'medium', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 320),
  ('config.edit', 'configuracion', 'Editar la configuración del POS', 'Topes de descuento, venta sin stock, tickets y reglas del POS.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'manager', 'server', null, 330),
  ('config.security', 'configuracion', 'Seguridad y PIN de supervisor', 'Quién autoriza con PIN y qué acciones lo piden.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'server', null, 340),
  ('billing.manage', 'configuracion', 'Plan y suscripción', 'Cambiar el plan, pagar y ceder la titularidad.', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'server', null, 350),
  ('team.view', 'equipo', 'Ver el equipo', 'Ver quién trabaja en el negocio y en qué sucursal.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'ui', null, 360),
  ('team.manage', 'equipo', 'Invitar y gestionar personal', 'Invitar, editar, suspender y asignar roles (nunca más permisos que los propios).', 'admin', 'critical', array['team.view']::text[], array['team.view']::text[], 'manager', 'server', null, 370),
  ('team.roles', 'equipo', 'Crear y editar roles', 'Crear roles, cambiar sus permisos y dar permisos puntuales.', 'admin', 'critical', array['team.manage']::text[], array['team.manage', 'team.view']::text[], 'owner', 'server', null, 380),
  ('integrations.manage', 'integraciones', 'Conectar logísticas y medios de pago', 'Credenciales de logísticas y comisiones de los medios de pago.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 390)
on conflict (key) do update set module = excluded.module, label = excluded.label, description = excluded.description,
  level = excluded.level, risk = excluded.risk, depends_on = excluded.depends_on, requires_all = excluded.requires_all,
  min_base = excluded.min_base, enforced = excluded.enforced, grant_feature = excluded.grant_feature, sort = excluded.sort,
  updated_at = now();

insert into permission_roles (id, tenant_id, key, name, description, color, icon, base_role, sort) values
  ('00000000-0000-4000-8000-0000000000a1', null, 'owner', 'Dueño', 'Todo el negocio, siempre. No se edita.', 'flame', 'crown', 'owner', 10),
  ('00000000-0000-4000-8000-0000000000a2', null, 'manager', 'Encargado', 'Opera todo el negocio salvo la configuración del POS, la seguridad y el plan.', 'gold', 'shield', 'manager', 20),
  ('00000000-0000-4000-8000-0000000000a3', null, 'cashier', 'Cajero', 'Vende y cobra en su turno, anula ventas del día y hace devoluciones.', 'blue', 'store', 'cashier', 30),
  ('00000000-0000-4000-8000-0000000000a4', null, 'viewer', 'Solo lectura', 'Mira ventas, caja, stock y reportes. No cambia nada.', 'slate', 'eye', 'viewer', 40),
  ('00000000-0000-4000-8000-0000000000a5', null, 'seller', 'Vendedor', 'Atiende y arma pedidos para que cobre la caja. No abre caja, no cobra ni anula.', 'green', 'tag', 'cashier', 50),
  ('00000000-0000-4000-8000-0000000000a6', null, 'auditor', 'Auditor', 'Mira todo, incluso costos y auditoría, sin tocar nada.', 'violet', 'search', 'viewer', 60)
on conflict (id) do update set key = excluded.key, name = excluded.name, description = excluded.description,
  color = excluded.color, icon = excluded.icon, base_role = excluded.base_role, sort = excluded.sort, updated_at = now();

delete from permission_role_capabilities where tenant_id is null;
insert into permission_role_capabilities (role_id, capability, tenant_id) values
  ('00000000-0000-4000-8000-0000000000a1', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.void.past_days', null),
  ('00000000-0000-4000-8000-0000000000a1', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a1', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'products.price', null),
  ('00000000-0000-4000-8000-0000000000a1', 'prices.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.adjust', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.count', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.import', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.adjust.approve', null),
  ('00000000-0000-4000-8000-0000000000a1', 'stock.settings', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'customers.delete', null),
  ('00000000-0000-4000-8000-0000000000a1', 'purchases.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'treasury.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'taxes.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'accounting.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a1', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'config.edit', null),
  ('00000000-0000-4000-8000-0000000000a1', 'config.security', null),
  ('00000000-0000-4000-8000-0000000000a1', 'billing.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'team.roles', null),
  ('00000000-0000-4000-8000-0000000000a1', 'integrations.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.void.past_days', null),
  ('00000000-0000-4000-8000-0000000000a2', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a2', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.edit', null),
  ('00000000-0000-4000-8000-0000000000a2', 'products.price', null),
  ('00000000-0000-4000-8000-0000000000a2', 'prices.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.adjust', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.count', null),
  ('00000000-0000-4000-8000-0000000000a2', 'stock.import', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a2', 'customers.delete', null),
  ('00000000-0000-4000-8000-0000000000a2', 'purchases.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'treasury.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'taxes.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'accounting.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a2', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'team.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'integrations.manage', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.create', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.void', null),
  ('00000000-0000-4000-8000-0000000000a3', 'sales.return', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.open', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.close', null),
  ('00000000-0000-4000-8000-0000000000a3', 'cash.movements', null),
  ('00000000-0000-4000-8000-0000000000a3', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a3', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a3', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a4', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a5', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a6', 'audit.view', null);
-- @@SEED-FIN@@

-- -----------------------------------------------------------------------------
-- B2) Coherencia rol (nivel) y role_id
-- -----------------------------------------------------------------------------
-- role_id siempre es un rol de sistema o uno vivo del mismo negocio, y role
-- queda igual a su nivel base. Si alguien cambia sólo role (Edge member_admin,
-- panel interno), el rol con capacidades vuelve al de sistema de ese nivel.
create or replace function trg_permission_role_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role permission_roles;
begin
  if new.role_id is not null
     and (tg_op = 'INSERT' or new.role_id is distinct from old.role_id) then
    select * into v_role from permission_roles where id = new.role_id;
    if v_role.id is null or v_role.deleted_at is not null
       or (v_role.tenant_id is not null and v_role.tenant_id is distinct from new.tenant_id) then
      raise exception 'invalid_role' using errcode = '22023';
    end if;
    new.role := v_role.base_role;
    -- Los cuatro roles de nivel (dueño, encargado, cajero, solo lectura) van
    -- sin role_id: role_id null = el rol de sistema de su nivel.
    if v_role.tenant_id is null and v_role.key in ('owner', 'manager', 'cashier', 'viewer') then
      new.role_id := null;
    end if;
  elsif tg_op = 'UPDATE' and new.role is distinct from old.role
        and new.role_id is not distinct from old.role_id
        and new.role_id is not null
        and new.role is distinct from (select r.base_role from permission_roles r where r.id = new.role_id) then
    -- Cambió el nivel a uno que no es el del rol: vuelve al rol de sistema.
    new.role_id := null;
  end if;
  if tg_table_name = 'staff_branch_assignments' and new.role is null then
    new.role_id := null;
  end if;
  -- Cambió un rol: lo resuelto en esta transacción ya no vale.
  perform set_config('ninja.caps', '', true);
  return new;
end;
$$;
revoke all on function trg_permission_role_sync() from public, anon, authenticated;

drop trigger if exists permission_role_sync on tenant_users;
create trigger permission_role_sync
  before insert or update of role, role_id on tenant_users
  for each row execute function trg_permission_role_sync();

drop trigger if exists permission_role_sync on staff_branch_assignments;
create trigger permission_role_sync
  before insert or update of role, role_id on staff_branch_assignments
  for each row execute function trg_permission_role_sync();

-- Cualquier escritura en las tablas de permisos limpia la caché de la transacción.
create or replace function trg_permission_cache_reset()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform set_config('ninja.caps', '', true);
  return null;
end;
$$;
revoke all on function trg_permission_cache_reset() from public, anon;

do $$
declare
  t text;
begin
  foreach t in array array['permission_roles', 'permission_role_capabilities', 'permission_user_overrides'] loop
    execute format('drop trigger if exists permission_cache_reset on public.%I', t);
    execute format(
      'create trigger permission_cache_reset after insert or update or delete on public.%I '
      'for each statement execute function trg_permission_cache_reset()', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- C) Resolución de capacidades efectivas
-- -----------------------------------------------------------------------------
-- Espejo de resolveCapabilities() (lib/permissions/capabilities.ts):
--   1. Rol: el de la sucursal (asignación vigente con rol, cobertura > base >
--      adicional, como user_store_role) o el del negocio. role_id null = el
--      rol de sistema de su nivel. Dueño = todo.
--   2. Rol personalizado (o borrado) sin la feature roles_permisos: el de
--      sistema de su nivel base.
--   3. Permisos puntuales: conceder suma, quitar resta. Con la feature
--      roles_permisos, todos; sin ella, sólo los de capacidades con
--      grant_feature prendida en el plan (otorgables de Inventario, ADR-137).
--   4. Cuenta sólo lo que permite el nivel base (min_base; lo de dueño, nunca)
--      y lo que tiene todas sus dependencias.
create or replace function capabilities_for(p_tenant uuid, p_user uuid, p_store uuid default null)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base    text;
  v_role_id uuid;
  v_s_base  text;
  v_s_role  uuid;
  v_custom  boolean;
  v_alive   boolean;
  v_feature boolean;
  v_caps    text[];
  v_rank    int;
  v_allowed text[];
  v_grant   text[];
  v_revoke  text[];
begin
  if p_tenant is null or p_user is null then return '{}'; end if;
  select tu.role, tu.role_id into v_base, v_role_id
    from tenant_users tu
   where tu.tenant_id = p_tenant and tu.user_id = p_user and tu.status = 'active'
   limit 1;
  if v_base is null then return '{}'; end if;
  if v_base = 'owner' then
    return array(select c.key from permission_capabilities c order by c.sort);
  end if;

  if p_store is not null then
    select a.role, a.role_id into v_s_base, v_s_role
      from staff_branch_assignments a
     where a.tenant_id = p_tenant and a.user_id = p_user and a.store_id = p_store
       and a.deleted_at is null and a.role is not null
       and a.valid_from <= branch_today()
       and (a.valid_until is null or a.valid_until >= branch_today())
     order by case a.kind when 'cover' then 0 when 'home' then 1 else 2 end, a.valid_from desc
     limit 1;
    if v_s_base is not null then
      v_base := v_s_base;
      v_role_id := v_s_role;
    end if;
  end if;

  if v_role_id is not null then
    select (r.tenant_id is not null), (r.deleted_at is null)
      into v_custom, v_alive
      from permission_roles r
     where r.id = v_role_id;
    if v_custom is null then
      v_role_id := null;
    elsif v_custom then
      v_feature := coalesce(tenant_has_feature_for(p_tenant, 'roles_permisos'), false);
      if not (v_alive and v_feature) then v_role_id := null; end if;
    end if;
  end if;
  if v_role_id is null then
    select r.id into v_role_id from permission_roles r where r.tenant_id is null and r.key = v_base;
  end if;

  select coalesce(array_agg(rc.capability), '{}') into v_caps
    from permission_role_capabilities rc
   where rc.role_id = v_role_id;

  if exists (select 1 from permission_user_overrides o where o.tenant_id = p_tenant and o.user_id = p_user) then
    if v_feature is null then
      v_feature := coalesce(tenant_has_feature_for(p_tenant, 'roles_permisos'), false);
    end if;
    -- Permisos puntuales que cuentan con este plan.
    select coalesce(array_agg(o.capability) filter (where o.effect = 'grant'), '{}'),
           coalesce(array_agg(o.capability) filter (where o.effect = 'revoke'), '{}')
      into v_grant, v_revoke
      from permission_user_overrides o
      join permission_capabilities c on c.key = o.capability
     where o.tenant_id = p_tenant and o.user_id = p_user
       and (v_feature
            or (c.grant_feature is not null
                and coalesce(tenant_has_feature_for(p_tenant, c.grant_feature), false)));
    if cardinality(v_grant) > 0 or cardinality(v_revoke) > 0 then
      select coalesce(array_agg(distinct x), '{}') into v_caps
        from (select unnest(v_caps) as x union select unnest(v_grant)) s
       where not (x = any (v_revoke));
    end if;
  end if;

  v_rank := case v_base when 'manager' then 2 when 'cashier' then 1 else 0 end;
  select coalesce(array_agg(c.key), '{}') into v_allowed
    from permission_capabilities c
   where c.key = any (v_caps)
     and (case c.min_base when 'owner' then 3 when 'manager' then 2 when 'cashier' then 1 else 0 end) <= v_rank;

  return array(
    select c.key from permission_capabilities c
     where c.key = any (v_allowed) and c.requires_all <@ v_allowed
     order by c.sort);
end;
$$;
revoke all on function capabilities_for(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function capabilities_for(uuid, uuid, uuid) to service_role;

-- Caché por transacción (una entrada): los triggers por fila preguntan lo
-- mismo muchas veces en un mismo request. Las escrituras en tablas de
-- permisos y en tenant_users / staff_branch_assignments la limpian.
create or replace function _capabilities_cached(p_tenant uuid, p_user uuid, p_store uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key  text;
  v_hit  text := coalesce(current_setting('ninja.caps', true), '');
  v_caps text[];
begin
  if p_tenant is null or p_user is null then return '{}'; end if;
  v_key := p_tenant::text || ':' || p_user::text || ':' || coalesce(p_store::text, '-') || '=';
  if v_hit <> '' and left(v_hit, length(v_key)) = v_key then
    return coalesce(string_to_array(nullif(substr(v_hit, length(v_key) + 1), ''), ','), '{}');
  end if;
  v_caps := capabilities_for(p_tenant, p_user, p_store);
  perform set_config('ninja.caps', v_key || array_to_string(v_caps, ','), true);
  return v_caps;
end;
$$;
revoke all on function _capabilities_cached(uuid, uuid, uuid) from public, anon, authenticated;

-- Usuario del JWT en el negocio activo (nivel negocio).
create or replace function has_capability(p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_cap = any (_capabilities_cached(current_tenant_id(), auth.uid(), null)), false);
$$;
revoke all on function has_capability(text) from public, anon;
grant execute on function has_capability(text) to authenticated, service_role;

-- Usuario del JWT en una sucursal (rol pisado por la asignación vigente).
create or replace function has_capability_at(p_cap text, p_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_cap = any (_capabilities_cached(current_tenant_id(), auth.uid(), p_store)), false);
$$;
revoke all on function has_capability_at(text, uuid) from public, anon;
grant execute on function has_capability_at(text, uuid) to authenticated, service_role;

-- Usuario del JWT en el negocio de la fila (triggers).
create or replace function member_has_capability(p_tenant uuid, p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_cap = any (_capabilities_cached(p_tenant, auth.uid(), null)), false);
$$;
revoke all on function member_has_capability(uuid, text) from public, anon;
grant execute on function member_has_capability(uuid, text) to authenticated, service_role;

-- Como has_capability, pero además personal operativo (dueño o estado activo),
-- igual que is_tenant_manager() (ADR-051).
create or replace function has_active_capability(p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability(p_cap)
     and (coalesce(member_role_in(current_tenant_id()), '') = 'owner'
          or staff_effective_status(current_tenant_id(), auth.uid(), null, null) = 'active');
$$;
revoke all on function has_active_capability(text) from public, anon;
grant execute on function has_active_capability(text) to authenticated, service_role;

-- Para Edge Functions (service_role): capacidad de un usuario en un negocio.
create or replace function user_has_capability(p_tenant uuid, p_user uuid, p_cap text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_cap = any (capabilities_for(p_tenant, p_user, null)), false);
$$;
revoke all on function user_has_capability(uuid, uuid, text) from public, anon, authenticated;
grant execute on function user_has_capability(uuid, uuid, text) to service_role;

-- Lo que puede hacer el usuario del JWT (UI): rol, nivel, capacidades del
-- negocio y, por sucursal con rol propio, las de esa sucursal.
create or replace function my_capabilities()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_tu     record;
  v_role   permission_roles;
  v_stores jsonb;
begin
  if v_tenant is null or auth.uid() is null then return null; end if;
  select tu.role, tu.role_id into v_tu
    from tenant_users tu
   where tu.tenant_id = v_tenant and tu.user_id = auth.uid() and tu.status = 'active'
   limit 1;
  if v_tu.role is null then return null; end if;
  select * into v_role from permission_roles
   where id = coalesce(v_tu.role_id, (select id from permission_roles where tenant_id is null and key = v_tu.role));
  select coalesce(jsonb_object_agg(s.store_id, to_jsonb(capabilities_for(v_tenant, auth.uid(), s.store_id))), '{}')
    into v_stores
    from (select distinct a.store_id
            from staff_branch_assignments a
           where a.tenant_id = v_tenant and a.user_id = auth.uid() and a.deleted_at is null
             and a.role is not null and a.valid_from <= branch_today()
             and (a.valid_until is null or a.valid_until >= branch_today())) s;
  return jsonb_build_object(
    'base', v_tu.role,
    'role_id', v_role.id,
    'role_key', v_role.key,
    'role_name', v_role.name,
    'custom', v_role.tenant_id is not null,
    'feature', coalesce(tenant_has_feature_for(v_tenant, 'roles_permisos'), false),
    'capabilities', to_jsonb(capabilities_for(v_tenant, auth.uid(), null)),
    'stores', v_stores);
end;
$$;
revoke all on function my_capabilities() from public, anon;
grant execute on function my_capabilities() to authenticated;

-- -----------------------------------------------------------------------------
-- D1) trg_role_write_guard por capacidad
--     Copia de 20261031200000 con las capacidades. Lo que no cambia:
--       · sin usuario (cron, service_role) no aplica;
--       · solo lectura (nivel viewer) no escribe nunca;
--       · nadie cambia sales.status por REST;
--       · sin membresía (staff interno, acotado por internal_scope) o dueño:
--         pasa, como antes.
--     Lo nuevo, con el mismo resultado para los roles de sistema:
--       · siempre (también dentro de RPC SECURITY DEFINER): vender
--         (sales.create), anular (sales.void), devolver (sales.return), abrir y
--         cerrar caja (cash.open, cash.close), ingresos y retiros
--         (cash.movements). Hoy los tienen dueño, encargado y cajero.
--       · por REST o RPC INVOKER (como el modo 'manage' de antes): productos,
--         variantes, categorías y marcas (products.edit; precios y costos
--         products.price; sólo el stock, stock.adjust), movimientos de stock
--         (stock.adjust), impuestos (taxes.manage), logísticas y comisiones
--         (integrations.manage). Otras tablas 'manage' siguen por nivel: el
--         cajero no.
--       · clientes: alta (customers.create), edición (customers.edit), baja
--         (customers.delete).
-- -----------------------------------------------------------------------------
create or replace function trg_role_write_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mode    text := coalesce(tg_argv[0], 'operate');
  v_row     jsonb;
  v_old     jsonb;
  v_tenant  uuid;
  v_role    text;
  v_client  boolean := current_user in ('authenticated', 'anon');
  v_cap     text;
  v_changed text[];
begin
  if auth.uid() is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  -- Todo por jsonb: el trigger se instala en tablas con columnas distintas.
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
  end if;
  v_tenant := coalesce(nullif(v_row ->> 'tenant_id', '')::uuid, current_tenant_id());
  v_role := member_role_in(v_tenant);

  if v_role = 'viewer' then
    raise exception 'forbidden_read_only' using errcode = '42501';
  end if;

  if v_mode = 'sales' and v_client and tg_op = 'UPDATE'
     and (v_row ->> 'status') is distinct from (v_old ->> 'status') then
    raise exception 'use_void_sale' using errcode = '42501';
  end if;

  if v_role is null or v_role = 'owner' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- 1) Acciones de caja y venta: también dentro de RPC SECURITY DEFINER.
  v_cap := null;
  if tg_table_name = 'sales' then
    if tg_op = 'INSERT' then
      v_cap := 'sales.create';
    elsif tg_op = 'UPDATE' and (v_row ->> 'status') = 'voided'
          and (v_old ->> 'status') is distinct from 'voided' then
      v_cap := 'sales.void';
    end if;
  elsif tg_table_name = 'sale_returns' and tg_op = 'INSERT' then
    v_cap := 'sales.return';
  elsif tg_table_name = 'cash_shifts' then
    if tg_op = 'INSERT' then
      v_cap := 'cash.open';
    elsif tg_op = 'UPDATE' and (v_old ->> 'status') = 'open' and (v_row ->> 'status') = 'closed' then
      v_cap := 'cash.close';
    end if;
  elsif tg_table_name = 'cash_movements' and tg_op = 'INSERT'
        and (v_row ->> 'type') in ('income', 'expense') then
    -- El retiro de exchange_sale (sobrante de un cambio) lo cubre la devolución.
    if not ((v_row ->> 'type') = 'expense' and exists (
              select 1 from sale_returns r
               where r.id = nullif(v_row ->> 'reference_id', '')::uuid
                 and r.tenant_id = v_tenant and r.created_at = now())) then
      v_cap := 'cash.movements';
    end if;
  end if;
  if v_cap is not null and not member_has_capability(v_tenant, v_cap) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:' || v_cap;
  end if;

  -- 2) Por REST o RPC INVOKER.
  if not v_client then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_cap := null;
  if v_mode = 'manage' then
    if tg_table_name in ('products', 'product_variants') then
      if tg_op = 'UPDATE' then
        select coalesce(array_agg(e.key), '{}') into v_changed
          from jsonb_each(v_row) e
         where (v_old -> e.key) is distinct from e.value;
        if cardinality(v_changed) > 0 and v_changed <@ array['stock', 'updated_at', 'updated_by'] then
          v_cap := 'stock.adjust';
        elsif exists (select 1 from unnest(v_changed) k where k ~ '(price|cost)') then
          v_cap := 'products.price';
        else
          v_cap := 'products.edit';
        end if;
      else
        v_cap := 'products.edit';
      end if;
    elsif tg_table_name in ('categories', 'brands') then
      v_cap := 'products.edit';
    elsif tg_table_name = 'stock_movements' then
      v_cap := 'stock.adjust';
    elsif tg_table_name in ('tax_suffered_entries', 'iibb_activities', 'iibb_cm_coefficients',
                            'iibb_liquidations', 'tax_custom_values', 'tax_padron_profiles') then
      v_cap := 'taxes.manage';
    elsif tg_table_name in ('shipping_connections', 'payment_fee_rules') then
      v_cap := 'integrations.manage';
    end if;
    if v_cap is null then
      -- Tabla sin capacidad propia: por nivel, como antes.
      if v_role = 'cashier' then
        raise exception 'forbidden_role' using errcode = '42501';
      end if;
    elsif not member_has_capability(v_tenant, v_cap) then
      raise exception 'forbidden_role' using errcode = '42501', detail = 'capability:' || v_cap;
    end if;
  elsif v_mode = 'customers' then
    if tg_op = 'DELETE'
       or (tg_op = 'UPDATE' and (v_row ->> 'deleted_at') is distinct from (v_old ->> 'deleted_at')) then
      v_cap := 'customers.delete';
    elsif tg_op = 'INSERT' then
      v_cap := 'customers.create';
    else
      v_cap := 'customers.edit';
    end if;
    if not member_has_capability(v_tenant, v_cap) then
      raise exception 'forbidden_role' using errcode = '42501', detail = 'capability:' || v_cap;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function trg_role_write_guard() from public, anon;

-- Ajustes de alertas de margen: solo lectura (y Auditor) no los cambian.
do $$
begin
  if to_regclass('public.margin_alert_settings') is not null then
    drop trigger if exists role_write_guard on public.margin_alert_settings;
    create trigger role_write_guard before insert or update or delete on public.margin_alert_settings
      for each row execute function trg_role_write_guard('operate');
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- D2) void_sale: copia de 20261031200000 con capacidades.
--     sales.void en el negocio; ventas de otro día, sales.void.past_days con
--     el rol de esa sucursal (antes: "el cajero, rol efectivo en la sucursal,
--     no").
-- -----------------------------------------------------------------------------
create or replace function void_sale(
  p_sale_id uuid,
  p_reason  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_store  uuid;
  v_shift  uuid;
  v_day    date;
  v_role   text;
  v_item   record;
  v_pay    record;
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant';
  end if;
  v_role := member_role_in(v_tenant);
  if v_role is null or not has_capability('sales.void') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform assert_staff_operational();

  select store_id, cash_shift_id,
         (created_at at time zone 'America/Argentina/Buenos_Aires')::date
    into v_store, v_shift, v_day
  from sales
  where id = p_sale_id and tenant_id = v_tenant and status = 'completed'
  for update;
  if v_store is null then
    raise exception 'sale_not_found_or_not_voidable';
  end if;
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'sale_not_found_or_not_voidable';
  end if;
  if v_day <> branch_today() and not has_capability_at('sales.void.past_days', v_store) then
    raise exception 'forbidden_void_past_day' using errcode = '42501';
  end if;

  update sales
     set status = 'voided',
         voided_at = now(),
         voided_by = auth.uid(),
         void_reason = p_reason,
         updated_at = now()
   where id = p_sale_id and tenant_id = v_tenant;

  for v_item in
    select product_id, quantity from sale_items
    where sale_id = p_sale_id and tenant_id = v_tenant
  loop
    update products
       set stock = stock + v_item.quantity, updated_at = now()
     where id = v_item.product_id and tenant_id = v_tenant;

    insert into stock_movements (product_id, store_id, delta, reason, reference_id)
    values (v_item.product_id, v_store, v_item.quantity, 'sale_void', p_sale_id);
  end loop;

  if v_shift is not null then
    for v_pay in
      select method, amount from payments
      where sale_id = p_sale_id and tenant_id = v_tenant
    loop
      insert into cash_movements (cash_shift_id, type, amount, payment_method, reference_id)
      values (v_shift, 'sale_void', v_pay.amount, v_pay.method, p_sale_id);
    end loop;
  end if;
end;
$$;
revoke all on function void_sale(uuid, text) from public, anon;
grant execute on function void_sale(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D3) adjust_store_stock: copia de 20261013200100 con stock.adjust (antes
--     owner o manager).
-- -----------------------------------------------------------------------------
create or replace function adjust_store_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_qty        numeric,
  p_mode       text default 'delta',
  p_reason     text default 'adjustment',
  p_notes      text default null
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_prod   record;
  v_cur    numeric;
  v_delta  numeric;
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not has_capability('stock.adjust') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_mode not in ('delta', 'set') then
    raise exception 'invalid_mode';
  end if;
  if p_reason not in ('purchase','adjustment','loss','return','count','production') then
    raise exception 'invalid_reason: %', p_reason;
  end if;
  if p_qty is null or (p_mode = 'delta' and p_qty = 0) or (p_mode = 'set' and p_qty < 0) then
    raise exception 'invalid_qty';
  end if;

  if not exists (
    select 1 from stores where id = p_store_id and tenant_id = v_tenant and deleted_at is null
  ) then
    raise exception 'store_not_found';
  end if;

  if p_store_id is distinct from stock_default_store(v_tenant) then
    if not tenant_has_feature_for(v_tenant, 'multi_sucursal') then
      raise exception 'feature_not_in_plan: multi_sucursal';
    end if;
    if not tenant_has_feature_for(v_tenant, 'stock_sucursales') then
      raise exception 'feature_not_in_plan: stock_sucursales';
    end if;
  end if;

  select id, has_variants into v_prod
    from products
   where id = p_product_id and tenant_id = v_tenant and deleted_at is null;
  if v_prod.id is null then
    raise exception 'product_not_found';
  end if;
  if coalesce(v_prod.has_variants, false) then
    if p_variant_id is null then
      raise exception 'variant_required';
    end if;
    if not exists (
      select 1 from product_variants
       where id = p_variant_id and product_id = p_product_id and tenant_id = v_tenant
         and deleted_at is null
    ) then
      raise exception 'variant_not_found';
    end if;
  elsif p_variant_id is not null then
    raise exception 'variant_not_allowed';
  end if;

  select qty into v_cur
    from product_stock
   where store_id = p_store_id and product_id = p_product_id
     and variant_id is not distinct from p_variant_id
   for update;
  v_cur := coalesce(v_cur, 0);

  v_delta := case when p_mode = 'set' then p_qty - v_cur else p_qty end;
  if v_delta = 0 then
    return v_cur;
  end if;

  if p_variant_id is null then
    update products
       set stock = stock + v_delta, updated_by = auth.uid(), updated_at = now()
     where id = p_product_id and tenant_id = v_tenant;
  else
    update product_variants
       set stock = stock + v_delta, updated_at = now()
     where id = p_variant_id and tenant_id = v_tenant;
  end if;

  insert into stock_movements (tenant_id, product_id, variant_id, store_id, delta, reason, notes, created_by)
  values (v_tenant, p_product_id, p_variant_id, p_store_id, v_delta,
          case when p_mode = 'set' then 'count' else p_reason end,
          nullif(trim(coalesce(p_notes, '')), ''), auth.uid());

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason)
  values (v_tenant, auth.uid(), 'product_stock', p_product_id,
          case when p_mode = 'set' then 'stock_count' else 'stock_adjust' end,
          jsonb_build_object('store_id', p_store_id, 'variant_id', p_variant_id, 'qty', v_cur),
          jsonb_build_object('store_id', p_store_id, 'variant_id', p_variant_id, 'qty', v_cur + v_delta,
                             'delta', v_delta, 'reason', p_reason),
          nullif(trim(coalesce(p_notes, '')), ''));

  return v_cur + v_delta;
end;
$$;
revoke all on function adjust_store_stock(uuid, uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function adjust_store_stock(uuid, uuid, uuid, numeric, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- D4) Helpers de escritura por módulo (antes: stock_my_role() in owner,
--     manager). Misma firma, misma feature.
-- -----------------------------------------------------------------------------
create or replace function price_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability('prices.manage')
     and coalesce(tenant_has_feature_for(current_tenant_id(), 'listas_precios'), false);
$$;
revoke all on function price_can_write() from public, anon;
grant execute on function price_can_write() to authenticated;

create or replace function price_pro_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability('prices.manage')
     and price_pro_enabled(current_tenant_id());
$$;
revoke all on function price_pro_can_write() from public, anon;
grant execute on function price_pro_can_write() to authenticated;

create or replace function purchase_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability('purchases.manage')
     and tenant_has_feature_for(current_tenant_id(), 'compras');
$$;
revoke all on function purchase_can_write() from public, anon;
grant execute on function purchase_can_write() to authenticated;

create or replace function treasury_can_write()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability('treasury.manage')
     and tenant_has_feature_for(current_tenant_id(), 'tesoreria');
$$;
revoke all on function treasury_can_write() from public, anon;
grant execute on function treasury_can_write() to authenticated;

create or replace function tax_can_write(p_feature text default 'impuestos_iva')
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select has_capability('taxes.manage')
     and coalesce(tenant_has_feature_for(current_tenant_id(), p_feature), false);
$$;
revoke all on function tax_can_write(text) from public, anon;
grant execute on function tax_can_write(text) to authenticated;

create or replace function acc_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'no_tenant';
  end if;
  if not has_capability('accounting.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'contabilidad') then
    raise exception 'feature_not_in_plan: contabilidad';
  end if;
  return v_tenant;
end;
$$;
revoke all on function acc_assert() from public, anon;
grant execute on function acc_assert() to authenticated;

-- Costos y márgenes (antes: owner o manager).
create or replace function _margin_assert()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not has_capability('reports.costs') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'alertas_margen') then
    raise exception 'feature_not_in_plan: alertas_margen';
  end if;
  return v_tenant;
end;
$$;
revoke all on function _margin_assert() from public, anon, authenticated;

-- Conteos cíclicos (antes: owner o manager).
create or replace function _cycle_assert(p_store_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not has_capability('stock.count') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'conteo_ciclico') then
    raise exception 'feature_not_in_plan: conteo_ciclico';
  end if;
  if p_store_id is not null then
    if not exists (select 1 from stores s where s.id = p_store_id and s.tenant_id = v_tenant
                     and s.deleted_at is null) then
      raise exception 'store_not_found';
    end if;
    if not user_can_access_store(p_store_id) then
      raise exception 'forbidden_store' using errcode = '42501';
    end if;
  end if;
  return v_tenant;
end;
$$;
revoke all on function _cycle_assert(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D5) Configuración del POS (antes: sólo el dueño) y auditoría (antes:
--     is_tenant_manager()).
-- -----------------------------------------------------------------------------
drop policy if exists pos_settings_insert on pos_settings;
create policy pos_settings_insert on pos_settings
  for insert
  with check (tenant_id = (select current_tenant_id()) and (select has_capability('config.edit')));
drop policy if exists pos_settings_update on pos_settings;
create policy pos_settings_update on pos_settings
  for update
  using (tenant_id = (select current_tenant_id()) and (select has_capability('config.edit')))
  with check (tenant_id = (select current_tenant_id()) and (select has_capability('config.edit')));
drop policy if exists pos_settings_delete on pos_settings;
create policy pos_settings_delete on pos_settings
  for delete
  using (tenant_id = (select current_tenant_id()) and (select has_capability('config.edit')));

drop policy if exists audit_logs_role_scope on audit_logs;
create policy audit_logs_role_scope on audit_logs
  as restrictive for select
  using (
    (select has_active_capability('audit.view'))
    or actor_user_id = (select auth.uid())
    or (select internal_scope())
  );
