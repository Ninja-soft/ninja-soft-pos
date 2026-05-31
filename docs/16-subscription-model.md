# Modelo de Suscripciones — NinjaSoft POS

Define los planes comerciales, sus límites, los estados de la suscripción y cómo se reflejan en código y BD.

## 1. Planes

| Plan | Sucursales | Usuarios | POS | AFIP | Multi-caja | Promociones | API | Soporte |
|---|---|---|---|---|---|---|---|---|
| **Start** | 1 | 3 | ✅ | ❌ | ❌ | ❌ | ❌ | Email |
| **Pro** | 3 | 10 | ✅ | ✅ | ✅ | ❌ | ❌ | Email + chat |
| **Business** | 10 | 30 | ✅ | ✅ | ✅ | ✅ | ❌ | Prioritario |
| **Enterprise** | A medida | A medida | ✅ | ✅ | ✅ | ✅ | ✅ | Dedicado |

Los precios de lista viven fuera de este documento, pero el modelo debe soportar condiciones comerciales por cliente: plan custom, cuota/precio acordado, add-ons, descuentos, aumentos programados, límites especiales y medición de uso. La especificación enterprise completa vive en [`27-commercial-configuration-engine.md`](./27-commercial-configuration-engine.md).

## 2. Estados de suscripción

```
   ┌──────┐
   │ NEW  │  ← tenant recién creado, sin pago
   └──┬───┘
      │ trial inicia automático
      ▼
   ┌──────┐
   │TRIAL │  ← 14 días gratis
   └──┬───┘
      │
      ├──── pago confirmado ────▶ ┌────────┐
      │                            │ ACTIVE │
      ├──── pago no llegó ────▶   └───┬────┘
      │     (vence trial)              │
      ▼                                ▼
   ┌──────────┐               ┌─────────────┐
   │ SUSPENDED│ ◀────────────│ PAYMENT_DUE │
   └────┬─────┘    no paga    └─────────────┘
        │
        │ cliente renueva
        ▼
   ┌────────┐
   │ ACTIVE │
   └───┬────┘
       │
       │ cliente cancela
       ▼
   ┌───────────┐
   │ CANCELLED │  ← lectura, 90 días de gracia
   └───────────┘
```

### 2.1 Implicancias por estado

| Estado | Puede usar POS | Puede ver datos | Comunicación |
|---|---|---|---|
| `new` | ❌ | ❌ | Onboarding |
| `trial` | ✅ | ✅ | Recordatorios |
| `active` | ✅ | ✅ | Normal |
| `payment_due` | ✅ (con banner) | ✅ | Aviso de pago pendiente |
| `suspended` | ❌ | ✅ (solo lectura) | Aviso urgente |
| `cancelled` | ❌ | ✅ (90 días) | Confirmación de baja |

## 3. Modelo de datos

Ver detalle en [`04-database.md`](./04-database.md). Resumen:

```sql
plans (
  id, key, name, description,
  features jsonb,                -- límites concretos
  is_active boolean,
  created_at
)

subscriptions (
  id, tenant_id, plan_id,
  status,                        -- new, trial, active, payment_due, suspended, cancelled
  trial_started_at,
  trial_ends_at,
  current_period_start,
  current_period_end,
  cancelled_at,
  cancellation_reason,
  created_at, updated_at
)
```

Un tenant tiene una sola suscripción activa a la vez. Cambios de plan generan un nuevo registro en `subscription_history` (auditoría).

### 3.1 Extensión para planes custom y cuotas por cliente

```sql
tenant_plan_overrides (
  id, tenant_id, base_plan_id,
  display_name,                 -- "Pro Heladería Lucas", "Enterprise Franquicia"
  limits_override jsonb,         -- max_users, max_stores, max_products, etc.
  modules_override jsonb,        -- flags/módulos incluidos para este cliente
  support_override jsonb,        -- SLA, canal, ejecutivo asignado
  price_amount numeric,
  currency text,                 -- ARS por default
  billing_cycle text,            -- monthly, yearly, custom
  valid_from, valid_until,
  reason,
  created_by, created_at
)

subscription_price_changes (
  id, tenant_id, subscription_id,
  previous_amount, new_amount,
  previous_limits jsonb, new_limits jsonb,
  effective_at,
  notice_sent_at,
  accepted_at,
  status,                       -- scheduled, notified, accepted, applied, cancelled
  reason,
  created_by, created_at
)
```

Reglas:

- [ ] Un plan custom siempre referencia un plan base para heredar defaults.
- [ ] Los overrides por cliente ganan sobre el plan base, pero quedan auditados.
- [ ] Los límites custom pueden aumentar o reducir cuota: usuarios, sucursales, cajas, productos, ventas mensuales, almacenamiento, módulos y soporte.
- [ ] Los add-ons agregan módulos o capacidad sin crear un plan global nuevo.
- [ ] Los entitlements efectivos se calculan desde plan base + add-ons + override + feature flags.
- [ ] El uso se mide con eventos y contadores recalculables para evitar cuotas inconsistentes.
- [ ] Todo aumento de precio/cuota tiene fecha efectiva y motivo.
- [ ] Si el contrato exige aviso/aceptación, el cambio queda `scheduled` hasta notificación/aceptación.
- [ ] El owner recibe notificación in-app y email cuando hay cambio de precio, cuota, plan o vencimiento.

### 3.2 Add-ons y usage metering

Add-ons iniciales:

- [ ] Sucursal adicional.
- [ ] Caja adicional.
- [ ] Usuario adicional.
- [ ] Paquete de ventas mensuales.
- [ ] AFIP/facturación electrónica.
- [ ] Gastronomía PRO.
- [ ] Servicios/agenda.
- [ ] API/webhooks.
- [ ] Soporte prioritario.

Uso medible:

- [ ] Usuarios activos.
- [ ] Sucursales/cajas activas.
- [ ] Productos/clientes activos.
- [ ] Ventas/comprobantes por período.
- [ ] Almacenamiento.
- [ ] Emails/notificaciones.
- [ ] API calls/webhooks.

Políticas de exceso:

- [ ] Aviso al 80%.
- [ ] Aviso fuerte al 100%.
- [ ] Grace period configurable.
- [ ] Cargo por excedente si el contrato lo permite.
- [ ] Bloqueo gradual solo para acciones no críticas.

## 4. Estructura de `plans.features`

JSON con límites y banderas concretas:

```json
{
  "limits": {
    "max_stores": 1,
    "max_users": 3,
    "max_products": 5000,
    "max_sales_per_month": 10000
  },
  "modules": {
    "pos": true,
    "afip_integration": false,
    "multi_branch": false,
    "advanced_promotions": false,
    "api_access": false,
    "customer_credit": false,
    "loyalty_program": false,
    "whatsapp_notifications": false
  },
  "support": {
    "level": "email",
    "response_sla_hours": 48
  }
}
```

## 5. Aplicación de límites

### 5.1 Hard limits
Bloqueo absoluto en Edge Function:

```typescript
const subscription = await getActiveSubscription(tenantId)
const plan = await getPlan(subscription.plan_id)

if (currentUserCount(tenantId) >= plan.features.limits.max_users) {
  return errorResponse(403, 'plan_limit_exceeded', 'Máximo de usuarios alcanzado para el plan actual')
}
```

### 5.2 Soft limits
Aviso al usuario pero permite operar:
- 90% del límite: aviso amarillo.
- 100%: aviso rojo + sugerencia de upgrade.
- 110%: bloqueo en próxima acción.

Aplica a `max_products`, `max_sales_per_month`.

### 5.3 Features habilitados
Lectura directa de `plan.features.modules.<key>` desde Edge Functions y frontend (vía hook `useSubscriptionFeatures`).

## 6. Cambios de plan

### 6.1 Upgrade
- Inmediato. Features nuevos disponibles al instante.
- No requiere migración de datos.
- Auditoría obligatoria.

### 6.2 Downgrade
- Solo si se cumple con los límites del nuevo plan:
  - Si tiene 8 usuarios y baja a Start (max 3), pide eliminar 5 antes.
- Features que se pierden se deshabilitan (UI oculta, Edge Functions rechazan).
- Datos no se pierden (productos, ventas, etc.).
- Aviso al cliente de qué pierde antes de confirmar.

### 6.3 Cambio efectivo
- Toma efecto al instante.
- Facturación: prorrateada al final del período o ajustada en próxima factura (decisión comercial).

### 6.4 Plan específico por cliente

Un plan específico permite vender condiciones especiales sin crear un plan global visible para todos.

Casos:

- [ ] Cliente grande necesita 7 sucursales, 18 usuarios y AFIP, pero no Business completo.
- [ ] Cliente paga precio promocional por 6 meses.
- [ ] Cliente tiene módulo gastronómico incluido pero sin API.
- [ ] Franquicia con límites y soporte propios.
- [ ] Acuerdo manual con cuota mensual distinta al precio de lista.

Requisitos:

- [ ] Crear desde internal a partir de un plan base.
- [ ] Nombre visible opcional para cliente.
- [ ] Nombre interno comercial.
- [ ] Límites y módulos editables.
- [ ] Precio, moneda y ciclo de cobro editables.
- [ ] Vigencia opcional.
- [ ] Motivo obligatorio.
- [ ] Historial de cambios.
- [ ] Notificación automática al owner.

### 6.5 Aumento de cuota/precio a un cliente

Flujo:

1. Staff autorizado crea cambio programado desde internal.
2. Define nuevo precio/cuota/límites, fecha efectiva, motivo y si requiere aceptación.
3. El sistema genera notificación in-app + email.
4. Si requiere aceptación, el owner acepta o contacta soporte.
5. En `effective_at`, el cambio se aplica y se registra en historial.

Reglas:

- [ ] No se pisa el precio actual sin guardar `previous_amount`.
- [ ] No se aplica un aumento silencioso sin notificación.
- [ ] Cambios inmediatos requieren permiso `billing` o `super_admin`.
- [ ] Todo cambio queda en `subscription_price_changes` y `audit_logs`.
- [ ] Si el cliente está `suspended` o `cancelled`, el cambio queda pendiente hasta reactivación o se cancela explícitamente.

## 7. Trial

- Default: 14 días.
- Configurable por plan (`plans.trial_days`).
- Inicia automáticamente al alta del tenant.
- 7 días antes del fin: email de recordatorio.
- 1 día antes: email + banner en la app.
- Al vencer sin pago: pasa a `suspended` después de 3 días de gracia (`payment_due`).

## 8. Suspensión por falta de pago

- Pasa a `payment_due` al vencer el período sin pago confirmado.
- 3 días de gracia con banner persistente.
- Al día 4: `suspended`. POS bloqueado, solo lectura.
- Al día 30 en `suspended`: oferta de cancelación voluntaria.
- Al día 60 en `suspended`: cancelación forzada con respaldo de datos.

## 9. Cancelación

### 9.1 Cliente cancela voluntariamente
- Confirmación con motivo (encuesta opcional).
- Acceso de lectura por 90 días.
- Backup descargable.
- Después de 90 días: archivo en cold storage, eliminación física a 1 año.

### 9.2 Reactivación
- Hasta 90 días post-cancelación: un click reactiva.
- Después de 90 días: alta nueva, datos no se restauran automáticamente.

## 10. Edge cases

### 10.1 Tenant sin suscripción
No debe existir en producción. Si pasa: logear, marcar como `new`, pedir intervención manual.

### 10.2 Plan eliminado
Los planes no se eliminan, se marcan `is_active = false`. Suscripciones existentes siguen funcionando. Nuevos altas no pueden elegirlo.

### 10.3 Cambio masivo de precios
- Se respeta el precio acordado en `subscription.current_period_start` hasta el final del período.
- Próximo período: precio actualizado con aviso 60 días antes.

## 11. Facturación

**Fuera del alcance del MVP de F2.** En F2, las suscripciones se gestionan manualmente:
- Marca como `active` cuando confirmamos pago manual (transferencia, MP).
- No integramos con un gateway de pago hasta F4.

### 11.1 Plan de integración futura (F4+)
- **Mercado Pago Subscriptions** o **Stripe**.
- Webhook recibe eventos de pago.
- Actualización automática de estado.
- Reintentos automáticos para tarjetas.

## 12. Métricas comerciales

Calculadas en dashboard interno (F2+):
- **MRR** (Monthly Recurring Revenue).
- **ARR** (Annual Recurring Revenue).
- **Churn rate** mensual.
- **LTV** (Customer Lifetime Value).
- **CAC** (Customer Acquisition Cost) — manual.
- **Trial → Paid conversion rate**.
- **Upgrade rate** (Start → Pro, Pro → Business, etc.).

## 13. Permisos relacionados

| Acción | Quién |
|---|---|
| Cambiar plan | Owner del tenant, `super_admin` interno, `sales` interno. |
| Cancelar suscripción | Owner. Notificación a NinjaSoft. |
| Suspender manualmente | `super_admin` interno (con motivo). |
| Reactivar | `super_admin`, `sales`. |
| Modificar precio | `super_admin` (no debería pasar, hay precios fijos por plan). |

## 13.1 Operación desde panel internal

La consola internal debe concentrar toda la operación de suscripciones sin SQL:

- [ ] Alta de tenant y asignación de plan inicial.
- [ ] Cambio de plan inmediato.
- [ ] Creación de plan específico/custom para un tenant.
- [ ] Edición de cuota/límites/módulos/precio por cliente.
- [ ] Aumento de precio/cuota inmediato o programado.
- [ ] Cambio de estado con motivo: `trial`, `active`, `past_due`, `suspended`, `cancelled`.
- [ ] Extensión o acorte de trial.
- [ ] Registro de pago manual: fecha, medio, monto, período cubierto y referencia.
- [ ] Registro de deuda o pago pendiente.
- [ ] Próxima fecha de vencimiento.
- [ ] Precio acordado/descuento comercial con vigencia.
- [ ] Notas comerciales internas.
- [ ] Historial completo con antes/después, actor, fecha y motivo.
- [ ] Email/plantilla asociada a cada transición.
- [ ] Notificación in-app asociada a cada evento comercial relevante.

Ver [`24-internal-ops-panel.md`](./24-internal-ops-panel.md).

## 14. Comunicación al cliente

Templates de email e in-app notification (a definir en F2):
- Bienvenida + inicio de trial.
- 7 días para que termine trial.
- 1 día para que termine trial.
- Trial terminó, pago pendiente.
- Pago recibido, suscripción activa.
- Factura del mes.
- Plan actualizado.
- Plan custom creado.
- Cuota/límite actualizado.
- Aumento de precio programado.
- Aumento de precio aplicado.
- Límite de uso al 80/100/110%.
- Suspensión inminente.
- Suspensión activa.
- Reactivación.
- Cancelación confirmada.

Todos siguen guidelines de `UI-NinjaSof.md` sección 22 (Email Templates).
