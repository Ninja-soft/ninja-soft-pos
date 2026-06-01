# Changelog

Todos los cambios relevantes de NinjaSoft POS quedan registrados acá.

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: [Semver](https://semver.org/lang/es/).

---

## [Unreleased]

### Changed

- **Sin alerts del navegador:** se reemplazan `window.confirm`/`window.prompt` por un `ConfirmDialog` (Radix/Modal) con estilo de la app. Anular venta pide el motivo en un diálogo (no en el prompt nativo); eliminar categoría confirma en diálogo.

### Added

- **H29 — Cobrar con vale (saldo a favor) en el POS:** `payments.method` suma `store_credit`. Si el cliente seleccionado tiene saldo que cubre el total, aparece el medio "Vale (saldo $X)" en el cobro; `create_sale` valida el saldo y lo descuenta (`store_credit_movements`). Cierra el ciclo de devoluciones con vale → uso del vale.
- **Sección /devoluciones (H29):** página dedicada en el menú (Operación → Devoluciones) para buscar la venta por N° de comprobante/ticket y registrar la devolución/cambio (reusa `ReturnModal`).
- **Numeración de comprobante personalizable + búsqueda de ventas:** `pos_settings.sale_prefix` + `sale_pad` (Operación del POS) definen cómo se muestra el N° de venta (ej. `NINJA-00042`) sobre el correlativo interno. Se aplica en /ventas, ticket y PDF. /ventas suma un **buscador** por N°/ticket. Helper `formatSaleNumber`/`saleMatchesQuery`.
- **Roadmap:** se sumaron la sección dedicada de Devoluciones con búsqueda por ticket/ID, la redención del vale en el POS (H29), la numeración de comprobante personalizable por tenant (H9) y el historial del cliente (H31).
- **Categorías hasta 4 niveles:** la gestión de categorías pasa de 2 a **4 niveles** (rubro → sub-rubro → …). `CategoriesModal` rediseñado: árbol con sangría, agregar sub-categoría inline (tocá ↳ en una categoría), contexto del padre al crear. El selector de categoría del producto muestra el árbol completo indentado. Helper `flattenCategories` + `CATEGORY_MAX_DEPTH`.
- **H29 (v1) — Devoluciones y vales:** desde /ventas, acción **Devolución/cambio** sobre una venta completada. `ReturnModal` permite elegir cuánto de cada ítem devolver, el destino del stock (vuelve a stock / revisión / descarte) y el motivo; reintegra por **efectivo** (sale de caja) o emite un **vale** (saldo a favor del cliente, `store_credit_movements`). Backend: tablas `sale_returns`/`sale_return_items`, `sale_items.returned_qty` (anti doble-devolución) y RPC `return_sale`. Pendiente: redención del vale en el POS, vigencia del vale y "diferencia a cobrar" (cambio).
- **H30 — Selector de cliente + requerir cliente en el POS:** el POS permite elegir un cliente para la venta (busca por nombre/documento) y lo manda en `create_sale`. Nuevo flag `pos_settings.require_customer` (Configuración → Operación del POS): si está activo, bloquea el cobro hasta elegir cliente. Con esto H30 queda completo (salvo señas, que van en H32).
- **H9 — Tickets: título, leyenda y QR configurables:** `tenant_branding` suma `ticket_title` (título del comprobante), `ticket_legend` (leyenda extra al pie) y `ticket_show_qr` (QR con los datos de la venta). Configurables desde Marca del negocio; aplican al ticket en pantalla/impresión y al PDF A4.
- **H30 (PR2) — Settings del POS, parte 2:** **SKU automático** al crear productos sin código (trigger `products_auto_sku` con prefijo configurable) y **motivo obligatorio en el cierre de caja** cuando la diferencia supera la tolerancia (`require_close_reason` + `close_tolerance`; `close_cash_shift` lo valida). El arqueo ya es ciego (el modal de cierre no muestra el esperado). Configuración → Operación del POS suma estos controles. Defaults conservadores: sin cambio salvo que el dueño los active.
- **H30 (PR1) — Settings operativos del POS:** tabla `pos_settings` por tenant (RLS owner/manager) + columna `products.allow_negative`. Configuración → **Operación del POS** para editar descuento máximo por rol, redondeo del total y venta en negativo. `create_sale` (sin regresionar serial/kits/track_stock) valida el descuento máximo por rol, redondea el total al múltiplo configurado y bloquea stock negativo salvo que esté permitido. Defaults permisivos: no cambia el comportamiento de los tenants existentes hasta que el dueño configure. POS: tope de descuento por rol + total redondeado en vivo.

- **H15 (etapa 3) — Mercado Pago OAuth + billing de suscripciones:** los clientes conectan su cuenta de MP **en un click** (OAuth, redirige a MP y vuelve solo) o pegando el Access Token manual; Edge Functions `mp_oauth_start` y `mp_oauth_callback` (intercambio server-side, `state` anti-CSRF en `mp_oauth_states`), refresh automático del token en `mp_create_qr`, route handler `/api/mp/oauth/callback`. Las pasarelas aún no implementadas se muestran como **"Próximamente"**. Nuevo plano de **plataforma**: tabla `platform_secrets` (deny-all, solo service_role) con las credenciales de la app de MP de NinjaSoft, editables desde **`/internal/pagos`** (Edge Function `set_platform_secret`, solo staff). **Cobro de suscripciones**: `mp_subscription_checkout` crea una suscripción (preapproval) MP con la cuenta de NinjaSoft por el plan del negocio (`subscriptions.mp_preapproval_id`), `mp_billing_webhook` actualiza el estado de la suscripción; botón "Generar link de cobro" en el detalle del tenant.
- **H15 (parcial) — Mercado Pago QR:** conexión por Access Token por tenant (Edge Function `set_payment_secret` + UI "Conexión" en Medios de pago) y **cobro por QR** (Checkout Pro): Edge Functions `mp_create_qr` (preferencia + `mp_payment_intents`) y `mp_webhook` (verifica el pago contra MP, no confía en el body); botón "Cobrar con QR (Mercado Pago)" en el POS con estado en vivo (polling) y cierre de venta al aprobarse. QR del init_point. Falta OAuth, Mercado Point y conciliación.

- **H23 (base) — Scanners USB/Bluetooth:** `useScanner` captura lectores HID (teclado) por velocidad de tipeo + Enter y agrega el producto por barcode/SKU (`productsApi.findByCode`) sin necesidad de la cámara; copy del modal de cámara aclara el uso de lectores USB/BT.
- **H24 (parcial) — Etiquetas e impresiones:** página `/etiquetas` para imprimir etiquetas por lote (selección de productos + copias, vista previa, `window.print()`). Código de barras **Code 39 sin dependencias** (generador puro `lib/barcode/code39` + componente SVG `Barcode`). Lógica de etiquetas en `lib/labels` con tests. Link en el menú (Catálogo). Balanza (parsing/WebSerial) queda pendiente.

- **TX-1 — Calendario unificado (`react-day-picker`):** componente `DateRangePicker` (rango + presets, locale es) en Reportes; reemplaza los inputs de fecha nativos.
- **TX-2 — Export XLSX con diseño:** helper `exportXlsx`/`buildWorkbook` (encabezado de marca, totales, autofilter, header congelado); reemplaza el CSV en Reportes y en el Reporte Z de Caja.
- **F7/H11b — Miembros del negocio:** gestión por el dueño en `/dashboard-team`. Usuarios con login (invitación por email, nombre real o genérico, avatar) y perfiles sin login (tipo "Cajero A", PIN opcional). Edición de nombre/rol/avatar y suspender/reactivar. Backend: tabla `cashier_profiles`, `tenant_users.display_name/avatar`, `tenant_members()` extendida, Edge Functions `invite_user` y `member_admin`. Componente `Avatar` (presets). 
- **UI — Resalte de precios configurable:** números con degradado (default marca flama→oro), elegible en Configuración (5 opciones), persistente cross-device.
- **Roadmap F10 — Hardware y mostrador PRO:** fase nueva para configuración avanzada de impresoras, scanners, etiquetas/balanzas, doble pantalla/display cliente y diagnóstico de hardware. Se agregó `docs/20-hardware-pos.md` y checkboxes de seguimiento en `docs/02-roadmap.md`.
- **Roadmap robusto:** se agregó F1.5 Hardening pre-piloto, se ordenaron hitos H7–H56 con checkboxes, se reforzó AFIP con cola fiscal, venta offline y gate de homologación → producción, y se registró ADR-011.
- **Roadmap F11 — Configuración retail avanzada:** medios de pago con recargos/cuotas, garantías extendidas, devoluciones/cambios con vales, cuenta corriente, pedidos de salón, despacho, depósitos/transferencias, roles retail e importación masiva XLSX para datos maestros. Se agregó `docs/21-retail-advanced-settings.md` y ADR-012.
- **Roadmap F12 — Comercios simples y servicios:** modo catálogo chico, cobro rápido por botones, modificadores para heladería/cafetería, agenda para peluquería/estética, comisiones, propinas, packs de sesiones y oportunidad comercial por rubro. Se agregó `docs/22-simple-commerce-services.md` y ADR-013.
- **Roadmap F13 — Gastronomía PRO:** mesas, salones, comandas impresas, ruteo por estación, KDS/pantalla de cocina, cafetería/heladería, delivery/takeaway, recetas/escandallo, reservas gastronómicas y reportes operativos. Se agregó `docs/23-restaurant-cafe-operations.md` y ADR-014.
- **Panel internal NinjaSoft:** acceso directo a `/internal` con retorno post-login, spec completa de consola internal para suscripciones, billing manual, staff, invitaciones, soporte, feature flags, impersonation y auditoría. Se agregó `docs/24-internal-ops-panel.md` y ADR-015.
- **Planes custom y notificaciones por cuenta:** soporte documental para crear planes específicos por cliente, modificar cuota/límites/precio, programar aumentos y mostrar un centro de notificaciones in-app para novedades, cobros, vencimientos, cambios de plan y alertas. Se agregó `docs/25-account-notifications.md` y ADR-016.
- **Control de diseño y estructura:** gate obligatorio para UI/UX, responsive, accesibilidad, reutilización de componentes y arquitectura frontend. Se agregó `docs/26-design-structure-control.md` y ADR-017.
- **Roadmap F14 — Motor comercial enterprise:** planes custom, add-ons, cuotas, entitlements, recargos/cuotas, financiación, reglas comerciales, approvals, inventario PRO, compras/proveedores, offline-first, omnicanal, BI/AI y API/webhooks. Se agregó `docs/27-commercial-configuration-engine.md` y ADR-018.
- **Roadmap F15 — Escuela NinjaSoft y onboarding guiado:** cursos por módulo, tours configurables desde internal, checklist de activación por rubro, ayuda contextual, laboratorio demo, certificaciones y sugerencias/nudges medibles. Se agregó `docs/28-school-onboarding.md` y ADR-019.
- **Roadmap F16 — Comercio unificado tipo Napse/TOTVS:** benchmark específico contra Bridge/Omni/VTOL/Fiscal Flow/Promo; se agregaron cockpit enterprise, journeys omnicanal, OMS, orquestador de pagos, fiscal hub, promo/loyalty enterprise, clienteling, riesgo/fraude, franquicias, integration hub y demos enterprise. Se agregó `docs/29-napse-unified-commerce-benchmark.md` y ADR-020.
- **Deseable F1 — Lector de código de barras por cámara:** componente `BarcodeScanner` (API nativa `BarcodeDetector`, formatos EAN/UPC/Code128, fallback si no soportado) integrado en el POS; al detectar, completa la búsqueda. 
- **Deseable F1 — Import CSV de productos:** parser CSV propio (con comillas), validación por fila, plantilla descargable y `bulkImport` que resuelve/crea categorías por nombre e inserta en lote. Modal "Importar CSV" en `/productos`.
- **CI (gap F0):** workflow GitHub Actions (`.github/workflows/ci.yml`) que corre lint + typecheck + test + build en cada push a `main` y PR (pnpm + Node 20, env dummy para el build). README actualizado (estado del MVP + scripts reales).
- **Hito 6 — Hardening (tests):** suite unitaria por capa (14 tests): carrito Zustand + subtotales, validador CUIT/CUIL, resumen de arqueo de caja, formato, y componente Button. `tests/README.md` documenta el suite y el plan del test de aislamiento multi-tenant (e2e, requiere stack Supabase local). Aislamiento garantizado hoy por RLS.
- **Hito 5 — Panel interno NinjaSoft:** rutas `/internal/*` protegidas por `is_internal` (app_metadata). Listado de tenants con plan/estado, detalle por tenant con cambio de plan, cambio de estado de suscripción y toggle de feature flags. RPCs `internal_set_plan`/`internal_set_subscription_status`/`internal_set_flag` (SECURITY DEFINER con guard `is_internal()`, auditadas, EXECUTE solo authenticated). Bootstrap: marcar al staff con `app_metadata.is_internal=true`.
- **Hito 4 cerrado — Reportes:** RPC `sales_report(from,to)` (agregados por día, medio de pago, categoría y cajero; `SECURITY DEFINER` con guard de tenant, EXECUTE revocado a anon). Página `/reportes` con rango de fechas, KPIs (total/cantidad), 4 tablas y export CSV. Métrica "ventas de hoy" en el dashboard. Con esto Hito 4 (clientes + reportes) queda completo.
- **Hito 4 — Clientes:** tabla `customers` (RLS, defaults, FK `sales.customer_id`), módulo customers con validación de CUIT/CUIL (dígito verificador) y DNI, CRUD en `/clientes` (alta/edición/baja lógica, búsqueda por nombre/documento, condición IVA). Reportes del Hito 4 pendientes (próxima vuelta).
- **Hito 3 — Caja y turnos:** página `/caja` con resumen del turno (apertura, ventas netas, ingresos/egresos, efectivo esperado), ventas por medio de pago, ingresos/egresos manuales con motivo, listado de movimientos y reporte Z exportable (CSV + impresión). Apertura/cierre con arqueo ya venían del POS. Cierra Hito 3.
- **Hito 2 cerrado — ticket no fiscal + anulación:** página `/ventas` (lista de ventas, estado, ticket imprimible vía `@media print`, anulación con motivo). RPC atómica `void_sale` (revierte stock e inserta contramovimiento de caja). Ticket automático tras cobrar en el POS. Quick-link Ventas en dashboard. Con esto Hito 2 (POS) queda completo.
- **Hito 2 — POS operativo (núcleo):** página `/pos` con búsqueda de productos, carrito (Zustand) con cantidades y descuentos, descuento global, total y cobro. RPCs atómicas `create_sale` (venta + items + descuento de stock + movimiento de caja + número correlativo, requiere turno abierto), `open_cash_shift` y `close_cash_shift` (arqueo con diferencia). Apertura/cierre de caja desde el POS, medios de pago (efectivo con vuelto, débito/crédito/transferencia/QR). Bloqueo de venta sin caja abierta. Quick-links POS/Productos en dashboard.
- **Backbone operativo (capa DB Hito 2/3):** tablas `stores`, `cash_registers`, `cash_shifts`, `cash_movements`, `sales`, `sale_items`, `payments` con RLS por tenant, defaults `tenant_id`/`created_by`, `cash_shifts.difference` calculada, auditoría en sales/payments/cash_shifts/cash_movements y FK `stock_movements.store_id`. `create_tenant` ahora siembra sucursal + caja por defecto. (Tipos TS de estas tablas se regeneran al implementar el POS.)
- **Hito 1 cerrado:** historial de movimientos de stock por producto (modal en `/productos`).
- **Hito 1 — Catálogo (UI + lógica):** módulo `products` (schemas Zod, api, hooks TanStack Query), página `/productos` con lista, búsqueda (nombre/SKU/barcode), alta/edición (modal), baja lógica, categorías 1 nivel con alta inline, y ajuste de stock con motivo vía RPC atómica `adjust_product_stock` (transacción única, RLS-safe). Defaults `tenant_id = current_tenant_id()` / `created_by = auth.uid()` en `categories`/`products`. Quick-link a Productos desde el dashboard.
- Upgrade `@supabase/supabase-js` → 2.106 y `@supabase/ssr` → 0.10 (alinea tipos generados PostgREST 14.5; los writes tipaban como `never` con la versión previa).
- **Onboarding de tenant (cierre de Hito 0):** Edge Function `create_tenant` (crea tenant trial 14d + subscription plan Start + `tenant_users` owner, setea `app_metadata.current_tenant_id`, audita) y UI `/onboarding` (form negocio + rubro, refresca sesión). Empty-state del dashboard ahora linkea al alta. Desbloquea la RLS por tenant para todo el producto.
- **Hito 1 — Catálogo (capa DB):** tablas `categories`, `products`, `stock_movements` con RLS de aislamiento por tenant, índices (SKU/barcode únicos parciales, nombre, categoría), `updated_at` automático y triggers de auditoría en `products` y `stock_movements`. Tipos regenerados. Aplicado a dev/staging; advisors sin lints de tablas (queda pendiente activar leaked-password-protection en Auth).

- **Esquema base de BD (Hito 0)** aplicado al proyecto Supabase dev/staging y versionado en `supabase/migrations/`:
  - Tablas: `tenants`, `users` (espejo de `auth.users`), `tenant_users`, `plans`, `subscriptions`, `feature_flags`, `tenant_feature_flags`, `system_settings`, `audit_logs`.
  - Funciones helper: `current_tenant_id()`, `is_internal()`, `set_updated_at()`, `write_audit_log()`, `handle_new_user()`.
  - RLS habilitada en las 9 tablas + 11 policies (aislamiento por tenant, lectura pública de planes/flags, `audit_logs` append-only).
  - Triggers de auditoría en `tenant_users`, `subscriptions`, `tenant_feature_flags`; `updated_at` automático.
  - Seed idempotente (`supabase/seed.sql`): 4 planes + catálogo de 14 feature flags. Precios en 0 (placeholder, definir antes de producción).
  - Hardening: `search_path` fijo en helpers, `handle_new_user` sin EXECUTE público. Linter de seguridad sin findings.
  - `types/database.ts` generado desde el esquema.
- ADR-009: resolución de `current_tenant_id()` vía `app_metadata.current_tenant_id`.
- Estructura inicial del proyecto: `docs/`, `.claude/agents/`, `supabase/`.
- Documentación del MVP, arquitectura, base de datos, multi-tenant, seguridad, AFIP, planes y feature flags.
- Sistema de subagentes para Claude Code: Project Manager + 11 especialistas.
- ADRs iniciales (ADR-001 a ADR-008).
- Workflows documentados: Git, agentes, releases.
- `CLAUDE.md` con contexto maestro para Claude Code.

---

## [0.1.0] - 2026-01-15

Primer commit del repo. Setup de documentación, agentes y convenciones. Sin código de aplicación todavía.

### Added

- Repositorio inicializado.
- Documentación base.
- Estructura de agentes.

---

## Plantilla para próximas versiones

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- Funcionalidad nueva.

### Changed
- Cambios en funcionalidad existente.

### Deprecated
- Lo que se va a remover en próximas versiones.

### Removed
- Lo que se removió en esta versión.

### Fixed
- Bugs corregidos.

### Security
- Fixes o mejoras de seguridad.
```
