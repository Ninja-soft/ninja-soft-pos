# Observabilidad — NinjaSoft POS

Cómo sabemos qué está pasando: logs, métricas, alertas y trazabilidad. Sin esto, un POS en producción es una bomba de tiempo.

## 1. Principios

1. **Si rompe en producción y nos enteramos por el cliente, fallamos.**
2. **Cada error tiene contexto suficiente para arreglarlo sin pedirle al cliente que reproduzca.**
3. **Las métricas se miden, no se intuyen.** "Va bien" no es una métrica.
4. **Los logs son útiles o no son.** No `console.log("aquí 1")`.

## 2. Capas de observabilidad

| Capa | Herramienta | Qué captura |
|---|---|---|
| Errores frontend | Sentry (Fase 4) | Excepciones JS, errores de render, errores no manejados. |
| Performance frontend | Vercel Analytics + Sentry | Core Web Vitals, transacciones. |
| Logs server-side | Vercel logs + Supabase logs | Requests, errores de SSR, Edge Functions. |
| Logs estructurados | Pino / Winston en Edge Functions | Eventos de negocio. |
| Métricas custom | Tabla `metrics` + dashboard interno | Ventas/hora, tiempo de cobro, etc. |
| Audit log | Tabla `audit_logs` | Quién hizo qué, cuándo. |
| Uptime | UptimeRobot o similar | Salud de endpoints públicos. |

## 3. Logs estructurados

Todo log en Edge Functions es JSON con campos consistentes:

```typescript
log.info({
  event: 'sale_created',
  tenant_id: tenantId,
  user_id: userId,
  sale_id: saleId,
  total: total,
  duration_ms: durationMs,
  request_id: requestId,
})
```

### 3.1 Niveles
- `error`: algo falló y requiere atención.
- `warn`: algo inesperado pero recuperado.
- `info`: evento de negocio importante.
- `debug`: solo en desarrollo.

### 3.2 Campos obligatorios
- `timestamp` (auto).
- `level`.
- `event` (qué pasó).
- `tenant_id` cuando aplica.
- `user_id` cuando aplica.
- `request_id` (correlación con request HTTP).

### 3.3 Lo que NO se loggea
- Contraseñas (obvio).
- Tokens, JWTs, claves.
- Datos de tarjetas (no los manejamos, igual).
- CUITs completos en logs no críticos (truncar a últimos 4).
- Datos sensibles de clientes finales sin necesidad operativa.

## 4. Errores en frontend

### 4.1 Sentry setup (Fase 4)

```typescript
// app/sentry.ts
import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.APP_ENV,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 1.0,
  beforeSend(event) {
    // Filtrar PII
    if (event.user?.email) {
      event.user.email = hash(event.user.email)
    }
    return event
  },
})
```

### 4.2 ErrorBoundary

Componente raíz envuelve la app en un boundary que reporta a Sentry y muestra UI amable.

```tsx
<ErrorBoundary fallback={<AppErrorScreen />}>
  <App />
</ErrorBoundary>
```

### 4.3 Errores manejados
Toda mutación con `useMutation` tiene `onError` que muestra toast + reporta a Sentry si es inesperado.

## 5. Métricas de negocio

Tabla `metrics_events` (append-only, particionada por mes):

```sql
create table metrics_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  event_type text not null,
  payload jsonb,
  created_at timestamptz default now()
) partition by range (created_at);
```

### 5.1 Eventos clave (MVP)

| Event | Cuándo | Payload |
|---|---|---|
| `user_login` | Login exitoso | `{ method, device }` |
| `sale_started` | Apertura del POS | `{ store_id }` |
| `sale_completed` | Venta confirmada | `{ sale_id, total, items_count, duration_ms }` |
| `sale_voided` | Anulación | `{ sale_id, reason, voided_by }` |
| `cash_shift_opened` | Apertura de caja | `{ cash_register_id, opening_amount }` |
| `cash_shift_closed` | Cierre de caja | `{ shift_id, expected, actual, diff }` |
| `product_search` | Búsqueda de producto | `{ query, results_count, selected_index }` |
| `error_displayed` | Error visible al usuario | `{ error_code, page }` |

### 5.2 Dashboard interno

A partir de Fase 2, dashboard con:
- Tenants activos (DAU/MAU).
- Ventas totales por hora del día.
- Tiempo promedio de cobro.
- Tasa de error por endpoint.
- Latencia p50/p95/p99 de Edge Functions críticas.
- Salud de integraciones (AFIP, MP).

## 6. Alertas

### 6.1 Críticas (acción inmediata, 24/7)
- Error rate > 5% en Edge Functions de venta.
- Edge Function `create_sale` p95 > 2s.
- Cualquier alerta de seguridad (intentos de bypass de RLS).
- AFIP rechazos > 20% en 15 min.
- Supabase down.

### 6.2 Altas (horario hábil, < 4hs)
- Error rate > 2% en cualquier endpoint.
- Latencia p95 > 1s sostenida.
- Anulaciones > 10% del total de ventas (puede indicar bug).

### 6.3 Medias (próximo día hábil)
- Cobertura de tests bajó.
- Build time > 5 min.
- Bundle size aumentó > 10%.

### 6.4 Canales
- Críticas: Slack `#alerts-critical` + email + (Fase 3) PagerDuty.
- Altas: Slack `#alerts`.
- Medias: ticket en GitHub.

## 7. Trazabilidad de un request

Cada request entrante (frontend → Edge Function) tiene un `request_id` UUID generado en el primer hop. Se propaga en:
- Header `X-Request-Id`.
- Logs de Vercel.
- Logs de Edge Function.
- Si hay llamada a AFIP/MP/etc, se incluye en el body o header.

Para investigar un incidente:
1. Cliente reporta error con código (mostrado en UI: "Error E1234. Contactá soporte.").
2. Buscamos en logs por `request_id` o `error_code`.
3. Reconstruimos la cadena completa en < 5 minutos.

## 8. Audit logs vs metrics events

| Característica | `audit_logs` | `metrics_events` |
|---|---|---|
| Propósito | Trazabilidad legal/seguridad | Análisis y métricas |
| Granularidad | Solo eventos importantes | Cualquier evento útil |
| Inmutabilidad | Absoluta | Pueden purgar después de N meses |
| Quién lo lee | Compliance, soporte, cliente | Producto, BI |
| Volumen | Bajo | Alto |

## 9. Health checks

### 9.1 Endpoint público
`GET /api/health` retorna:

```json
{
  "ok": true,
  "version": "1.2.3",
  "environment": "production",
  "checks": {
    "database": "ok",
    "auth": "ok",
    "storage": "ok"
  },
  "uptime_seconds": 12345
}
```

UptimeRobot pinguea cada 5 minutos.

### 9.2 Endpoint detallado (interno)
`GET /api/health/detailed` con auth interna retorna métricas más profundas.

## 10. Performance budgets

| Métrica | Budget | Alerta si |
|---|---|---|
| LCP (POS) | < 1.5s | p95 > 2s |
| FID | < 100ms | p95 > 200ms |
| CLS | < 0.1 | p95 > 0.2 |
| `create_sale` Edge Function | < 500ms | p95 > 1s |
| `submit_invoice_afip` | < 5s | p95 > 10s |
| TTFB (admin) | < 800ms | p95 > 1.5s |

## 11. Investigación de incidentes

### 11.1 Workflow
1. **Detección.** Alerta o reporte.
2. **Triage.** Severidad y alcance.
3. **Mitigación.** Detener el sangrado (rollback, flag off, etc).
4. **Investigación.** Causa raíz.
5. **Resolución.** Fix definitivo.
6. **Post-mortem.** Documento en `docs/post-mortems/YYYY-MM-DD-<slug>.md`.
7. **Prevención.** Acción concreta para que no se repita.

### 11.2 Template de post-mortem
Ver [`docs/templates/post-mortem.md`](./templates/post-mortem.md).

Mínimo:
- Resumen.
- Timeline.
- Impacto (cuántos tenants, cuánto tiempo, qué se perdió).
- Causa raíz.
- Qué funcionó bien.
- Qué falló.
- Acciones de seguimiento con responsables y fechas.

## 12. Cultura

- **Blameless.** Los post-mortems analizan sistemas, no personas.
- **Compartir.** Incidentes resueltos se cuentan en daily/weekly.
- **Iterar.** Cada incidente genera al menos una mejora de proceso.

## 13. Roadmap de observabilidad

| Fase | Capacidad |
|---|---|
| F0 | Logs de Vercel y Supabase. Audit_logs. |
| F1 | Logs estructurados en Edge Functions. Health endpoint. |
| F2 | Métricas custom en tabla. Dashboard interno básico. |
| F3 | Sentry. Alertas a Slack. Health checks externos. |
| F4 | PagerDuty. Dashboards públicos para clientes Enterprise. Distributed tracing. |
| F5 | Forecasting de capacidad. Anomaly detection. |
