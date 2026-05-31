# Panel internal NinjaSoft

Documento de referencia para el panel interno donde NinjaSoft gestiona tenants, suscripciones, staff, soporte, feature flags, invitaciones y operación comercial del SaaS.

## 1. Principio

El panel internal debe permitir operar NinjaSoft POS sin tocar SQL ni Supabase manualmente. Es una consola separada del POS del cliente: el staff puede entrar directo a `/internal`, autenticarse si no tiene sesión y volver al panel interno sin pasar por `/dashboard`.

Reglas base:

- [x] `/internal` redirige a `/internal/tenants`.
- [x] Si no hay sesión, `/internal/*` redirige a `/login?next=/internal/tenants`.
- [x] Al loguearse con `next=/internal/tenants`, vuelve al panel internal.
- [ ] El login debe mostrar modo "Acceso interno" cuando el destino sea `/internal`.
- [ ] Usuarios no internos nunca ven rutas internal; se redirigen al dashboard del tenant.
- [ ] Toda acción internal sensible exige motivo y queda en `audit_logs`.

## 2. Roles internos

Modelo actual:

- [ ] `super_admin`: control total, asigna/quita staff, cambios peligrosos.
- [ ] `admin`: opera tenants, planes, flags y soporte; no puede cambiar staff crítico ni borrar tenants.
- [ ] `support`: solo lectura + acciones de soporte acotadas con motivo.

Extensión objetivo:

- [ ] `sales`: alta comercial, trials, upgrades, reactivaciones y notas comerciales; no ve datos operativos sensibles salvo resumen.
- [ ] `billing`: pagos, deuda, recibos internos, vencimientos, suspensión/reactivación por cobranza.
- [ ] `developer`: logs, flags técnicos, health, debugging; no cambia plan/precio.
- [ ] `support_lead`: soporte avanzado, acceso temporal a tenant e impersonation controlada.

## 3. Login y navegación

- [ ] Ruta directa `/internal`.
- [ ] Ruta directa `/internal/tenants`.
- [ ] Ruta futura opcional `/internal/login` o variante visual de `/login?next=/internal/tenants`.
- [ ] Header internal separado del POS con indicador "Interno".
- [ ] Buscador global siempre visible.
- [ ] Menú: Dashboard, Tenants, Suscripciones, Staff, Invitaciones, Flags, Soporte, Auditoría, Billing, Salud.
- [ ] Logout claro y cambio de contexto seguro.

## 4. Dashboard internal

- [ ] Tenants totales, activos, trial, past_due, suspendidos, cancelados.
- [ ] MRR, ARR, ARPA, churn, conversión trial→paid, upgrades/downgrades.
- [ ] Trials por vencer.
- [ ] Pagos pendientes/deuda.
- [ ] Tenants con errores críticos.
- [ ] Cola fiscal con pendientes/bloqueados si AFIP está activo.
- [ ] Alertas de uso: límite de usuarios, sucursales, ventas, productos o features.
- [ ] Actividad reciente del staff.

## 5. Tenants y ficha 360

Listado:

- [ ] Buscar por nombre, slug, CUIT, owner email, teléfono, plan, estado, rubro, fecha de alta.
- [ ] Filtros por estado, plan, módulo activo, health, provincia, rubro.
- [ ] Orden por MRR, última venta, alta, vencimiento, deuda, actividad.
- [ ] Export XLSX del listado.

Ficha:

- [ ] Datos comerciales: nombre, slug, rubro, CUIT, IVA, contacto, provincia, localidad.
- [ ] Plan y suscripción actual.
- [ ] Owners y usuarios.
- [ ] Sucursales, cajas y módulos activos.
- [ ] Ventas últimas 24h/7d/30d.
- [ ] Último login, último cobro, último error.
- [ ] Feature flags y overrides.
- [ ] Notas internas y timeline.
- [ ] Audit log filtrado del tenant.

## 6. Suscripciones y billing

- [ ] Cambiar plan.
- [ ] Cambiar estado: trial, active, past_due, suspended, cancelled.
- [ ] Extender trial.
- [ ] Registrar pago manual.
- [ ] Registrar deuda/pago pendiente.
- [ ] Definir vencimiento de período.
- [ ] Precio acordado y descuento manual con vigencia.
- [ ] Motivo obligatorio en downgrade, suspensión, cancelación o descuento.
- [ ] Historial de cambios con antes/después.
- [ ] Email/plantilla pendiente o enviado por cada transición.

## 7. Staff NinjaSoft

- [ ] Listar staff interno.
- [ ] Invitar staff nuevo por email.
- [ ] Convertir usuario existente en staff.
- [ ] Cambiar rol/nivel interno.
- [ ] Suspender/reactivar staff.
- [ ] Quitar staff sin dejar el sistema sin `super_admin`.
- [ ] Ver actividad y acciones recientes de cada staff.
- [ ] Requerir MFA para roles críticos cuando se active.

## 8. Invitaciones y usuarios de tenant

Desde internal se debe poder:

- [ ] Invitar owner, manager, cashier o viewer a un tenant.
- [ ] Reenviar invitación.
- [ ] Revocar invitación pendiente.
- [ ] Cambiar rol dentro del tenant.
- [ ] Suspender/reactivar miembro.
- [ ] Resetear password o forzar recuperación.
- [ ] Crear perfil sin login cuando el rubro lo permita.
- [ ] Ver invitaciones pendientes, expiradas y aceptadas.
- [ ] Auditar quién hizo cada cambio y por qué.

## 9. Feature flags y módulos

- [ ] Activar/desactivar flag por tenant.
- [ ] Ver valor default, override y valor efectivo.
- [ ] Activar paquetes de módulos por plan/rubro.
- [ ] Programar activación/desactivación futura.
- [ ] Comentario/motivo por override.
- [ ] Historial de cambios.
- [ ] Preview de impacto antes de guardar.

## 10. Soporte e impersonation

- [ ] Abrir contexto de tenant solo con motivo.
- [ ] Sesión temporal con expiración.
- [ ] Banner visible "Modo soporte".
- [ ] Registro en audit log visible para NinjaSoft y, cuando aplique, para el cliente.
- [ ] Modo solo lectura por default.
- [ ] Elevación temporal a acciones de soporte con autorización.
- [ ] Prohibido acceder a secretos, tokens o datos fiscales sensibles sin permiso específico.

## 11. Seguridad

- [ ] `service_role` solo en Edge Functions/RPC server-side.
- [ ] RLS permite lectura internal controlada; escrituras sensibles pasan por funciones auditadas.
- [ ] Acciones peligrosas con confirmación fuerte.
- [ ] No se puede quitar el último `super_admin`.
- [ ] Rate limit en invitaciones y cambios de staff.
- [ ] MFA obligatorio para `super_admin` antes de producción.
- [ ] Exportaciones internal quedan auditadas.

## 12. Criterios de cierre

- [ ] Staff entra directo por `/internal` sin sesión previa, se loguea y vuelve al panel internal.
- [ ] Super-admin invita staff, convierte usuario existente en admin interno y suspende un staff.
- [ ] Admin cambia plan/estado de suscripción con motivo y queda auditado.
- [ ] Support abre contexto de tenant con motivo, sin poder cambiar plan ni borrar datos.
- [ ] Sales extiende trial y registra nota comercial sin acceder a datos sensibles.
- [ ] Billing registra pago manual y próxima fecha de vencimiento.
- [ ] Internal invita usuario a tenant, reenvía invitación y cambia rol.
- [ ] Todo cambio aparece en audit log con actor, fecha, antes/después y motivo.
