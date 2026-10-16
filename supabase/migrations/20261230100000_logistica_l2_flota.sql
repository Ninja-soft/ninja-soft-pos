-- =============================================================================
-- ADR-161 · F22 · H145 (L2 de ADR-149): flota, hojas de ruta y app del
-- repartidor.
--
--   A) Feature reparto_propio (OPTIONAL, Pro+): flota, hojas de ruta, app del
--      repartidor y eventos de entrega con foto, firma y ubicación.
--   B) Capacidades logistics.* (módulo logistica) y rol de sistema Repartidor
--      (uuid ...a7, base cajero, sólo logistics.deliver). Seed completo del
--      catálogo generado desde lib/permissions/capabilities.ts (el test
--      permissionsCatalog compara la última migración con marcadores).
--   C) Aislamiento del Repartidor: is_driver_member(); user_allowed_store_ids()
--      le devuelve ninguna sucursal (ventas, pagos, caja, entregas, remitos y
--      pedidos quedan fuera por sus policies restrictivas) y una policy
--      restrictiva le cierra clientes, direcciones, renglones de venta y los
--      demás datos de clientes. Ve lo suyo sólo por las RPC de reparto.
--      Vender y abrir caja ya piden sales.create y cash.open en el trigger
--      role_write_guard (ADR-138): el Repartidor no las tiene.
--   D) Configuración › Logística: logistics_settings (remitos: cuándo, copias
--      y modelo; qué se exige en cada entrega; motivos de no entrega).
--      remito_config (COT, precios y leyenda) sigue en pos_settings.
--   E) Flota: vehicles y vehicle_photos (bucket privado logistics-media),
--      driver_profiles y logistics_origins.
--   F) Hojas de ruta: delivery_routes, route_stops, route_stop_dispatches y
--      delivery_events (append-only, id generado en el teléfono: idempotente
--      para la cola offline). dispatches suma route_id, route_stop_id,
--      delivery_attempts y el último motivo de no entrega.
--   G) Remitos: copias y modelo (de la configuración al emitir), hoja de
--      ruta y parada, foto del remito firmado. Sin recrear remito_issue: un
--      trigger BEFORE INSERT completa lo nuevo.
--   H) RPC de flota, hojas de ruta y app del repartidor. Todas SECURITY
--      DEFINER con feature, capacidad, negocio y auditoría.
--
-- Producción: 0 entregas, 0 remitos (ADR-149), nada que migrar. No toca
-- create_sale, pos_sale_create_fulfilled ni remito_issue. Redefine a partir
-- de su definición viva: user_allowed_store_ids y _perm_role_for_assign.
-- Nunca "OR is_internal()" (ADR-052, ADR-152).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A) Feature de plan
-- -----------------------------------------------------------------------------
insert into features (key, label, description, grupo, is_basic, sort) values
  ('reparto_propio', 'Reparto propio',
   'Flota con fotos, repartidores, hojas de ruta imprimibles y app del repartidor con firma, foto del remito y ubicación de cada entrega',
   'envios', false, 305)
on conflict (key) do nothing;

update plans p
set limits = jsonb_set(
  coalesce(p.limits, '{}'::jsonb),
  '{modules}',
  coalesce(p.limits -> 'modules', '{}'::jsonb) || jsonb_build_object('reparto_propio', p.key <> 'start'),
  true
)
where p.tenant_id is null
  and p.key in ('start', 'pro', 'business', 'enterprise')
  and not (coalesce(p.limits -> 'modules', '{}'::jsonb) ? 'reparto_propio');

-- -----------------------------------------------------------------------------
-- B) Capacidades y rol Repartidor
-- -----------------------------------------------------------------------------
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
  ('integrations.manage', 'integraciones', 'Conectar logísticas y medios de pago', 'Credenciales de logísticas y comisiones de los medios de pago.', 'admin', 'high', '{}'::text[], '{}'::text[], 'manager', 'server', null, 390),
  ('logistics.view', 'logistica', 'Ver Logística', 'Ver expedición, hojas de ruta, flota y el detalle de cada entrega.', 'view', 'low', '{}'::text[], '{}'::text[], 'viewer', 'server', null, 400),
  ('logistics.prepare', 'logistica', 'Armar y despachar entregas', 'Pasar entregas a armando y listo, despacharlas y emitir sus remitos.', 'operate', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'cashier', 'ui', null, 410),
  ('logistics.route.manage', 'logistica', 'Armar hojas de ruta', 'Crear hojas de ruta, sumar entregas, ordenar paradas, asignar camión y repartidor, y cancelar.', 'operate', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'cashier', 'server', null, 420),
  ('logistics.deliver', 'logistica', 'Repartir con la app', 'Usar la app de reparto en sus hojas: salir, llegar, entregar con firma y foto o marcar que no se pudo.', 'operate', 'medium', '{}'::text[], '{}'::text[], 'cashier', 'server', null, 430),
  ('logistics.track', 'logistica', 'Ver el seguimiento', 'Ver en el mapa dónde está cada camión y lo entregado (llega con el mapa en vivo).', 'view', 'low', array['logistics.view']::text[], array['logistics.view']::text[], 'viewer', 'ui', null, 440),
  ('logistics.fleet.manage', 'logistica', 'Flota, repartidores y orígenes', 'Alta y edición de vehículos con fotos, perfiles de repartidores y orígenes de reparto.', 'admin', 'medium', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'server', null, 450),
  ('logistics.remito.void', 'logistica', 'Anular remitos', 'Anular un remito emitido con motivo.', 'admin', 'high', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'ui', null, 460),
  ('logistics.cot.manage', 'logistica', 'COT: credenciales y reintentos', 'Cargar la clave de transporte de ARBA o AGIP y reintentar pedidos de COT (llega con el COT automático).', 'admin', 'critical', '{}'::text[], '{}'::text[], 'owner', 'ui', null, 470),
  ('logistics.settings', 'logistica', 'Configurar Logística', 'Remitos, copias y modelos, qué se exige en cada entrega y motivos de no entrega.', 'admin', 'high', array['logistics.view']::text[], array['logistics.view']::text[], 'manager', 'server', null, 480)
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
  ('00000000-0000-4000-8000-0000000000a6', null, 'auditor', 'Auditor', 'Mira todo, incluso costos y auditoría, sin tocar nada.', 'violet', 'search', 'viewer', 60),
  ('00000000-0000-4000-8000-0000000000a7', null, 'driver', 'Repartidor', 'Sólo la app de reparto: sus hojas de ruta, entregas con firma, foto y ubicación. No vende ni ve caja.', 'teal', 'truck', 'cashier', 70)
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
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.route.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.deliver', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.fleet.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.remito.void', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.cot.manage', null),
  ('00000000-0000-4000-8000-0000000000a1', 'logistics.settings', null),
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
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.route.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.deliver', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.fleet.manage', null),
  ('00000000-0000-4000-8000-0000000000a2', 'logistics.remito.void', null),
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
  ('00000000-0000-4000-8000-0000000000a3', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a3', 'logistics.prepare', null),
  ('00000000-0000-4000-8000-0000000000a4', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a4', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a4', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a4', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.create', null),
  ('00000000-0000-4000-8000-0000000000a5', 'customers.edit', null),
  ('00000000-0000-4000-8000-0000000000a5', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a5', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'sales.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'cash.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'products.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'customers.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'team.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'logistics.view', null),
  ('00000000-0000-4000-8000-0000000000a6', 'logistics.track', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.valuation', null),
  ('00000000-0000-4000-8000-0000000000a6', 'stock.export', null),
  ('00000000-0000-4000-8000-0000000000a6', 'reports.costs', null),
  ('00000000-0000-4000-8000-0000000000a6', 'audit.view', null),
  ('00000000-0000-4000-8000-0000000000a7', 'logistics.deliver', null);
-- @@SEED-FIN@@

-- -----------------------------------------------------------------------------
-- C) Aislamiento del Repartidor
-- -----------------------------------------------------------------------------
-- ¿El usuario es Repartidor (rol de sistema) en el negocio activo? El dueño
-- nunca. Base de la RLS: sin sucursales y sin datos de clientes ni ventas.
create or replace function public.is_driver_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select tu.role <> 'owner' and tu.role_id = '00000000-0000-4000-8000-0000000000a7'::uuid
      from tenant_users tu
     where tu.tenant_id = current_tenant_id() and tu.user_id = auth.uid() and tu.status = 'active'
     limit 1), false);
$$;
revoke all on function public.is_driver_member() from public, anon;
grant execute on function public.is_driver_member() to authenticated;

-- Definición viva + el Repartidor no ve ni opera sucursales (ventas, pagos,
-- caja, entregas, remitos, pedidos, traslados y ajustes quedan fuera).
create or replace function public.user_allowed_store_ids()
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tenant uuid := current_tenant_id();
  v_role   text;
begin
  if v_tenant is null then return '{}'; end if;
  if is_internal() then
    return coalesce((select array_agg(id) from stores where tenant_id = v_tenant), '{}');
  end if;
  select role into v_role from tenant_users
   where tenant_id = v_tenant and user_id = auth.uid() and status = 'active'
   limit 1;
  if v_role is null then return '{}'; end if;
  -- H113: suspendido, de licencia o dado de baja no ve ni opera sucursales.
  if v_role <> 'owner' and staff_effective_status(v_tenant, auth.uid(), null, null) <> 'active' then
    return '{}';
  end if;
  -- ADR-161: el Repartidor ve lo suyo sólo por las RPC de reparto.
  if is_driver_member() then
    return '{}';
  end if;
  return staff_allowed_store_ids(v_tenant, auth.uid(), null, v_role, null);
end;
$function$;

-- Datos de clientes y de ventas sin alcance por sucursal: cerrados al
-- Repartidor con una policy restrictiva de lectura.
do $$
declare
  t text;
begin
  foreach t in array array[
    'customers', 'customer_addresses', 'customer_notes', 'customer_account_movements', 'customer_pack_credits',
    'sale_items', 'sale_returns', 'sale_promotions', 'sale_fiscal_intents', 'sale_letter_overrides',
    'quotes', 'delivery_orders', 'pending_charges', 'paused_sales', 'store_credit_movements',
    'store_credit_vouchers', 'appointments', 'account_collection_items', 'coupon_redemptions',
    'dining_reservations', 'agenda_waitlist', 'dining_waitlist', 'serial_warranty_claims'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_driver_scope', t);
      execute format(
        'create policy %I on public.%I as restrictive for select to authenticated using (not (select is_driver_member()))',
        t || '_driver_scope', t);
    end if;
  end loop;
end;
$$;

-- Definición viva + el rol Repartidor se asigna sólo con reparto_propio.
create or replace function public._perm_role_for_assign(p_tenant uuid, p_role uuid)
 RETURNS permission_roles
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v permission_roles;
begin
  select * into v from permission_roles where id = p_role;
  if v.id is null or v.deleted_at is not null
     or (v.tenant_id is not null and v.tenant_id <> p_tenant) then
    raise exception 'role_not_found';
  end if;
  if v.base_role = 'owner' then
    raise exception 'cannot_assign_owner' using errcode = '42501';
  end if;
  if v.tenant_id is not null then
    perform _perm_assert_feature(p_tenant);
  end if;
  if v.tenant_id is null and v.key = 'driver' and not tenant_has_feature_for(p_tenant, 'reparto_propio') then
    raise exception 'feature_not_in_plan: reparto_propio' using errcode = 'check_violation';
  end if;
  return v;
end;
$function$;

-- -----------------------------------------------------------------------------
-- Guardas comunes
-- -----------------------------------------------------------------------------
-- Negocio activo, miembro que escribe, reparto_propio en el plan y capacidad.
create or replace function _logi_assert(p_cap text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if stock_my_role() is null or stock_my_role() = 'viewer' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'reparto_propio') then
    raise exception 'feature_not_in_plan: reparto_propio' using errcode = 'check_violation';
  end if;
  if p_cap is not null and not member_has_capability(v_tenant, p_cap) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:' || p_cap;
  end if;
  return v_tenant;
end;
$$;
revoke all on function _logi_assert(text) from public, anon, authenticated;

-- Distancia en metros entre dos puntos (haversine). null si falta alguno.
create or replace function _geo_distance_m(p_lat1 double precision, p_lng1 double precision,
                                           p_lat2 double precision, p_lng2 double precision)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_lat1 is null or p_lng1 is null or p_lat2 is null or p_lng2 is null then null
    else round(2 * 6371000 * asin(least(1, sqrt(
           power(sin(radians(p_lat2 - p_lat1) / 2), 2)
           + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)))))::int
  end;
$$;
revoke all on function _geo_distance_m(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function _geo_distance_m(double precision, double precision, double precision, double precision) to authenticated;

-- uuid o null, sin error.
create or replace function _uuid_or_null(p text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end;
$$;
revoke all on function _uuid_or_null(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- D) Configuración › Logística
-- -----------------------------------------------------------------------------
create table if not exists logistics_settings (
  tenant_id              uuid primary key default current_tenant_id() references tenants(id) on delete cascade,
  -- Remitos
  remito_policy          text not null default 'a_pedido'
                         check (remito_policy in ('nunca', 'a_pedido', 'siempre_reparto', 'siempre_envio')),
  remito_copies          integer not null default 2 check (remito_copies between 1 and 3),
  remito_copy_labels     text[] not null default array['Original: cliente', 'Duplicado: vuelve firmado', 'Triplicado: archivo']
                         check (cardinality(remito_copy_labels) = 3),
  remito_model           text not null default 'a4' check (remito_model in ('a4', 'a4_medio', 'ticket80', 'preimpreso')),
  preprinted_offset_x_mm numeric(5,1) not null default 0 check (preprinted_offset_x_mm between -30 and 30),
  preprinted_offset_y_mm numeric(5,1) not null default 0 check (preprinted_offset_y_mm between -30 and 30),
  -- Entrega en la calle
  require_geo            boolean not null default true,
  require_signature      boolean not null default true,
  require_photo          boolean not null default false,
  require_receiver_name  boolean not null default true,
  require_receiver_doc   boolean not null default false,
  require_remito_photo   boolean not null default false,
  max_distance_m         integer not null default 300 check (max_distance_m between 50 and 20000),
  max_attempts           integer not null default 3 check (max_attempts between 1 and 10),
  failure_reasons        jsonb not null default '[]'::jsonb
                         check (jsonb_typeof(failure_reasons) = 'array' and pg_column_size(failure_reasons) <= 16384),
  updated_by             uuid,
  updated_at             timestamptz not null default now()
);
comment on table logistics_settings is
  'ADR-161: cómo trabaja el negocio sus envíos (remitos, copias, modelo, exigencias de la entrega y motivos). Una fila por negocio; sin fila valen los defaults de _logistics_defaults(). Escritura por logistics_settings_save.';

drop trigger if exists set_updated_at_logistics_settings on logistics_settings;
create trigger set_updated_at_logistics_settings
  before update on logistics_settings
  for each row execute function set_updated_at();

alter table logistics_settings enable row level security;
revoke all on logistics_settings from anon, authenticated;
grant select on logistics_settings to authenticated;
drop policy if exists logistics_settings_select on logistics_settings;
create policy logistics_settings_select on logistics_settings
  for select using (tenant_id = (select current_tenant_id()));

-- Motivos de no entrega por defecto (lista editable en la configuración).
create or replace function _logistics_default_reasons()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select '[
    {"key": "no_estaba", "label": "No estaba en el domicilio", "requires_photo": false, "requires_note": false, "active": true},
    {"key": "direccion_incorrecta", "label": "Dirección incorrecta", "requires_photo": false, "requires_note": false, "active": true},
    {"key": "rechazo", "label": "Rechazó el pedido", "requires_photo": false, "requires_note": true, "active": true},
    {"key": "cerrado", "label": "Cerrado", "requires_photo": true, "requires_note": false, "active": true},
    {"key": "sin_acceso", "label": "Sin acceso", "requires_photo": false, "requires_note": false, "active": true},
    {"key": "danado", "label": "Producto dañado", "requires_photo": true, "requires_note": false, "active": true},
    {"key": "reprogramado", "label": "Reprogramado por el cliente", "requires_photo": false, "requires_note": false, "active": true},
    {"key": "otro", "label": "Otro", "requires_photo": false, "requires_note": true, "active": true}
  ]'::jsonb;
$$;
revoke all on function _logistics_default_reasons() from public, anon, authenticated;

-- Configuración efectiva del negocio (defaults si no hay fila).
create or replace function _logistics_settings(p_tenant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v logistics_settings;
begin
  select * into v from logistics_settings where tenant_id = p_tenant;
  if v.tenant_id is null then
    v.remito_policy := 'a_pedido';
    v.remito_copies := 2;
    v.remito_copy_labels := array['Original: cliente', 'Duplicado: vuelve firmado', 'Triplicado: archivo'];
    v.remito_model := 'a4';
    v.preprinted_offset_x_mm := 0;
    v.preprinted_offset_y_mm := 0;
    v.require_geo := true;
    v.require_signature := true;
    v.require_photo := false;
    v.require_receiver_name := true;
    v.require_receiver_doc := false;
    v.require_remito_photo := false;
    v.max_distance_m := 300;
    v.max_attempts := 3;
    v.failure_reasons := '[]'::jsonb;
  end if;
  return jsonb_build_object(
    'remito_policy', v.remito_policy,
    'remito_copies', v.remito_copies,
    'remito_copy_labels', to_jsonb(v.remito_copy_labels),
    'remito_model', v.remito_model,
    'preprinted_offset_x_mm', v.preprinted_offset_x_mm,
    'preprinted_offset_y_mm', v.preprinted_offset_y_mm,
    'require_geo', v.require_geo,
    'require_signature', v.require_signature,
    'require_photo', v.require_photo,
    'require_receiver_name', v.require_receiver_name,
    'require_receiver_doc', v.require_receiver_doc,
    'require_remito_photo', v.require_remito_photo,
    'max_distance_m', v.max_distance_m,
    'max_attempts', v.max_attempts,
    'failure_reasons', case when jsonb_array_length(v.failure_reasons) = 0 then _logistics_default_reasons()
                            else v.failure_reasons end,
    'saved', v.updated_at is not null);
end;
$$;
revoke all on function _logistics_settings(uuid) from public, anon, authenticated;

create or replace function public.logistics_settings_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or stock_my_role() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  return _logistics_settings(v_tenant);
end;
$$;
revoke all on function public.logistics_settings_get() from public, anon;
grant execute on function public.logistics_settings_get() to authenticated;

-- Guarda la configuración (dueño: logistics.settings). Los motivos se
-- validan uno por uno: clave, etiqueta y banderas conocidas, sin repetidos.
create or replace function public.logistics_settings_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid := current_tenant_id();
  v_before  jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_r       jsonb;
  v_key     text;
  v_label   text;
  v_keys    text[] := '{}';
  v_labels  text[];
begin
  if v_tenant is null or auth.uid() is null then
    raise exception 'no_tenant' using errcode = '42501';
  end if;
  if not tenant_has_feature_for(v_tenant, 'pedidos_despacho') then
    raise exception 'feature_not_in_plan: pedidos_despacho' using errcode = 'check_violation';
  end if;
  if not member_has_capability(v_tenant, 'logistics.settings') then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.settings';
  end if;
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_settings';
  end if;

  if jsonb_typeof(p -> 'failure_reasons') = 'array' then
    if jsonb_array_length(p -> 'failure_reasons') > 20 then
      raise exception 'too_many_reasons';
    end if;
    for v_r in select x from jsonb_array_elements(p -> 'failure_reasons') x loop
      v_key := lower(btrim(coalesce(v_r ->> 'key', '')));
      v_label := btrim(coalesce(v_r ->> 'label', ''));
      if v_key !~ '^[a-z0-9_]{2,40}$' or char_length(v_label) not between 2 and 60 or v_key = any (v_keys) then
        raise exception 'invalid_reason';
      end if;
      v_keys := v_keys || v_key;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'key', v_key, 'label', v_label,
        'requires_photo', coalesce((v_r ->> 'requires_photo')::boolean, false),
        'requires_note', coalesce((v_r ->> 'requires_note')::boolean, false),
        'active', coalesce((v_r ->> 'active')::boolean, true)));
    end loop;
    if not exists (select 1 from jsonb_array_elements(v_reasons) x where (x ->> 'active')::boolean) then
      raise exception 'reasons_required';
    end if;
  end if;

  if jsonb_typeof(p -> 'remito_copy_labels') = 'array' then
    select array_agg(left(btrim(coalesce(x, '')), 40) order by n)
      into v_labels
      from jsonb_array_elements_text(p -> 'remito_copy_labels') with ordinality as t(x, n)
     where n <= 3;
    if cardinality(v_labels) <> 3 or exists (select 1 from unnest(v_labels) l where l = '') then
      raise exception 'invalid_copy_labels';
    end if;
  end if;

  v_before := _logistics_settings(v_tenant);
  insert into logistics_settings (tenant_id) values (v_tenant) on conflict (tenant_id) do nothing;
  update logistics_settings set
    remito_policy = coalesce(nullif(p ->> 'remito_policy', ''), remito_policy),
    remito_copies = coalesce(nullif(p ->> 'remito_copies', '')::int, remito_copies),
    remito_copy_labels = coalesce(v_labels, remito_copy_labels),
    remito_model = coalesce(nullif(p ->> 'remito_model', ''), remito_model),
    preprinted_offset_x_mm = coalesce(nullif(p ->> 'preprinted_offset_x_mm', '')::numeric, preprinted_offset_x_mm),
    preprinted_offset_y_mm = coalesce(nullif(p ->> 'preprinted_offset_y_mm', '')::numeric, preprinted_offset_y_mm),
    require_geo = coalesce((p ->> 'require_geo')::boolean, require_geo),
    require_signature = coalesce((p ->> 'require_signature')::boolean, require_signature),
    require_photo = coalesce((p ->> 'require_photo')::boolean, require_photo),
    require_receiver_name = coalesce((p ->> 'require_receiver_name')::boolean, require_receiver_name),
    require_receiver_doc = coalesce((p ->> 'require_receiver_doc')::boolean, require_receiver_doc),
    require_remito_photo = coalesce((p ->> 'require_remito_photo')::boolean, require_remito_photo),
    max_distance_m = coalesce(nullif(p ->> 'max_distance_m', '')::int, max_distance_m),
    max_attempts = coalesce(nullif(p ->> 'max_attempts', '')::int, max_attempts),
    failure_reasons = case when jsonb_typeof(p -> 'failure_reasons') = 'array' then v_reasons else failure_reasons end,
    updated_by = auth.uid()
  where tenant_id = v_tenant;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'logistics_settings', v_tenant, 'logistics_settings_saved',
          v_before - 'saved', _logistics_settings(v_tenant) - 'saved');
  return _logistics_settings(v_tenant);
end;
$$;
revoke all on function public.logistics_settings_save(jsonb) from public, anon;
grant execute on function public.logistics_settings_save(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- E) Flota, repartidores y orígenes
-- -----------------------------------------------------------------------------
create table if not exists vehicles (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  home_store_id          uuid references stores(id) on delete set null,
  name                   text not null check (char_length(btrim(name)) between 1 and 60),
  kind                   text not null default 'utilitario'
                         check (kind in ('moto', 'auto', 'utilitario', 'camion', 'bici', 'a_pie')),
  plate                  text check (plate is null or plate ~ '^[A-Z0-9 -]{5,12}$'),
  brand                  text check (brand is null or char_length(brand) <= 40),
  model                  text check (model is null or char_length(model) <= 40),
  year                   integer check (year is null or year between 1950 and 2100),
  color                  text check (color is null or char_length(color) <= 30),
  capacity_kg            numeric(10,2) check (capacity_kg is null or capacity_kg >= 0),
  capacity_m3            numeric(8,2) check (capacity_m3 is null or capacity_m3 >= 0),
  capacity_packages      integer check (capacity_packages is null or capacity_packages >= 0),
  max_stops              integer check (max_stops is null or max_stops between 1 and 500),
  carrier_name           text check (carrier_name is null or char_length(carrier_name) <= 120),
  carrier_cuit           text check (carrier_cuit is null or carrier_cuit ~ '^[0-9]{11}$'),
  trailer_plate          text check (trailer_plate is null or trailer_plate ~ '^[A-Z0-9 -]{5,12}$'),
  insurance_until        date,
  vtv_until              date,
  senasa_until           date,
  status                 text not null default 'activo' check (status in ('activo', 'en_taller', 'baja')),
  default_driver_user_id uuid references public.users(id) on delete set null,
  cover_photo_path       text check (cover_photo_path is null or char_length(cover_photo_path) <= 300),
  notes                  text check (notes is null or char_length(notes) <= 500),
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
comment on table vehicles is
  'ADR-161: flota del negocio (camiones, utilitarios, motos) con capacidad, vencimientos y foto principal. Escrituras por RPC (logistics.fleet.manage).';
create index if not exists vehicles_tenant_idx on vehicles (tenant_id, status) where deleted_at is null;
create unique index if not exists vehicles_plate_key on vehicles (tenant_id, plate) where deleted_at is null and plate is not null;
create index if not exists vehicles_home_store_idx on vehicles (home_store_id) where home_store_id is not null;
create index if not exists vehicles_driver_idx on vehicles (default_driver_user_id) where default_driver_user_id is not null;

create table if not exists vehicle_photos (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  vehicle_id  uuid not null references vehicles(id) on delete cascade,
  path        text not null check (char_length(path) between 10 and 300),
  kind        text not null default 'otro' check (kind in ('frente', 'lateral', 'carga', 'documento', 'otro')),
  caption     text check (caption is null or char_length(caption) <= 120),
  sort        integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
comment on table vehicle_photos is 'ADR-161: fotos del vehículo en el bucket privado logistics-media (<negocio>/vehicles/<vehículo>/...).';
create index if not exists vehicle_photos_vehicle_idx on vehicle_photos (vehicle_id, sort) where deleted_at is null;
create index if not exists vehicle_photos_tenant_idx on vehicle_photos (tenant_id);

create table if not exists driver_profiles (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  user_id            uuid not null references public.users(id) on delete cascade,
  phone              text check (phone is null or char_length(phone) <= 40),
  license_number     text check (license_number is null or char_length(license_number) <= 30),
  license_class      text check (license_class is null or char_length(license_class) <= 20),
  license_until      date,
  default_vehicle_id uuid references vehicles(id) on delete set null,
  active             boolean not null default true,
  notes              text check (notes is null or char_length(notes) <= 300),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
comment on table driver_profiles is 'ADR-161: lo que no es del usuario en un repartidor: licencia, teléfono y vehículo habitual.';
create unique index if not exists driver_profiles_user_key on driver_profiles (tenant_id, user_id) where deleted_at is null;
create index if not exists driver_profiles_user_idx on driver_profiles (user_id);
create index if not exists driver_profiles_vehicle_idx on driver_profiles (default_vehicle_id) where default_vehicle_id is not null;

create table if not exists logistics_origins (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  warehouse_id  uuid references warehouses(id) on delete set null,
  name          text not null check (char_length(btrim(name)) between 1 and 60),
  address       jsonb check (address is null or (jsonb_typeof(address) = 'object' and pg_column_size(address) <= 8192)),
  address_text  text check (address_text is null or char_length(address_text) <= 300),
  lat           double precision check (lat is null or lat between -90 and 90),
  lng           double precision check (lng is null or lng between -180 and 180),
  loading_hours text check (loading_hours is null or char_length(loading_hours) <= 120),
  is_default    boolean not null default false,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint logistics_origins_latlng_pair check ((lat is null) = (lng is null))
);
comment on table logistics_origins is 'ADR-161: de dónde sale el reparto (sucursal o depósito) con su dirección en el mapa. Punto de partida de la hoja de ruta.';
create index if not exists logistics_origins_store_idx on logistics_origins (tenant_id, store_id) where deleted_at is null;
create index if not exists logistics_origins_warehouse_idx on logistics_origins (warehouse_id) where warehouse_id is not null;
create unique index if not exists logistics_origins_default_key on logistics_origins (store_id) where is_default and deleted_at is null;

do $$
declare
  t text;
begin
  foreach t in array array['vehicles', 'driver_profiles', 'logistics_origins'] loop
    execute format('drop trigger if exists %I on %I', 'set_updated_at_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'set_updated_at_' || t, t);
  end loop;
end;
$$;

alter table vehicles enable row level security;
alter table vehicle_photos enable row level security;
alter table driver_profiles enable row level security;
alter table logistics_origins enable row level security;
revoke all on vehicles, vehicle_photos, driver_profiles, logistics_origins from anon, authenticated;
grant select on vehicles, vehicle_photos, driver_profiles, logistics_origins to authenticated;

drop policy if exists vehicles_select on vehicles;
create policy vehicles_select on vehicles
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.view')));
drop policy if exists vehicle_photos_select on vehicle_photos;
create policy vehicle_photos_select on vehicle_photos
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.view')));
drop policy if exists driver_profiles_select on driver_profiles;
create policy driver_profiles_select on driver_profiles
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.view')) or user_id = (select auth.uid())));
drop policy if exists logistics_origins_select on logistics_origins;
create policy logistics_origins_select on logistics_origins
  for select using (tenant_id = (select current_tenant_id()) and (select has_capability('logistics.view')));

-- -----------------------------------------------------------------------------
-- F) Hojas de ruta, paradas y eventos
-- -----------------------------------------------------------------------------
create table if not exists delivery_routes (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  number             integer not null check (number >= 1),
  store_id           uuid not null references stores(id),
  origin_id          uuid references logistics_origins(id) on delete set null,
  service_date       date not null,
  vehicle_id         uuid references vehicles(id) on delete set null,
  driver_user_id     uuid references public.users(id) on delete set null,
  helper_user_id     uuid references public.users(id) on delete set null,
  status             text not null default 'borrador'
                     check (status in ('borrador', 'planificada', 'cargando', 'en_curso', 'cerrada', 'cancelada')),
  optimize_mode      text not null default 'manual' check (optimize_mode in ('manual', 'heuristica')),
  return_to_origin   boolean not null default true,
  planned_distance_m integer check (planned_distance_m is null or planned_distance_m >= 0),
  load_checked_by    uuid references public.users(id) on delete set null,
  load_checked_at    timestamptz,
  started_at         timestamptz,
  closed_at          timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  summary            jsonb check (summary is null or jsonb_typeof(summary) = 'object'),
  notes              text check (notes is null or char_length(notes) <= 500),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint delivery_routes_helper_check check (helper_user_id is null or helper_user_id is distinct from driver_user_id)
);
comment on table delivery_routes is
  'ADR-161: hoja de ruta (un vehículo, un repartidor, un día). borrador -> planificada -> cargando -> en_curso -> cerrada; cancelada antes de salir.';
create unique index if not exists delivery_routes_number_key on delivery_routes (tenant_id, number);
create index if not exists delivery_routes_day_idx on delivery_routes (tenant_id, service_date desc) where deleted_at is null;
create index if not exists delivery_routes_driver_idx on delivery_routes (driver_user_id, status) where driver_user_id is not null;
create index if not exists delivery_routes_helper_idx on delivery_routes (helper_user_id) where helper_user_id is not null;
create index if not exists delivery_routes_vehicle_idx on delivery_routes (vehicle_id, service_date) where vehicle_id is not null;
create index if not exists delivery_routes_store_idx on delivery_routes (store_id);
create index if not exists delivery_routes_origin_idx on delivery_routes (origin_id) where origin_id is not null;
create index if not exists delivery_routes_load_idx on delivery_routes (load_checked_by) where load_checked_by is not null;

create table if not exists route_stops (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  route_id             uuid not null references delivery_routes(id) on delete cascade,
  seq                  integer not null check (seq >= 1),
  kind                 text not null default 'entrega' check (kind in ('entrega', 'retiro', 'sucursal', 'pausa')),
  customer_id          uuid references customers(id) on delete set null,
  address_id           uuid references customer_addresses(id) on delete set null,
  ship_to              jsonb check (ship_to is null or (jsonb_typeof(ship_to) = 'object' and pg_column_size(ship_to) <= 8192)),
  address_text         text check (address_text is null or char_length(address_text) <= 300),
  lat                  double precision check (lat is null or lat between -90 and 90),
  lng                  double precision check (lng is null or lng between -180 and 180),
  contact_name         text check (contact_name is null or char_length(contact_name) <= 120),
  contact_phone        text check (contact_phone is null or char_length(contact_phone) <= 40),
  notes                text check (notes is null or char_length(notes) <= 500),
  status               text not null default 'pendiente'
                       check (status in ('pendiente', 'en_camino', 'en_el_lugar', 'entregada', 'parcial', 'no_entregada', 'saltada')),
  arrived_at           timestamptz,
  completed_at         timestamptz,
  failure_reason_key   text check (failure_reason_key is null or char_length(failure_reason_key) <= 40),
  failure_reason_label text check (failure_reason_label is null or char_length(failure_reason_label) <= 60),
  attempt              integer not null default 1 check (attempt >= 1),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
comment on table route_stops is 'ADR-161: parada de una hoja de ruta (un lugar en un orden); puede llevar varias entregas.';
create index if not exists route_stops_route_idx on route_stops (route_id, seq) where deleted_at is null;
create index if not exists route_stops_tenant_idx on route_stops (tenant_id);
create index if not exists route_stops_customer_idx on route_stops (customer_id) where customer_id is not null;
create index if not exists route_stops_address_idx on route_stops (address_id) where address_id is not null;

create table if not exists route_stop_dispatches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  route_id    uuid not null references delivery_routes(id) on delete cascade,
  stop_id     uuid not null references route_stops(id) on delete cascade,
  dispatch_id uuid not null references dispatches(id) on delete cascade,
  outcome     text not null default 'pendiente' check (outcome in ('pendiente', 'entregado', 'no_entregado', 'quitado')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
comment on table route_stop_dispatches is 'ADR-161: entregas de cada parada con su resultado. Una entrega sólo está en una parada abierta a la vez.';
create unique index if not exists route_stop_dispatches_open_key on route_stop_dispatches (dispatch_id) where outcome = 'pendiente';
create index if not exists route_stop_dispatches_stop_idx on route_stop_dispatches (stop_id);
create index if not exists route_stop_dispatches_route_idx on route_stop_dispatches (route_id);
create index if not exists route_stop_dispatches_tenant_idx on route_stop_dispatches (tenant_id);

create table if not exists delivery_events (
  id                 uuid primary key,
  tenant_id          uuid not null default current_tenant_id() references tenants(id) on delete cascade,
  route_id           uuid not null references delivery_routes(id) on delete cascade,
  stop_id            uuid references route_stops(id) on delete cascade,
  type               text not null check (type in ('salida', 'llegada', 'entregado', 'no_entregado', 'nota', 'regreso')),
  reason_key         text check (reason_key is null or char_length(reason_key) <= 40),
  reason_label       text check (reason_label is null or char_length(reason_label) <= 60),
  note               text check (note is null or char_length(note) <= 500),
  occurred_at        timestamptz not null,
  received_at        timestamptz not null default now(),
  lat                double precision check (lat is null or lat between -90 and 90),
  lng                double precision check (lng is null or lng between -180 and 180),
  accuracy_m         integer check (accuracy_m is null or accuracy_m >= 0),
  distance_to_stop_m integer check (distance_to_stop_m is null or distance_to_stop_m >= 0),
  far_confirmed      boolean not null default false,
  photo_paths        text[] not null default '{}' check (cardinality(photo_paths) <= 6),
  signature_path     text check (signature_path is null or char_length(signature_path) <= 300),
  remito_photo_path  text check (remito_photo_path is null or char_length(remito_photo_path) <= 300),
  received_by_name   text check (received_by_name is null or char_length(received_by_name) <= 120),
  received_by_doc    text check (received_by_doc is null or char_length(received_by_doc) <= 20),
  actor_user_id      uuid references public.users(id) on delete set null,
  device_id          text check (device_id is null or char_length(device_id) <= 80),
  payload            jsonb check (payload is null or (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 4096))
);
comment on table delivery_events is
  'ADR-161: lo que pasó en la calle (salida, llegada, entregado con firma y foto, no entregado con motivo). Append-only; el id lo genera el teléfono (idempotente para la cola offline).';
create index if not exists delivery_events_route_idx on delivery_events (route_id, occurred_at);
create index if not exists delivery_events_stop_idx on delivery_events (stop_id) where stop_id is not null;
create index if not exists delivery_events_tenant_idx on delivery_events (tenant_id, received_at desc);
create index if not exists delivery_events_actor_idx on delivery_events (actor_user_id) where actor_user_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['delivery_routes', 'route_stops'] loop
    execute format('drop trigger if exists %I on %I', 'set_updated_at_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'set_updated_at_' || t, t);
  end loop;
end;
$$;

-- ¿La hoja es del usuario (repartidor o acompañante)?
create or replace function public.route_is_mine(p_route uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from delivery_routes r
     where r.id = p_route and r.tenant_id = current_tenant_id() and r.deleted_at is null
       and (r.driver_user_id = auth.uid() or r.helper_user_id = auth.uid()));
$$;
revoke all on function public.route_is_mine(uuid) from public, anon;
grant execute on function public.route_is_mine(uuid) to authenticated;

alter table delivery_routes enable row level security;
alter table route_stops enable row level security;
alter table route_stop_dispatches enable row level security;
alter table delivery_events enable row level security;
revoke all on delivery_routes, route_stops, route_stop_dispatches, delivery_events from anon, authenticated;
grant select on delivery_routes, route_stops, route_stop_dispatches, delivery_events to authenticated;

drop policy if exists delivery_routes_select on delivery_routes;
create policy delivery_routes_select on delivery_routes
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.view'))
                         or driver_user_id = (select auth.uid()) or helper_user_id = (select auth.uid())));
drop policy if exists route_stops_select on route_stops;
create policy route_stops_select on route_stops
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.view')) or route_is_mine(route_id)));
drop policy if exists route_stop_dispatches_select on route_stop_dispatches;
create policy route_stop_dispatches_select on route_stop_dispatches
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.view')) or route_is_mine(route_id)));
drop policy if exists delivery_events_select on delivery_events;
create policy delivery_events_select on delivery_events
  for select using (tenant_id = (select current_tenant_id())
                    and ((select has_capability('logistics.view')) or route_is_mine(route_id)));

-- La entrega sabe en qué hoja y parada está, cuántas veces se intentó y por
-- qué no se entregó la última vez.
alter table dispatches add column if not exists route_id uuid references delivery_routes(id) on delete set null;
alter table dispatches add column if not exists route_stop_id uuid references route_stops(id) on delete set null;
alter table dispatches add column if not exists delivery_attempts integer not null default 0;
alter table dispatches add column if not exists last_failure_reason text;
alter table dispatches add column if not exists last_failure_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_delivery_attempts_check') then
    alter table dispatches add constraint dispatches_delivery_attempts_check check (delivery_attempts >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dispatches_last_failure_reason_check') then
    alter table dispatches add constraint dispatches_last_failure_reason_check
      check (last_failure_reason is null or char_length(last_failure_reason) <= 120);
  end if;
end;
$$;
comment on column dispatches.route_id is 'Hoja de ruta en la que viaja ahora (ADR-161). null al volver a Expedición.';
comment on column dispatches.delivery_attempts is 'Intentos de entrega fallidos en reparto propio (ADR-161). failed_attempts es del código de retiro.';
create index if not exists dispatches_route_idx on dispatches (route_id) where route_id is not null;
create index if not exists dispatches_route_stop_idx on dispatches (route_stop_id) where route_stop_id is not null;
grant select (route_id, route_stop_id, delivery_attempts, last_failure_reason, last_failure_at) on dispatches to authenticated;

-- -----------------------------------------------------------------------------
-- G) Remitos: copias, modelo, hoja de ruta y foto del remito firmado
-- -----------------------------------------------------------------------------
alter table remitos add column if not exists copies integer;
alter table remitos add column if not exists model_key text;
alter table remitos add column if not exists route_id uuid references delivery_routes(id) on delete set null;
alter table remitos add column if not exists stop_id uuid references route_stops(id) on delete set null;
alter table remitos add column if not exists signed_copy_path text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'remitos_copies_check') then
    alter table remitos add constraint remitos_copies_check check (copies is null or copies between 1 and 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'remitos_model_key_check') then
    alter table remitos add constraint remitos_model_key_check
      check (model_key is null or model_key in ('a4', 'a4_medio', 'ticket80', 'preimpreso'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'remitos_signed_copy_path_check') then
    alter table remitos add constraint remitos_signed_copy_path_check
      check (signed_copy_path is null or char_length(signed_copy_path) <= 300);
  end if;
end;
$$;
create index if not exists remitos_route_idx on remitos (route_id) where route_id is not null;
create index if not exists remitos_stop_idx on remitos (stop_id) where stop_id is not null;

-- Al emitir: copias y modelo de la configuración; si la entrega viaja en una
-- hoja, la hoja, la parada y (si no vinieron) patente, transporte y chofer.
create or replace function trg_remitos_logistics_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cfg jsonb := _logistics_settings(new.tenant_id);
  v_d   dispatches;
  v_r   delivery_routes;
  v_veh vehicles;
begin
  new.copies := coalesce(new.copies, (v_cfg ->> 'remito_copies')::int);
  new.model_key := coalesce(new.model_key, v_cfg ->> 'remito_model');
  if new.dispatch_id is not null then
    select * into v_d from dispatches where id = new.dispatch_id;
    if v_d.route_id is not null then
      select * into v_r from delivery_routes where id = v_d.route_id;
      new.route_id := v_r.id;
      new.stop_id := v_d.route_stop_id;
      if v_r.vehicle_id is not null then
        select * into v_veh from vehicles where id = v_r.vehicle_id;
        new.vehicle_plate := coalesce(new.vehicle_plate, v_veh.plate);
        new.carrier_name := coalesce(new.carrier_name, v_veh.carrier_name);
        new.carrier_cuit := coalesce(new.carrier_cuit, v_veh.carrier_cuit);
      end if;
      if new.driver_name is null and v_r.driver_user_id is not null then
        new.driver_name := left((select coalesce(nullif(tu.display_name, ''), u.full_name, u.email)
                                   from public.users u
                                   left join tenant_users tu on tu.user_id = u.id and tu.tenant_id = new.tenant_id
                                  where u.id = v_r.driver_user_id), 120);
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function trg_remitos_logistics_defaults() from public, anon, authenticated;

drop trigger if exists remitos_logistics_defaults on remitos;
create trigger remitos_logistics_defaults
  before insert on remitos
  for each row execute function trg_remitos_logistics_defaults();

-- -----------------------------------------------------------------------------
-- Bucket privado logistics-media: <negocio>/vehicles/<vehículo>/<archivo> y
-- <negocio>/routes/<hoja>/<archivo>. URL firmada para leer.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logistics-media', 'logistics-media', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ¿Puede leer (p_write = false) o subir (true) este archivo?
create or replace function public.logistics_media_can(p_name text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_parts  text[] := string_to_array(coalesce(p_name, ''), '/');
  v_tenant uuid := current_tenant_id();
  v_id     uuid;
  v_status text;
begin
  if v_tenant is null or cardinality(v_parts) <> 4 or v_parts[1] is distinct from v_tenant::text
     or v_parts[4] !~ '^[A-Za-z0-9._-]{1,120}$' then
    return false;
  end if;
  if not tenant_has_feature_for(v_tenant, 'reparto_propio') then
    return false;
  end if;
  v_id := _uuid_or_null(v_parts[3]);
  if v_id is null then
    return false;
  end if;
  if v_parts[2] = 'vehicles' then
    if p_write then
      return member_has_capability(v_tenant, 'logistics.fleet.manage')
             and exists (select 1 from vehicles where id = v_id and tenant_id = v_tenant and deleted_at is null);
    end if;
    return member_has_capability(v_tenant, 'logistics.view');
  elsif v_parts[2] = 'routes' then
    select status into v_status from delivery_routes where id = v_id and tenant_id = v_tenant and deleted_at is null;
    if v_status is null then
      return false;
    end if;
    if p_write then
      return v_status in ('planificada', 'cargando', 'en_curso')
             and ((route_is_mine(v_id) and member_has_capability(v_tenant, 'logistics.deliver'))
                  or member_has_capability(v_tenant, 'logistics.route.manage'));
    end if;
    return member_has_capability(v_tenant, 'logistics.view') or route_is_mine(v_id);
  end if;
  return false;
end;
$$;
revoke all on function public.logistics_media_can(text, boolean) from public, anon;
grant execute on function public.logistics_media_can(text, boolean) to authenticated;

drop policy if exists "logistics_media_read" on storage.objects;
drop policy if exists "logistics_media_write" on storage.objects;
create policy "logistics_media_read" on storage.objects for select to authenticated
  using (bucket_id = 'logistics-media'
         and (storage.foldername(name))[1] = (select current_tenant_id())::text
         and logistics_media_can(name, false));
create policy "logistics_media_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'logistics-media'
              and (storage.foldername(name))[1] = (select current_tenant_id())::text
              and logistics_media_can(name, true));

-- Ruta de un archivo de la hoja: <negocio>/routes/<hoja>/<archivo>.
create or replace function _route_media_ok(p_tenant uuid, p_route uuid, p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_path is null
      or p_path ~ ('^' || p_tenant::text || '/routes/' || p_route::text || '/[A-Za-z0-9._-]{1,120}$');
$$;
revoke all on function _route_media_ok(uuid, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: flota
-- -----------------------------------------------------------------------------
create or replace function public.vehicle_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_old    vehicles;
  v_row    vehicles;
  v_plate  text := nullif(upper(regexp_replace(btrim(coalesce(p ->> 'plate', '')), '\s+', ' ', 'g')), '');
  v_trail  text := nullif(upper(regexp_replace(btrim(coalesce(p ->> 'trailer_plate', '')), '\s+', ' ', 'g')), '');
  v_cuit   text := nullif(regexp_replace(coalesce(p ->> 'carrier_cuit', ''), '\D', '', 'g'), '');
  v_store  uuid := _uuid_or_null(p ->> 'home_store_id');
  v_driver uuid := _uuid_or_null(p ->> 'default_driver_user_id');
begin
  if jsonb_typeof(p) is distinct from 'object' or char_length(btrim(coalesce(p ->> 'name', ''))) < 1 then
    raise exception 'vehicle_name_required';
  end if;
  if v_store is not null and not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if v_driver is not null and not exists (select 1 from tenant_users
                                            where tenant_id = v_tenant and user_id = v_driver and status = 'active') then
    raise exception 'driver_not_found';
  end if;
  if v_plate is not null and exists (select 1 from vehicles
                                       where tenant_id = v_tenant and plate = v_plate and deleted_at is null
                                         and id is distinct from p_id) then
    raise exception 'plate_taken';
  end if;

  if p_id is not null then
    select * into v_old from vehicles where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
    if v_old.id is null then
      raise exception 'vehicle_not_found';
    end if;
  end if;

  if p_id is null then
    insert into vehicles (tenant_id, name, created_by) values (v_tenant, left(btrim(p ->> 'name'), 60), auth.uid())
    returning * into v_old;
  end if;
  update vehicles set
    name = left(btrim(p ->> 'name'), 60),
    kind = coalesce(nullif(p ->> 'kind', ''), kind),
    home_store_id = v_store,
    plate = v_plate,
    brand = left(nullif(btrim(coalesce(p ->> 'brand', '')), ''), 40),
    model = left(nullif(btrim(coalesce(p ->> 'model', '')), ''), 40),
    year = nullif(p ->> 'year', '')::int,
    color = left(nullif(btrim(coalesce(p ->> 'color', '')), ''), 30),
    capacity_kg = nullif(p ->> 'capacity_kg', '')::numeric,
    capacity_m3 = nullif(p ->> 'capacity_m3', '')::numeric,
    capacity_packages = nullif(p ->> 'capacity_packages', '')::int,
    max_stops = nullif(p ->> 'max_stops', '')::int,
    carrier_name = left(nullif(btrim(coalesce(p ->> 'carrier_name', '')), ''), 120),
    carrier_cuit = v_cuit,
    trailer_plate = v_trail,
    insurance_until = nullif(p ->> 'insurance_until', '')::date,
    vtv_until = nullif(p ->> 'vtv_until', '')::date,
    senasa_until = nullif(p ->> 'senasa_until', '')::date,
    status = coalesce(nullif(p ->> 'status', ''), status),
    default_driver_user_id = v_driver,
    notes = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 500)
  where id = v_old.id
  returning * into v_row;

  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'vehicles', v_row.id,
          case when p_id is null then 'vehicle_created' else 'vehicle_updated' end,
          case when p_id is null then null else to_jsonb(v_old) - 'tenant_id' end,
          to_jsonb(v_row) - 'tenant_id');
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.vehicle_save(uuid, jsonb) from public, anon;
grant execute on function public.vehicle_save(uuid, jsonb) to authenticated;

-- Baja lógica. No si viaja en una hoja abierta.
create or replace function public.vehicle_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_old    vehicles;
begin
  select * into v_old from vehicles where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if v_old.id is null then
    raise exception 'vehicle_not_found';
  end if;
  if exists (select 1 from delivery_routes r
              where r.vehicle_id = p_id and r.deleted_at is null
                and r.status in ('borrador', 'planificada', 'cargando', 'en_curso')) then
    raise exception 'vehicle_in_route';
  end if;
  update vehicles set deleted_at = now(), status = 'baja' where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data)
  values (v_tenant, auth.uid(), 'vehicles', p_id, 'vehicle_deleted',
          jsonb_build_object('name', v_old.name, 'plate', v_old.plate));
end;
$$;
revoke all on function public.vehicle_delete(uuid) from public, anon;
grant execute on function public.vehicle_delete(uuid) to authenticated;

-- Foto subida al bucket: se registra en la galería. La primera es la portada.
create or replace function public.vehicle_photo_add(p_vehicle uuid, p_path text, p_kind text, p_caption text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_veh    vehicles;
  v_row    vehicle_photos;
begin
  select * into v_veh from vehicles where id = p_vehicle and tenant_id = v_tenant and deleted_at is null for update;
  if v_veh.id is null then
    raise exception 'vehicle_not_found';
  end if;
  if p_path is null or p_path !~ ('^' || v_tenant::text || '/vehicles/' || p_vehicle::text || '/[A-Za-z0-9._-]{1,120}$') then
    raise exception 'invalid_media_path';
  end if;
  if (select count(*) from vehicle_photos where vehicle_id = p_vehicle and deleted_at is null) >= 12 then
    raise exception 'too_many_photos';
  end if;
  insert into vehicle_photos (tenant_id, vehicle_id, path, kind, caption, sort, created_by)
  values (v_tenant, p_vehicle, p_path,
          case when p_kind in ('frente', 'lateral', 'carga', 'documento', 'otro') then p_kind else 'otro' end,
          left(nullif(btrim(coalesce(p_caption, '')), ''), 120),
          coalesce((select max(sort) + 1 from vehicle_photos where vehicle_id = p_vehicle and deleted_at is null), 0),
          auth.uid())
  returning * into v_row;
  if v_veh.cover_photo_path is null then
    update vehicles set cover_photo_path = p_path where id = p_vehicle;
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'vehicles', p_vehicle, 'vehicle_photo_added',
          jsonb_build_object('photo_id', v_row.id, 'kind', v_row.kind));
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.vehicle_photo_add(uuid, text, text, text) from public, anon;
grant execute on function public.vehicle_photo_add(uuid, text, text, text) to authenticated;

-- Quitar una foto (baja lógica) o elegirla como portada.
create or replace function public.vehicle_photo_set(p_photo uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_ph     vehicle_photos;
begin
  select * into v_ph from vehicle_photos where id = p_photo and tenant_id = v_tenant and deleted_at is null for update;
  if v_ph.id is null then
    raise exception 'photo_not_found';
  end if;
  if p_action = 'cover' then
    update vehicles set cover_photo_path = v_ph.path where id = v_ph.vehicle_id;
  elsif p_action = 'delete' then
    update vehicle_photos set deleted_at = now() where id = p_photo;
    update vehicles
       set cover_photo_path = (select p.path from vehicle_photos p
                                where p.vehicle_id = v_ph.vehicle_id and p.deleted_at is null
                                order by p.sort limit 1)
     where id = v_ph.vehicle_id and cover_photo_path = v_ph.path;
  else
    raise exception 'invalid_action';
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data)
  values (v_tenant, auth.uid(), 'vehicles', v_ph.vehicle_id,
          case when p_action = 'cover' then 'vehicle_cover_set' else 'vehicle_photo_deleted' end,
          jsonb_build_object('photo_id', p_photo));
end;
$$;
revoke all on function public.vehicle_photo_set(uuid, text) from public, anon;
grant execute on function public.vehicle_photo_set(uuid, text) to authenticated;

-- Personas que pueden repartir (rol Repartidor o capacidad logistics.deliver)
-- con su perfil. Para la flota y para asignar hojas.
create or replace function public.logistics_drivers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not member_has_capability(v_tenant, 'logistics.view') then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.view';
  end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'name')
      from (
        select jsonb_build_object(
                 'user_id', tu.user_id,
                 'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email),
                 'email', u.email,
                 'base_role', tu.role,
                 'is_driver_role', tu.role_id = '00000000-0000-4000-8000-0000000000a7'::uuid,
                 'role_name', coalesce(pr.name, tu.role),
                 'profile', (select to_jsonb(dp) - 'tenant_id' from driver_profiles dp
                              where dp.tenant_id = v_tenant and dp.user_id = tu.user_id and dp.deleted_at is null),
                 'active_routes', (select count(*) from delivery_routes r
                                    where r.tenant_id = v_tenant and r.driver_user_id = tu.user_id and r.deleted_at is null
                                      and r.status in ('planificada', 'cargando', 'en_curso'))) as x
          from tenant_users tu
          join public.users u on u.id = tu.user_id
          left join permission_roles pr on pr.id = tu.role_id
         where tu.tenant_id = v_tenant and tu.status = 'active'
           and 'logistics.deliver' = any (capabilities_for(v_tenant, tu.user_id, null))
      ) s), '[]'::jsonb);
end;
$$;
revoke all on function public.logistics_drivers() from public, anon;
grant execute on function public.logistics_drivers() to authenticated;

create or replace function public.driver_profile_save(p_user uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_old    driver_profiles;
  v_row    driver_profiles;
  v_veh    uuid := _uuid_or_null(p ->> 'default_vehicle_id');
begin
  if not exists (select 1 from tenant_users where tenant_id = v_tenant and user_id = p_user and status = 'active') then
    raise exception 'driver_not_found';
  end if;
  if v_veh is not null and not exists (select 1 from vehicles where id = v_veh and tenant_id = v_tenant and deleted_at is null) then
    raise exception 'vehicle_not_found';
  end if;
  select * into v_old from driver_profiles where tenant_id = v_tenant and user_id = p_user and deleted_at is null for update;
  if v_old.id is null then
    insert into driver_profiles (tenant_id, user_id) values (v_tenant, p_user) returning * into v_old;
  end if;
  update driver_profiles set
    phone = left(nullif(btrim(coalesce(p ->> 'phone', '')), ''), 40),
    license_number = left(nullif(btrim(coalesce(p ->> 'license_number', '')), ''), 30),
    license_class = left(nullif(btrim(coalesce(p ->> 'license_class', '')), ''), 20),
    license_until = nullif(p ->> 'license_until', '')::date,
    default_vehicle_id = v_veh,
    active = coalesce((p ->> 'active')::boolean, active),
    notes = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 300)
  where id = v_old.id
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data)
  values (v_tenant, auth.uid(), 'driver_profiles', v_row.id, 'driver_profile_saved',
          to_jsonb(v_old) - 'tenant_id', to_jsonb(v_row) - 'tenant_id');
  return to_jsonb(v_row) - 'tenant_id';
end;
$$;
revoke all on function public.driver_profile_save(uuid, jsonb) from public, anon;
grant execute on function public.driver_profile_save(uuid, jsonb) to authenticated;

create or replace function public.logistics_origin_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_store  uuid := _uuid_or_null(p ->> 'store_id');
  v_wh     uuid := _uuid_or_null(p ->> 'warehouse_id');
  v_addr   jsonb;
  v_old    logistics_origins;
  v_row    logistics_origins;
  v_def    boolean := coalesce((p ->> 'is_default')::boolean, false);
begin
  if v_store is null or not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if v_wh is not null and not exists (select 1 from warehouses where id = v_wh and tenant_id = v_tenant
                                                               and store_id = v_store and deleted_at is null) then
    raise exception 'warehouse_not_found';
  end if;
  if char_length(btrim(coalesce(p ->> 'name', ''))) < 1 then
    raise exception 'origin_name_required';
  end if;
  if jsonb_typeof(p -> 'address') = 'object' then
    v_addr := _ship_to_clean(p -> 'address');
  end if;
  if p_id is not null then
    select * into v_old from logistics_origins where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
    if v_old.id is null then
      raise exception 'origin_not_found';
    end if;
  else
    insert into logistics_origins (tenant_id, store_id, name, created_by)
    values (v_tenant, v_store, left(btrim(p ->> 'name'), 60), auth.uid())
    returning * into v_old;
    v_def := v_def or not exists (select 1 from logistics_origins
                                   where store_id = v_store and deleted_at is null and is_default);
  end if;
  if v_def then
    update logistics_origins set is_default = false
     where store_id = v_store and is_default and deleted_at is null and id <> v_old.id;
  end if;
  update logistics_origins set
    store_id = v_store,
    warehouse_id = v_wh,
    name = left(btrim(p ->> 'name'), 60),
    address = v_addr,
    address_text = case when v_addr is not null then _ship_to_text(v_addr) end,
    lat = (v_addr ->> 'lat')::double precision,
    lng = (v_addr ->> 'lng')::double precision,
    loading_hours = left(nullif(btrim(coalesce(p ->> 'loading_hours', '')), ''), 120),
    is_default = v_def or (v_old.is_default and v_old.store_id = v_store)
  where id = v_old.id
  returning * into v_row;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_tenant, auth.uid(), 'logistics_origins', v_row.id,
          case when p_id is null then 'logistics_origin_created' else 'logistics_origin_updated' end,
          case when p_id is null then null else jsonb_build_object('name', v_old.name, 'address', v_old.address_text) end,
          jsonb_build_object('name', v_row.name, 'address', v_row.address_text, 'is_default', v_row.is_default), v_store);
  return to_jsonb(v_row) - 'tenant_id';
end;
$$;
revoke all on function public.logistics_origin_save(uuid, jsonb) from public, anon;
grant execute on function public.logistics_origin_save(uuid, jsonb) to authenticated;

create or replace function public.logistics_origin_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.fleet.manage');
  v_old    logistics_origins;
begin
  select * into v_old from logistics_origins where id = p_id and tenant_id = v_tenant and deleted_at is null for update;
  if v_old.id is null then
    raise exception 'origin_not_found';
  end if;
  update logistics_origins set deleted_at = now(), is_default = false where id = p_id;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, store_id)
  values (v_tenant, auth.uid(), 'logistics_origins', p_id, 'logistics_origin_deleted',
          jsonb_build_object('name', v_old.name), v_old.store_id);
end;
$$;
revoke all on function public.logistics_origin_delete(uuid) from public, anon;
grant execute on function public.logistics_origin_delete(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: hojas de ruta (panel)
-- -----------------------------------------------------------------------------
-- Hoja bloqueada para cambiarla. p_mode 'manage' (logistics.route.manage) o
-- 'driver' (repartidor o acompañante de la hoja con logistics.deliver, o
-- quien arma hojas).
create or replace function _route_lock(p_route uuid, p_mode text)
returns delivery_routes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert(null);
  v_r      delivery_routes;
  v_mine   boolean;
begin
  select * into v_r from delivery_routes
   where id = p_route and tenant_id = v_tenant and deleted_at is null
   for update;
  if v_r.id is null then
    raise exception 'route_not_found';
  end if;
  v_mine := v_r.driver_user_id = auth.uid() or v_r.helper_user_id = auth.uid();
  if p_mode = 'driver' and v_mine and member_has_capability(v_tenant, 'logistics.deliver') then
    return v_r;
  end if;
  if not member_has_capability(v_tenant, 'logistics.route.manage') then
    raise exception 'forbidden_capability' using errcode = '42501',
      detail = 'capability:' || case when p_mode = 'driver' then 'logistics.deliver' else 'logistics.route.manage' end;
  end if;
  if not coalesce(user_can_access_store(v_r.store_id), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  return v_r;
end;
$$;
revoke all on function _route_lock(uuid, text) from public, anon, authenticated;

-- ¿Puede repartir esta persona? (miembro activo con logistics.deliver)
create or replace function _route_driver_ok(p_tenant uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user is null or (
    exists (select 1 from tenant_users where tenant_id = p_tenant and user_id = p_user and status = 'active')
    and 'logistics.deliver' = any (capabilities_for(p_tenant, p_user, null)));
$$;
revoke all on function _route_driver_ok(uuid, uuid) from public, anon, authenticated;

-- Crear (p_id null) o editar una hoja: día, sucursal, origen, vehículo,
-- repartidor, acompañante y notas. Sólo antes de salir.
create or replace function public.delivery_route_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := _logi_assert('logistics.route.manage');
  v_r      delivery_routes;
  v_old    delivery_routes;
  v_store  uuid := _uuid_or_null(p ->> 'store_id');
  v_origin uuid := _uuid_or_null(p ->> 'origin_id');
  v_veh    uuid := _uuid_or_null(p ->> 'vehicle_id');
  v_driver uuid := _uuid_or_null(p ->> 'driver_user_id');
  v_helper uuid := _uuid_or_null(p ->> 'helper_user_id');
  v_date   date := coalesce(nullif(p ->> 'service_date', '')::date, branch_today());
  v_number int;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'invalid_route';
  end if;
  if p_id is not null then
    v_old := _route_lock(p_id, 'manage');
    if v_old.status not in ('borrador', 'planificada', 'cargando') then
      raise exception 'route_not_editable';
    end if;
    v_store := coalesce(v_store, v_old.store_id);
  end if;
  if v_store is null or not exists (select 1 from stores where id = v_store and tenant_id = v_tenant) then
    raise exception 'store_not_found';
  end if;
  if not coalesce(user_can_access_store(v_store), false) then
    raise exception 'store_forbidden' using errcode = '42501';
  end if;
  if p_id is not null and v_store <> v_old.store_id
     and exists (select 1 from route_stops where route_id = p_id and deleted_at is null) then
    raise exception 'route_has_stops';
  end if;
  if v_origin is not null and not exists (select 1 from logistics_origins where id = v_origin and tenant_id = v_tenant
                                                                     and store_id = v_store and deleted_at is null) then
    raise exception 'origin_not_found';
  end if;
  if v_origin is null then
    select id into v_origin from logistics_origins
     where store_id = v_store and tenant_id = v_tenant and is_default and deleted_at is null;
  end if;
  if v_veh is not null and not exists (select 1 from vehicles where id = v_veh and tenant_id = v_tenant
                                                            and deleted_at is null and status = 'activo') then
    raise exception 'vehicle_not_available';
  end if;
  if not _route_driver_ok(v_tenant, v_driver) then
    raise exception 'driver_not_allowed';
  end if;
  if not _route_driver_ok(v_tenant, v_helper) then
    raise exception 'driver_not_allowed';
  end if;
  if v_helper is not null and v_helper = v_driver then
    raise exception 'helper_is_driver';
  end if;

  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('delivery_route_number:' || v_tenant::text));
    select coalesce(max(number), 0) + 1 into v_number from delivery_routes where tenant_id = v_tenant;
    insert into delivery_routes (tenant_id, number, store_id, origin_id, service_date, vehicle_id, driver_user_id,
                                 helper_user_id, return_to_origin, notes, created_by)
    values (v_tenant, v_number, v_store, v_origin, v_date, v_veh, v_driver, v_helper,
            coalesce((p ->> 'return_to_origin')::boolean, true),
            left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 500), auth.uid())
    returning * into v_r;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_tenant, auth.uid(), 'delivery_routes', v_r.id, 'route_created',
            jsonb_build_object('number', v_r.number, 'service_date', v_r.service_date, 'vehicle_id', v_veh,
                               'driver_user_id', v_driver), v_store);
  else
    update delivery_routes set
      store_id = v_store, origin_id = v_origin, service_date = v_date, vehicle_id = v_veh,
      driver_user_id = v_driver, helper_user_id = v_helper,
      return_to_origin = coalesce((p ->> 'return_to_origin')::boolean, return_to_origin),
      notes = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 500)
    where id = p_id
    returning * into v_r;
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
    values (v_tenant, auth.uid(), 'delivery_routes', v_r.id, 'route_updated',
            jsonb_build_object('service_date', v_old.service_date, 'vehicle_id', v_old.vehicle_id,
                               'driver_user_id', v_old.driver_user_id, 'helper_user_id', v_old.helper_user_id),
            jsonb_build_object('service_date', v_r.service_date, 'vehicle_id', v_r.vehicle_id,
                               'driver_user_id', v_r.driver_user_id, 'helper_user_id', v_r.helper_user_id), v_store);
  end if;
  return to_jsonb(v_r) - 'tenant_id';
end;
$$;
revoke all on function public.delivery_route_save(uuid, jsonb) from public, anon;
grant execute on function public.delivery_route_save(uuid, jsonb) to authenticated;

-- Suma entregas por envío (sin logística) a la hoja. Las de un mismo cliente
-- y dirección van a la misma parada. Devuelve cuántas sumó.
create or replace function public.route_add_dispatches(p_route uuid, p_dispatch_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r     delivery_routes := _route_lock(p_route, 'manage');
  v_d     dispatches;
  v_ship  jsonb;
  v_cid   uuid;
  v_cname text;
  v_cphone text;
  v_key   text;
  v_stop  route_stops;
  v_seq   int;
  v_added int := 0;
  v_id    uuid;
begin
  if v_r.status not in ('borrador', 'planificada', 'cargando') then
    raise exception 'route_not_editable';
  end if;
  if p_dispatch_ids is null or cardinality(p_dispatch_ids) = 0 or cardinality(p_dispatch_ids) > 200 then
    raise exception 'invalid_dispatches';
  end if;
  foreach v_id in array p_dispatch_ids loop
    select * into v_d from dispatches
     where id = v_id and tenant_id = v_r.tenant_id and deleted_at is null
     for update;
    if v_d.id is null then
      raise exception 'dispatch_not_found';
    end if;
    if v_d.delivery_type <> 'envio' or v_d.shipment_id is not null then
      raise exception 'dispatch_not_for_route';
    end if;
    if v_d.status not in ('pendiente', 'armando', 'listo') then
      raise exception 'dispatch_not_ready: %', v_d.status;
    end if;
    if v_d.fulfillment_store_id <> v_r.store_id then
      raise exception 'dispatch_other_store';
    end if;
    if v_d.fulfillment_store_id <> v_d.store_id and v_d.arrived_at is null then
      raise exception 'dispatch_not_arrived';
    end if;
    if exists (select 1 from route_stop_dispatches where dispatch_id = v_id and outcome = 'pendiente') then
      raise exception 'dispatch_in_route';
    end if;

    v_ship := coalesce(v_d.ship_to, jsonb_build_object('street', v_d.ship_address));
    v_cid := null;
    v_cname := null;
    v_cphone := null;
    select c.id, c.name, c.phone into v_cid, v_cname, v_cphone
      from sales s join customers c on c.id = s.customer_id
     where s.id = v_d.sale_id;
    -- Misma parada: mismo cliente y misma dirección (guardada o mismo texto).
    v_key := coalesce(v_d.address_id::text, lower(btrim(coalesce(v_d.ship_address, ''))));
    select * into v_stop from route_stops st
     where st.route_id = p_route and st.deleted_at is null and st.status = 'pendiente'
       and st.customer_id is not distinct from v_cid
       and coalesce(st.address_id::text, lower(btrim(coalesce(st.address_text, '')))) = v_key
     limit 1;
    if v_stop.id is null then
      select coalesce(max(seq), 0) + 1 into v_seq from route_stops where route_id = p_route and deleted_at is null;
      insert into route_stops (tenant_id, route_id, seq, customer_id, address_id, ship_to, address_text, lat, lng,
                               contact_name, contact_phone, notes)
      values (v_r.tenant_id, p_route, v_seq, v_cid, v_d.address_id, v_ship,
              left(coalesce(v_d.ship_address, _ship_to_text(v_ship)), 300),
              (v_ship ->> 'lat')::double precision, (v_ship ->> 'lng')::double precision,
              left(coalesce(v_ship ->> 'contact_name', v_cname, v_d.customer_name), 120),
              left(coalesce(v_ship ->> 'contact_phone', v_cphone), 40),
              left(concat_ws(' · ', nullif(v_ship ->> 'delivery_notes', ''), nullif(v_d.notes, '')), 500))
      returning * into v_stop;
    end if;
    insert into route_stop_dispatches (tenant_id, route_id, stop_id, dispatch_id)
    values (v_r.tenant_id, p_route, v_stop.id, v_id);
    update dispatches set route_id = p_route, route_stop_id = v_stop.id where id = v_id;
    v_added := v_added + 1;
  end loop;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_dispatches_added',
          jsonb_build_object('number', v_r.number, 'dispatch_ids', to_jsonb(p_dispatch_ids)), v_r.store_id);
  return jsonb_build_object('added', v_added,
                            'stops', (select count(*) from route_stops where route_id = p_route and deleted_at is null));
end;
$$;
revoke all on function public.route_add_dispatches(uuid, uuid[]) from public, anon;
grant execute on function public.route_add_dispatches(uuid, uuid[]) to authenticated;

-- Quita una parada (y sus entregas vuelven a Expedición). Antes de salir.
create or replace function public.route_remove_stop(p_stop uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stop route_stops;
  v_r    delivery_routes;
begin
  select * into v_stop from route_stops where id = p_stop and tenant_id = current_tenant_id() and deleted_at is null;
  if v_stop.id is null then
    raise exception 'stop_not_found';
  end if;
  v_r := _route_lock(v_stop.route_id, 'manage');
  if v_r.status not in ('borrador', 'planificada', 'cargando') then
    raise exception 'route_not_editable';
  end if;
  update dispatches set route_id = null, route_stop_id = null
   where id in (select dispatch_id from route_stop_dispatches where stop_id = p_stop and outcome = 'pendiente');
  update route_stop_dispatches set outcome = 'quitado', closed_at = now() where stop_id = p_stop and outcome = 'pendiente';
  update route_stops set deleted_at = now() where id = p_stop;
  -- Renumera las que quedan.
  update route_stops s set seq = x.n
    from (select id, row_number() over (order by seq, created_at) as n
            from route_stops where route_id = v_r.id and deleted_at is null) x
   where s.id = x.id and s.seq is distinct from x.n;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', v_r.id, 'route_stop_removed',
          jsonb_build_object('stop_id', p_stop, 'address', v_stop.address_text), v_r.store_id);
end;
$$;
revoke all on function public.route_remove_stop(uuid) from public, anon;
grant execute on function public.route_remove_stop(uuid) to authenticated;

-- Orden de las paradas: la lista completa en el orden nuevo. p_mode 'manual'
-- (arrastrado) o 'heuristica' (ordenado por cercanía en el navegador).
create or replace function public.route_reorder(p_route uuid, p_stop_ids uuid[], p_mode text, p_distance_m integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r delivery_routes := _route_lock(p_route, 'manage');
begin
  if v_r.status not in ('borrador', 'planificada', 'cargando') then
    raise exception 'route_not_editable';
  end if;
  if p_mode not in ('manual', 'heuristica') then
    raise exception 'invalid_mode';
  end if;
  if p_stop_ids is null
     or (select count(distinct x) from unnest(p_stop_ids) x) <> cardinality(p_stop_ids)
     or (select array_agg(id order by id) from route_stops where route_id = p_route and deleted_at is null)
        is distinct from (select array_agg(x order by x) from unnest(p_stop_ids) x) then
    raise exception 'invalid_stop_order';
  end if;
  update route_stops s set seq = x.n
    from unnest(p_stop_ids) with ordinality as x(id, n)
   where s.id = x.id;
  update delivery_routes set optimize_mode = p_mode,
         planned_distance_m = case when p_distance_m >= 0 then p_distance_m end
   where id = p_route;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_reordered',
          jsonb_build_object('mode', p_mode, 'stops', cardinality(p_stop_ids), 'distance_m', p_distance_m), v_r.store_id);
end;
$$;
revoke all on function public.route_reorder(uuid, uuid[], text, integer) from public, anon;
grant execute on function public.route_reorder(uuid, uuid[], text, integer) to authenticated;

-- borrador <-> planificada <-> cargando (control de carga). Planificar pide
-- vehículo activo, repartidor y al menos una parada.
create or replace function public.route_set_status(p_route uuid, p_to text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r delivery_routes := _route_lock(p_route, 'manage');
begin
  if not ((v_r.status = 'borrador' and p_to = 'planificada')
          or (v_r.status = 'planificada' and p_to in ('borrador', 'cargando'))
          or (v_r.status = 'cargando' and p_to = 'planificada')) then
    raise exception 'invalid_transition: % -> %', v_r.status, p_to;
  end if;
  if p_to in ('planificada', 'cargando') then
    if v_r.vehicle_id is null or not exists (select 1 from vehicles where id = v_r.vehicle_id and status = 'activo'
                                                                     and deleted_at is null) then
      raise exception 'route_needs_vehicle';
    end if;
    if v_r.driver_user_id is null then
      raise exception 'route_needs_driver';
    end if;
    if not exists (select 1 from route_stops where route_id = p_route and deleted_at is null) then
      raise exception 'route_without_stops';
    end if;
  end if;
  update delivery_routes set
    status = p_to,
    load_checked_by = case when p_to = 'cargando' then auth.uid() else load_checked_by end,
    load_checked_at = case when p_to = 'cargando' then now() else load_checked_at end
  where id = p_route;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_status_changed',
          jsonb_build_object('status', v_r.status), jsonb_build_object('status', p_to), v_r.store_id);
end;
$$;
revoke all on function public.route_set_status(uuid, text) from public, anon;
grant execute on function public.route_set_status(uuid, text) to authenticated;

-- Libera las entregas de las paradas abiertas (vuelven a Expedición).
create or replace function _route_release(p_route uuid, p_outcome text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update dispatches d
     set route_id = null, route_stop_id = null,
         status = case when d.status = 'despachado' then 'listo' else d.status end,
         shipped_at = case when d.status = 'despachado' then null else d.shipped_at end,
         shipped_by = case when d.status = 'despachado' then null else d.shipped_by end,
         delivery_attempts = d.delivery_attempts + case when p_outcome = 'no_entregado' then 1 else 0 end,
         last_failure_reason = case when p_reason is not null then left(p_reason, 120) else d.last_failure_reason end,
         last_failure_at = case when p_reason is not null then now() else d.last_failure_at end
    from route_stop_dispatches x
   where x.route_id = p_route and x.outcome = 'pendiente' and x.dispatch_id = d.id
     and d.status not in ('entregado', 'cancelado');
  get diagnostics v_n = row_count;
  update route_stop_dispatches set outcome = p_outcome, closed_at = now()
   where route_id = p_route and outcome = 'pendiente';
  return v_n;
end;
$$;
revoke all on function _route_release(uuid, text, text) from public, anon, authenticated;

-- Cancelar una hoja que no salió: las entregas vuelven a Expedición.
create or replace function public.route_cancel(p_route uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r      delivery_routes := _route_lock(p_route, 'manage');
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  v_n      int;
begin
  if v_r.status not in ('borrador', 'planificada', 'cargando') then
    raise exception 'route_not_cancellable';
  end if;
  v_n := _route_release(p_route, 'quitado', null);
  update delivery_routes set status = 'cancelada', cancelled_at = now(), cancel_reason = v_reason where id = p_route;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, reason, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_cancelled',
          jsonb_build_object('status', v_r.status), jsonb_build_object('status', 'cancelada', 'released', v_n),
          v_reason, v_r.store_id);
end;
$$;
revoke all on function public.route_cancel(uuid, text) from public, anon;
grant execute on function public.route_cancel(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- H) RPC: app del repartidor
-- -----------------------------------------------------------------------------
-- Valida y guarda un evento. Idempotente por id: si ya existe, devuelve lo
-- guardado sin repetir efectos (la cola offline puede mandar dos veces).
create or replace function _delivery_event_insert(p_r delivery_routes, p jsonb, p_type text, p_stop uuid,
                                                  p_distance integer)
returns delivery_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    delivery_events;
  v_photos text[];
  v_at     timestamptz;
begin
  select coalesce(array_agg(x), '{}') into v_photos
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'photo_paths') = 'array' then p -> 'photo_paths'
                                        else '[]'::jsonb end) x;
  if cardinality(v_photos) > 6 then
    raise exception 'too_many_photos';
  end if;
  if exists (select 1 from unnest(v_photos) x where not _route_media_ok(p_r.tenant_id, p_r.id, x))
     or not _route_media_ok(p_r.tenant_id, p_r.id, nullif(p ->> 'signature_path', ''))
     or not _route_media_ok(p_r.tenant_id, p_r.id, nullif(p ->> 'remito_photo_path', '')) then
    raise exception 'invalid_media_path';
  end if;
  begin
    v_at := nullif(p ->> 'occurred_at', '')::timestamptz;
  exception when others then
    v_at := null;
  end;
  -- Hora del teléfono, sin futuro (reloj adelantado) ni más de 7 días atrás.
  v_at := least(coalesce(v_at, now()), now());
  if v_at < now() - interval '7 days' then
    v_at := now();
  end if;
  insert into delivery_events (id, tenant_id, route_id, stop_id, type, reason_key, reason_label, note, occurred_at,
                               lat, lng, accuracy_m, distance_to_stop_m, far_confirmed, photo_paths, signature_path,
                               remito_photo_path, received_by_name, received_by_doc, actor_user_id, device_id, payload)
  values ((p ->> 'id')::uuid, p_r.tenant_id, p_r.id, p_stop, p_type,
          left(nullif(p ->> 'reason_key', ''), 40), left(nullif(p ->> 'reason_label', ''), 60),
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 500), v_at,
          case when (p ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
               then (p ->> 'lat')::double precision end,
          case when (p ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
               then (p ->> 'lng')::double precision end,
          case when (p ->> 'accuracy_m') ~ '^[0-9]+(\.[0-9]+)?$' then round((p ->> 'accuracy_m')::numeric)::int end,
          p_distance, coalesce((p ->> 'far_confirmed')::boolean, false), v_photos,
          nullif(p ->> 'signature_path', ''), nullif(p ->> 'remito_photo_path', ''),
          left(nullif(btrim(coalesce(p ->> 'received_by_name', '')), ''), 120),
          left(nullif(regexp_replace(coalesce(p ->> 'received_by_doc', ''), '[^0-9A-Za-z]', '', 'g'), ''), 20),
          auth.uid(), left(nullif(p ->> 'device_id', ''), 80),
          case when jsonb_typeof(p -> 'payload') = 'object' and pg_column_size(p -> 'payload') <= 4096 then p -> 'payload' end)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function _delivery_event_insert(delivery_routes, jsonb, text, uuid, integer) from public, anon, authenticated;

-- Salir: la hoja pasa a en_curso y sus entregas a "despachado". Pide
-- vehículo libre (no en otra hoja en curso) y, si la configuración lo pide,
-- remito emitido en cada entrega.
create or replace function public.route_start(p_route uuid, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r     delivery_routes := _route_lock(p_route, 'driver');
  v_cfg   jsonb := _logistics_settings(v_r.tenant_id);
  v_ev    delivery_events;
  v_n     int;
begin
  if jsonb_typeof(p_event) = 'object' and _uuid_or_null(p_event ->> 'id') is not null
     and exists (select 1 from delivery_events where id = (p_event ->> 'id')::uuid) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_r.status);
  end if;
  if v_r.status not in ('planificada', 'cargando') then
    raise exception 'invalid_transition: % -> en_curso', v_r.status;
  end if;
  if v_r.vehicle_id is null or v_r.driver_user_id is null then
    raise exception 'route_needs_vehicle';
  end if;
  if exists (select 1 from delivery_routes o
              where o.tenant_id = v_r.tenant_id and o.id <> v_r.id and o.status = 'en_curso' and o.deleted_at is null
                and o.vehicle_id = v_r.vehicle_id) then
    raise exception 'vehicle_busy';
  end if;
  if v_cfg ->> 'remito_policy' in ('siempre_reparto', 'siempre_envio')
     and exists (select 1 from route_stop_dispatches x
                  where x.route_id = p_route and x.outcome = 'pendiente'
                    and not exists (select 1 from remitos rm
                                     where rm.dispatch_id = x.dispatch_id and rm.status = 'emitido' and rm.deleted_at is null)) then
    raise exception 'remito_missing';
  end if;

  update dispatches d
     set status = 'despachado', shipped_at = now(), shipped_by = auth.uid()
    from route_stop_dispatches x
   where x.route_id = p_route and x.outcome = 'pendiente' and x.dispatch_id = d.id
     and d.status in ('pendiente', 'armando', 'listo');
  get diagnostics v_n = row_count;
  update route_stops set status = 'en_camino' where route_id = p_route and deleted_at is null and status = 'pendiente';
  update delivery_routes set status = 'en_curso', started_at = now() where id = p_route;
  if jsonb_typeof(p_event) = 'object' and _uuid_or_null(p_event ->> 'id') is not null then
    v_ev := _delivery_event_insert(v_r, p_event, 'salida', null, null);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_started',
          jsonb_build_object('status', v_r.status),
          jsonb_build_object('status', 'en_curso', 'dispatches', v_n, 'lat', v_ev.lat, 'lng', v_ev.lng), v_r.store_id);
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'en_curso', 'dispatches', v_n);
end;
$$;
revoke all on function public.route_start(uuid, jsonb) from public, anon;
grant execute on function public.route_start(uuid, jsonb) to authenticated;

-- Registra lo que pasó en una parada: llegada, entregado (con lo que exija
-- la configuración) o no entregado (con motivo). Idempotente por id.
create or replace function public.delivery_event_record(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id     uuid := _uuid_or_null(p ->> 'id');
  v_type   text := p ->> 'type';
  v_r      delivery_routes;
  v_stop   route_stops;
  v_cfg    jsonb;
  v_reason jsonb;
  v_dist   int;
  v_lat    double precision;
  v_lng    double precision;
  v_ev     delivery_events;
  v_old    delivery_events;
  v_name   text := nullif(btrim(coalesce(p ->> 'received_by_name', '')), '');
  v_doc    text := nullif(regexp_replace(coalesce(p ->> 'received_by_doc', ''), '[^0-9A-Za-z]', '', 'g'), '');
  v_photos int := case when jsonb_typeof(p -> 'photo_paths') = 'array' then jsonb_array_length(p -> 'photo_paths') else 0 end;
  v_n      int := 0;
  v_open   int;
begin
  if jsonb_typeof(p) is distinct from 'object' or v_id is null then
    raise exception 'invalid_event';
  end if;
  if v_type not in ('llegada', 'entregado', 'no_entregado', 'nota') then
    raise exception 'invalid_event_type';
  end if;
  v_r := _route_lock(_uuid_or_null(p ->> 'route_id'), 'driver');

  -- Idempotencia: el mismo id ya está guardado.
  select * into v_old from delivery_events where id = v_id;
  if v_old.id is not null then
    if v_old.tenant_id <> v_r.tenant_id or v_old.route_id <> v_r.id then
      raise exception 'invalid_event';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'stop_status', (select status from route_stops where id = v_old.stop_id));
  end if;

  if v_r.status <> 'en_curso' then
    raise exception 'route_not_started';
  end if;
  select * into v_stop from route_stops
   where id = _uuid_or_null(p ->> 'stop_id') and route_id = v_r.id and deleted_at is null
   for update;
  if v_stop.id is null then
    raise exception 'stop_not_found';
  end if;
  if v_type in ('llegada', 'entregado', 'no_entregado')
     and v_stop.status in ('entregada', 'parcial', 'no_entregada', 'saltada') then
    raise exception 'stop_closed';
  end if;

  v_cfg := _logistics_settings(v_r.tenant_id);
  if (p ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$' then
    v_lat := (p ->> 'lat')::double precision;
    v_lng := (p ->> 'lng')::double precision;
  end if;
  v_dist := _geo_distance_m(v_lat, v_lng, v_stop.lat, v_stop.lng);

  if v_type = 'entregado' then
    if (v_cfg ->> 'require_geo')::boolean and v_lat is null then
      raise exception 'geo_required';
    end if;
    if (v_cfg ->> 'require_signature')::boolean and nullif(p ->> 'signature_path', '') is null then
      raise exception 'signature_required';
    end if;
    if (v_cfg ->> 'require_photo')::boolean and v_photos = 0 then
      raise exception 'photo_required';
    end if;
    if (v_cfg ->> 'require_receiver_name')::boolean and (v_name is null or char_length(v_name) < 2) then
      raise exception 'receiver_name_required';
    end if;
    if (v_cfg ->> 'require_receiver_doc')::boolean and (v_doc is null or char_length(v_doc) < 6) then
      raise exception 'receiver_doc_required';
    end if;
    if (v_cfg ->> 'require_remito_photo')::boolean and nullif(p ->> 'remito_photo_path', '') is null then
      raise exception 'remito_photo_required';
    end if;
  elsif v_type = 'no_entregado' then
    select x into v_reason from jsonb_array_elements(v_cfg -> 'failure_reasons') x
     where x ->> 'key' = p ->> 'reason_key' and coalesce((x ->> 'active')::boolean, true);
    if v_reason is null then
      raise exception 'reason_required';
    end if;
    if (v_reason ->> 'requires_photo')::boolean and v_photos = 0 then
      raise exception 'photo_required';
    end if;
    if (v_reason ->> 'requires_note')::boolean and char_length(btrim(coalesce(p ->> 'note', ''))) < 3 then
      raise exception 'note_required';
    end if;
    p := p || jsonb_build_object('reason_label', v_reason ->> 'label');
  end if;
  -- Lejos de la dirección: el teléfono lo pregunta antes de guardar.
  if v_type in ('entregado', 'no_entregado') and v_dist is not null
     and v_dist > (v_cfg ->> 'max_distance_m')::int and not coalesce((p ->> 'far_confirmed')::boolean, false) then
    raise exception 'too_far_from_stop' using detail = 'distance_m:' || v_dist;
  end if;

  v_ev := _delivery_event_insert(v_r, p, v_type, v_stop.id, v_dist);

  if v_type = 'llegada' then
    update route_stops set status = 'en_el_lugar', arrived_at = coalesce(arrived_at, v_ev.occurred_at)
     where id = v_stop.id and status in ('pendiente', 'en_camino');
  elsif v_type = 'entregado' then
    update route_stops set status = 'entregada', completed_at = v_ev.occurred_at,
           arrived_at = coalesce(arrived_at, v_ev.occurred_at)
     where id = v_stop.id;
    update dispatches d
       set status = 'entregado', delivered_at = v_ev.occurred_at, delivered_by = auth.uid(),
           delivered_to = left(coalesce(v_ev.received_by_name, d.customer_name, v_stop.contact_name), 120)
      from route_stop_dispatches x
     where x.stop_id = v_stop.id and x.outcome = 'pendiente' and x.dispatch_id = d.id
       and d.status not in ('entregado', 'cancelado');
    get diagnostics v_n = row_count;
    update route_stop_dispatches set outcome = 'entregado', closed_at = now()
     where stop_id = v_stop.id and outcome = 'pendiente';
    -- El remito queda con quién recibió y la foto del remito firmado.
    update remitos rm
       set received_name = coalesce(rm.received_name, v_ev.received_by_name),
           received_doc = coalesce(rm.received_doc, v_ev.received_by_doc),
           received_at = coalesce(rm.received_at, v_ev.occurred_at),
           signed_copy_path = coalesce(v_ev.remito_photo_path, rm.signed_copy_path),
           route_id = coalesce(rm.route_id, v_r.id),
           stop_id = coalesce(rm.stop_id, v_stop.id)
     where rm.status = 'emitido' and rm.deleted_at is null
       and rm.dispatch_id in (select dispatch_id from route_stop_dispatches where stop_id = v_stop.id);
  elsif v_type = 'no_entregado' then
    update route_stops set status = 'no_entregada', completed_at = v_ev.occurred_at,
           failure_reason_key = v_ev.reason_key, failure_reason_label = v_ev.reason_label
     where id = v_stop.id;
    -- Las entregas vuelven a Expedición (Listo) con el motivo y un intento más.
    update dispatches d
       set route_id = null, route_stop_id = null,
           status = case when d.status = 'despachado' then 'listo' else d.status end,
           shipped_at = case when d.status = 'despachado' then null else d.shipped_at end,
           shipped_by = case when d.status = 'despachado' then null else d.shipped_by end,
           delivery_attempts = d.delivery_attempts + 1,
           last_failure_reason = v_ev.reason_label, last_failure_at = v_ev.occurred_at
      from route_stop_dispatches x
     where x.stop_id = v_stop.id and x.outcome = 'pendiente' and x.dispatch_id = d.id
       and d.status not in ('entregado', 'cancelado');
    get diagnostics v_n = row_count;
    update route_stop_dispatches set outcome = 'no_entregado', closed_at = now()
     where stop_id = v_stop.id and outcome = 'pendiente';
  end if;

  if v_type in ('entregado', 'no_entregado') then
    insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, after_data, store_id)
    values (v_r.tenant_id, auth.uid(), 'delivery_routes', v_r.id,
            case when v_type = 'entregado' then 'route_stop_delivered' else 'route_stop_failed' end,
            jsonb_build_object('stop_id', v_stop.id, 'event_id', v_ev.id, 'dispatches', v_n,
                               'reason', v_ev.reason_label, 'received_by', v_ev.received_by_name,
                               'distance_m', v_dist, 'lat', v_ev.lat, 'lng', v_ev.lng,
                               'signature', v_ev.signature_path is not null,
                               'photos', cardinality(v_ev.photo_paths)), v_r.store_id);
  end if;
  select count(*) into v_open from route_stops
   where route_id = v_r.id and deleted_at is null and status in ('pendiente', 'en_camino', 'en_el_lugar');
  return jsonb_build_object('ok', true, 'duplicate', false,
                            'stop_status', (select status from route_stops where id = v_stop.id),
                            'distance_m', v_dist, 'open_stops', v_open);
end;
$$;
revoke all on function public.delivery_event_record(jsonb) from public, anon;
grant execute on function public.delivery_event_record(jsonb) to authenticated;

-- Cerrar la hoja: las paradas sin visitar quedan "saltada" y sus entregas
-- vuelven a Expedición con el motivo. Resumen en summary.
create or replace function public.route_close(p_route uuid, p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r       delivery_routes := _route_lock(p_route, 'driver');
  v_left    int;
  v_summary jsonb;
begin
  if v_r.status = 'cerrada' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'summary', v_r.summary);
  end if;
  if v_r.status <> 'en_curso' then
    raise exception 'route_not_started';
  end if;
  update route_stops set status = 'saltada', completed_at = now(),
         failure_reason_key = 'no_visitada', failure_reason_label = 'No se visitó'
   where route_id = p_route and deleted_at is null and status in ('pendiente', 'en_camino', 'en_el_lugar');
  get diagnostics v_left = row_count;
  perform _route_release(p_route, 'no_entregado', 'No se visitó');
  select jsonb_build_object(
           'stops', count(*),
           'delivered', count(*) filter (where status in ('entregada', 'parcial')),
           'failed', count(*) filter (where status = 'no_entregada'),
           'skipped', count(*) filter (where status = 'saltada'))
    into v_summary
    from route_stops where route_id = p_route and deleted_at is null;
  update delivery_routes set status = 'cerrada', closed_at = now(), summary = v_summary where id = p_route;
  if jsonb_typeof(p_event) = 'object' and _uuid_or_null(p_event ->> 'id') is not null
     and not exists (select 1 from delivery_events where id = (p_event ->> 'id')::uuid) then
    perform _delivery_event_insert(v_r, p_event, 'regreso', null, null);
  end if;
  insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, before_data, after_data, store_id)
  values (v_r.tenant_id, auth.uid(), 'delivery_routes', p_route, 'route_closed',
          jsonb_build_object('status', v_r.status), v_summary || jsonb_build_object('not_visited', v_left), v_r.store_id);
  return jsonb_build_object('ok', true, 'duplicate', false, 'summary', v_summary);
end;
$$;
revoke all on function public.route_close(uuid, jsonb) from public, anon;
grant execute on function public.route_close(uuid, jsonb) to authenticated;

-- Mis hojas (repartidor o acompañante): las abiertas y las cerradas de los
-- últimos dos días.
create or replace function public.driver_my_routes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is null or not tenant_has_feature_for(v_tenant, 'reparto_propio') then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'number', r.number, 'service_date', r.service_date, 'status', r.status,
             'started_at', r.started_at, 'closed_at', r.closed_at,
             'is_helper', r.helper_user_id = auth.uid(),
             'store_name', st.name,
             'vehicle', case when v.id is not null then jsonb_build_object('name', v.name, 'plate', v.plate, 'kind', v.kind) end,
             'stops', (select count(*) from route_stops s where s.route_id = r.id and s.deleted_at is null),
             'done', (select count(*) from route_stops s where s.route_id = r.id and s.deleted_at is null
                                                          and s.status in ('entregada', 'parcial', 'no_entregada', 'saltada')))
           order by case r.status when 'en_curso' then 0 when 'cargando' then 1 when 'planificada' then 2 else 3 end,
                    r.service_date, r.number)
      from delivery_routes r
      join stores st on st.id = r.store_id
      left join vehicles v on v.id = r.vehicle_id
     where r.tenant_id = v_tenant and r.deleted_at is null
       and (r.driver_user_id = auth.uid() or r.helper_user_id = auth.uid())
       and (r.status in ('planificada', 'cargando', 'en_curso')
            or (r.status = 'cerrada' and r.service_date >= branch_today() - 2))), '[]'::jsonb);
end;
$$;
revoke all on function public.driver_my_routes() from public, anon;
grant execute on function public.driver_my_routes() to authenticated;

-- Detalle de una hoja para la app del repartidor y para el panel: vehículo,
-- repartidor, origen, configuración de la entrega y paradas con sus entregas,
-- productos, remito y último evento. El repartidor sólo ve sus hojas: los
-- datos del cliente le llegan por acá (no lee la tabla de clientes).
create or replace function public.route_detail(p_route uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := current_tenant_id();
  v_r      delivery_routes;
  v_cfg    jsonb;
begin
  select * into v_r from delivery_routes where id = p_route and tenant_id = v_tenant and deleted_at is null;
  if v_r.id is null then
    raise exception 'route_not_found';
  end if;
  if not (((v_r.driver_user_id = auth.uid() or v_r.helper_user_id = auth.uid())
           and member_has_capability(v_tenant, 'logistics.deliver'))
          or member_has_capability(v_tenant, 'logistics.view')) then
    raise exception 'forbidden_capability' using errcode = '42501', detail = 'capability:logistics.view';
  end if;
  v_cfg := _logistics_settings(v_tenant);
  return jsonb_build_object(
    'route', to_jsonb(v_r) - 'tenant_id',
    'store', (select jsonb_build_object('id', s.id, 'name', s.name,
                                        'address', concat_ws(', ', nullif(s.address, ''), nullif(s.city, '')))
                from stores s where s.id = v_r.store_id),
    'origin', (select jsonb_build_object('id', o.id, 'name', o.name, 'address_text', o.address_text, 'lat', o.lat, 'lng', o.lng)
                 from logistics_origins o where o.id = v_r.origin_id),
    'vehicle', (select jsonb_build_object('id', v.id, 'name', v.name, 'plate', v.plate, 'kind', v.kind, 'brand', v.brand,
                                          'model', v.model, 'cover_photo_path', v.cover_photo_path,
                                          'capacity_kg', v.capacity_kg, 'capacity_packages', v.capacity_packages)
                  from vehicles v where v.id = v_r.vehicle_id),
    'driver', (select jsonb_build_object('user_id', u.id, 'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email))
                 from public.users u left join tenant_users tu on tu.user_id = u.id and tu.tenant_id = v_tenant
                where u.id = v_r.driver_user_id),
    'helper', (select jsonb_build_object('user_id', u.id, 'name', coalesce(nullif(tu.display_name, ''), nullif(u.full_name, ''), u.email))
                 from public.users u left join tenant_users tu on tu.user_id = u.id and tu.tenant_id = v_tenant
                where u.id = v_r.helper_user_id),
    'settings', v_cfg - 'remito_copy_labels' - 'preprinted_offset_x_mm' - 'preprinted_offset_y_mm',
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'seq', s.seq, 'kind', s.kind, 'status', s.status, 'customer_id', s.customer_id,
               'address_text', s.address_text, 'ship_to', s.ship_to, 'lat', s.lat, 'lng', s.lng,
               'contact_name', s.contact_name, 'contact_phone', s.contact_phone, 'notes', s.notes,
               'arrived_at', s.arrived_at, 'completed_at', s.completed_at,
               'failure_reason_label', s.failure_reason_label,
               'dispatches', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', d.id, 'number', d.number, 'status', d.status, 'outcome', x.outcome,
                          'customer_name', d.customer_name, 'notes', d.notes, 'sale_number', sa.number,
                          'items', coalesce(
                            (select jsonb_agg(jsonb_build_object('name', concat_ws(' · ', di.product_name, nullif(di.variant_label, '')),
                                                                 'qty', di.qty, 'unit', di.unit, 'sku', di.sku) order by di.sort)
                               from dispatch_items di where di.dispatch_id = d.id),
                            (select jsonb_agg(jsonb_build_object('name', si.product_name, 'qty', si.quantity - coalesce(si.returned_qty, 0),
                                                                 'unit', coalesce(si.unit_label, 'un'), 'sku', si.sku) order by si.created_at)
                               from sale_items si where si.sale_id = d.sale_id),
                            '[]'::jsonb),
                          'remito', (select jsonb_build_object('id', rm.id, 'pto_vta', rm.pto_vta, 'number', rm.number,
                                                               'cot_number', rm.cot_number, 'signed_copy_path', rm.signed_copy_path)
                                       from remitos rm
                                      where rm.dispatch_id = d.id and rm.status = 'emitido' and rm.deleted_at is null
                                      limit 1)) order by d.number)
                   from route_stop_dispatches x
                   join dispatches d on d.id = x.dispatch_id
                   left join sales sa on sa.id = d.sale_id
                  where x.stop_id = s.id), '[]'::jsonb),
               'last_event', (select jsonb_build_object('id', e.id, 'type', e.type, 'occurred_at', e.occurred_at,
                                                        'reason_label', e.reason_label, 'note', e.note,
                                                        'lat', e.lat, 'lng', e.lng, 'distance_to_stop_m', e.distance_to_stop_m,
                                                        'photo_paths', to_jsonb(e.photo_paths), 'signature_path', e.signature_path,
                                                        'remito_photo_path', e.remito_photo_path,
                                                        'received_by_name', e.received_by_name, 'received_by_doc', e.received_by_doc)
                                from delivery_events e
                               where e.stop_id = s.id and e.type in ('entregado', 'no_entregado')
                               order by e.occurred_at desc limit 1))
             order by s.seq)
        from route_stops s
       where s.route_id = v_r.id and s.deleted_at is null), '[]'::jsonb));
end;
$$;
revoke all on function public.route_detail(uuid) from public, anon;
grant execute on function public.route_detail(uuid) to authenticated;

comment on function public.delivery_event_record(jsonb) is
  'ADR-161: evento de una parada (llegada, entregado, no entregado, nota) con geo, firma, fotos y motivo según logistics_settings. Idempotente por id (cola offline).';
