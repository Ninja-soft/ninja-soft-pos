# Changelog

Todos los cambios relevantes de NinjaSoft POS quedan registrados acá.

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado: [Semver](https://semver.org/lang/es/).

---

## [Unreleased]

### Added

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
