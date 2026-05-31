# Centro de notificaciones por cuenta

Documento de referencia para notificaciones in-app, banners y comunicaciones operativas dentro de cada tenant. Complementa [`16-subscription-model.md`](./16-subscription-model.md), [`24-internal-ops-panel.md`](./24-internal-ops-panel.md) y H13b del roadmap.

## 1. Objetivo

Cada cuenta debe tener un panel claro de novedades y alertas. El cliente no debe enterarse solo por email de cambios importantes: vencimientos, cobros, aumentos, cambios de plan, límites de uso, mantenimiento, AFIP, seguridad y nuevas funciones deben quedar visibles dentro del producto.

## 2. Tipos de notificación

- [ ] **Plan y suscripción:** cambio de plan, plan custom creado, aumento programado, aumento aplicado, downgrade, upgrade, módulo agregado.
- [ ] **Cobros:** pago recibido, pago pendiente, deuda, vencimiento próximo, factura/recibo disponible, suspensión inminente, reactivación.
- [ ] **Uso y cuotas:** límite de usuarios/sucursales/cajas/productos/ventas al 80%, 100% y 110%.
- [ ] **Novedades:** nueva función, mejora relevante, cambio de UI, promoción comercial.
- [ ] **Operación:** caja sin cerrar, errores críticos, cola fiscal bloqueada, venta offline pendiente, hardware fallando.
- [ ] **AFIP/ARCA:** certificado por vencer, modo homologación, contingencia activa, comprobantes rechazados, cola fiscal bloqueada.
- [ ] **Seguridad:** nuevo login, cambio de rol, invitación aceptada, password reset, acceso de soporte NinjaSoft.
- [ ] **Mantenimiento:** ventana programada, incidente activo, servicio recuperado.
- [ ] **Soporte:** respuesta de soporte, solicitud de datos, cierre de caso.

## 3. Audiencia

- [ ] Owner.
- [ ] Manager.
- [ ] Cashier.
- [ ] Viewer.
- [ ] Todos.
- [ ] Usuario específico.
- [ ] Sucursal/caja específica.
- [ ] Profesional/mozo/vendedor específico cuando aplique.

Regla: las notificaciones comerciales y de billing van a `owner` y, opcionalmente, `manager`. Las alertas operativas pueden ir a roles operativos.

## 4. Estados

- [ ] `unread`: no leída.
- [ ] `read`: leída.
- [ ] `archived`: archivada.
- [ ] `action_required`: requiere acción.
- [ ] `resolved`: acción completada.
- [ ] `expired`: vencida.
- [ ] `dismissed`: descartada por usuario cuando se permite.

## 5. Severidad

- [ ] `info`: novedad o mensaje general.
- [ ] `success`: pago recibido, reactivación, configuración completada.
- [ ] `warning`: vencimiento próximo, límite al 80/100%, certificado por vencer.
- [ ] `critical`: suspensión inminente, cola fiscal bloqueada, pago vencido.
- [ ] `blocking`: estado que bloquea operación o requiere acción obligatoria.

## 6. Canales

- [ ] In-app inbox.
- [ ] Banner persistente.
- [ ] Modal obligatorio para cambios críticos.
- [ ] Email.
- [ ] WhatsApp futuro.
- [ ] Push futuro.
- [ ] Webhook futuro para Enterprise.

Regla: eventos críticos siempre generan in-app. Email/WhatsApp son adicionales, no reemplazo.

## 7. Acciones embebidas

- [ ] Pagar ahora.
- [ ] Ver deuda.
- [ ] Descargar recibo/factura.
- [ ] Aceptar cambio de plan/precio.
- [ ] Solicitar revisión.
- [ ] Contactar soporte.
- [ ] Actualizar datos fiscales.
- [ ] Resolver cola fiscal.
- [ ] Renovar certificado.
- [ ] Ver detalle del cambio.

## 8. Panel dentro de la cuenta

Ubicaciones esperadas:

- [ ] Campana global en header.
- [ ] Inbox `/notificaciones`.
- [ ] Banners contextuales en dashboard/POS/configuración.
- [ ] Panel de billing/suscripción con historial de avisos.
- [ ] Centro de ayuda/soporte con mensajes relacionados.

Filtros:

- [ ] No leídas.
- [ ] Requiere acción.
- [ ] Billing.
- [ ] Plan.
- [ ] AFIP.
- [ ] Seguridad.
- [ ] Operación.
- [ ] Novedades.

## 9. Internal composer

Desde internal:

- [ ] Crear notificación para un tenant.
- [ ] Crear notificación para segmento.
- [ ] Usar plantilla.
- [ ] Programar envío.
- [ ] Definir expiración.
- [ ] Definir audiencia y canal.
- [ ] Asociar acción.
- [ ] Preview antes de enviar.
- [ ] Ver métricas de lectura/click.
- [ ] Reenviar por email si no fue leída.

## 10. Modelo de datos objetivo

```sql
account_notifications (
  id uuid primary key,
  tenant_id uuid not null,
  type text not null,
  severity text not null,
  title text not null,
  body text not null,
  action_label text,
  action_url text,
  metadata jsonb,
  starts_at timestamptz,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz
)

account_notification_recipients (
  id uuid primary key,
  notification_id uuid not null,
  user_id uuid,
  role text,
  store_id uuid,
  status text not null,
  read_at timestamptz,
  archived_at timestamptz,
  action_completed_at timestamptz
)

notification_delivery_logs (
  id uuid primary key,
  notification_id uuid not null,
  channel text not null,
  recipient text,
  status text not null,
  provider text,
  error text,
  sent_at timestamptz
)
```

## 11. Eventos automáticos obligatorios

- [ ] Trial iniciado.
- [ ] Trial por vencer.
- [ ] Trial vencido.
- [ ] Pago pendiente.
- [ ] Pago recibido.
- [ ] Suspensión inminente.
- [ ] Suspensión aplicada.
- [ ] Reactivación.
- [ ] Cambio de plan.
- [ ] Plan custom creado.
- [ ] Aumento de cuota/precio programado.
- [ ] Aumento de cuota/precio aplicado.
- [ ] Límite de uso al 80/100/110%.
- [ ] Feature nueva activada.
- [ ] Staff NinjaSoft accedió con modo soporte.
- [ ] Certificado AFIP por vencer.
- [ ] Cola fiscal bloqueada.

## 12. Criterios de cierre

- [ ] Owner ve campana con contador de no leídas.
- [ ] Owner abre inbox, filtra billing y marca notificación como leída.
- [ ] Aumento de precio programado genera aviso in-app + email.
- [ ] Cambio de plan muestra antes/después y quién lo realizó.
- [ ] Notificación crítica no se puede descartar hasta resolver acción.
- [ ] Internal ve métricas de lectura/click por notificación.
- [ ] Todo envío queda auditado y trazable.
