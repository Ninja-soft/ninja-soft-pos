# Convenciones de API — NinjaSoft POS

Reglas para diseñar Edge Functions, endpoints internos y futuros endpoints públicos. Garantiza consistencia y facilita el trabajo en paralelo.

## 1. Tipos de "API" en el proyecto

| Capa | Uso | Forma |
|---|---|---|
| **Supabase queries directas** | Reads simples desde frontend (con RLS). | `supabase.from('products').select()` |
| **Edge Functions** | Mutaciones, lógica de negocio sensible, integraciones externas. | `POST /functions/v1/<name>` |
| **API Routes Next.js** | Solo casos que no caben en Edge Functions (rara vez). | `POST /api/<resource>/<action>` |
| **API pública** (Fase 5) | Para clientes Enterprise. | REST versionada en `api.ninjasoft.com.ar/v1/*` |

## 2. Edge Functions: convenciones

### 2.1 Nombres
- `snake_case`, verbo + recurso. Ej: `create_sale`, `void_sale`, `close_cash_shift`.
- Una función por acción, no funciones genéricas tipo `manage_sale`.

### 2.2 Path
- Servidas en `/functions/v1/<function_name>`.
- Versionado en path: cuando haya breaking change, `/functions/v1/create_sale` y `/functions/v2/create_sale` conviven 60 días.

### 2.3 Métodos
- `POST` para mutaciones y comandos.
- `GET` solo para reads complejas que no se pueden hacer con queries directas.
- No usamos `PUT`, `PATCH`, `DELETE` en Edge Functions: todas las mutaciones son `POST` con verbo en el nombre (`update_product`, `delete_customer`).

### 2.4 Estructura del archivo

```typescript
// supabase/functions/create_sale/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { z } from 'https://deno.land/x/zod/mod.ts'
import { createAuthedClient, requireAuth, requireTenant, requirePermission } from '../_shared/auth.ts'
import { errorResponse, successResponse } from '../_shared/responses.ts'
import { auditLog } from '../_shared/audit.ts'

const Schema = z.object({
  tenant_id: z.string().uuid(),
  store_id: z.string().uuid(),
  cash_shift_id: z.string().uuid(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().positive(),
    unit_price: z.number().nonnegative(),
    discount_pct: z.number().min(0).max(100).default(0),
  })).min(1),
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'transfer', 'qr', 'mp']),
    amount: z.number().positive(),
    reference: z.string().optional(),
  })).min(1),
  customer_id: z.string().uuid().optional(),
  discount_pct: z.number().min(0).max(100).default(0),
  notes: z.string().max(500).optional(),
})

serve(async (req) => {
  try {
    if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed')

    const { user, supabase } = await requireAuth(req)
    const body = Schema.parse(await req.json())
    
    requireTenant(user, body.tenant_id)
    requirePermission(user, 'sales:create')

    const { data, error } = await supabase.rpc('rpc_create_sale', { p_payload: body })
    if (error) return errorResponse(400, 'sale_failed', error.message)

    await auditLog(supabase, {
      tenant_id: body.tenant_id,
      actor_user_id: user.id,
      entity_type: 'sale',
      entity_id: data.sale_id,
      action: 'create',
      after_data: data,
    })

    return successResponse(data)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(400, 'validation_error', err.errors)
    }
    return errorResponse(500, 'internal_error', err.message)
  }
})
```

## 3. Convención de payloads

### 3.1 Request
- Siempre JSON.
- Siempre incluye `tenant_id` explícito (defensa en profundidad, aunque viene del JWT).
- Campos en `snake_case`.
- Fechas en ISO 8601 con timezone (`2026-05-16T20:54:01-03:00`).
- Montos en número (no string), positivos, con hasta 2 decimales.

### 3.2 Response success

```json
{
  "ok": true,
  "data": { ... }
}
```

### 3.3 Response error

```json
{
  "ok": false,
  "error": {
    "code": "validation_error",
    "message": "El campo 'items' es requerido y debe tener al menos un elemento.",
    "details": [...]
  }
}
```

### 3.4 Códigos de error estándar

| Código | HTTP | Significado |
|---|---|---|
| `unauthorized` | 401 | No hay sesión. |
| `forbidden` | 403 | Sesión válida, sin permisos. |
| `tenant_mismatch` | 403 | El tenant_id del payload no coincide con el del JWT. |
| `validation_error` | 400 | Schema Zod falló. |
| `not_found` | 404 | Recurso no existe (o no es visible por RLS). |
| `conflict` | 409 | Estado inconsistente (ej. caja ya cerrada). |
| `rate_limited` | 429 | Demasiados requests. |
| `internal_error` | 500 | Algo nuestro falló. |
| `dependency_error` | 502 | Servicio externo falló (AFIP, MP, etc.). |

## 4. Idempotencia

Toda operación que pueda repetirse (timeouts, reintentos de cliente) acepta header `Idempotency-Key`:

```
POST /functions/v1/create_sale
Idempotency-Key: 7f3a-...

→ Si la misma key se recibe dos veces en 24hs, retorna la misma respuesta sin crear duplicado.
```

Implementación: tabla `idempotency_keys (key, request_hash, response_body, created_at)`.

**Obligatorio en:**
- `create_sale`
- `void_sale`
- `submit_invoice_afip`
- Cualquier endpoint que dispare cobros o facturación.

## 5. Paginación

Cursor-based, no offset:

```
GET /functions/v1/list_sales?limit=50&cursor=<base64>

Response:
{
  "ok": true,
  "data": [...],
  "next_cursor": "eyJpZCI6ICIuLi4iLCAiY3JlYXRlZF9hdCI6ICIuLi4ifQ==",
  "has_more": true
}
```

Por qué cursor y no offset: offset se rompe cuando la lista cambia (inserciones nuevas) y es lento en tablas grandes.

## 6. Filtros y queries

Reads complejos exponen filtros via query params:

```
GET /functions/v1/list_sales?
  store_id=<uuid>&
  date_from=2026-05-01&
  date_to=2026-05-15&
  status=completed&
  cashier_id=<uuid>&
  limit=100
```

Validación con Zod sobre query params.

## 7. Timeouts y reintentos

- Edge Functions tienen timeout de 30s en Supabase. Operaciones largas se hacen async (cola).
- Cliente reintenta automáticamente errores `5xx` y `429` con backoff exponencial (manejado por TanStack Query).
- Cliente **no** reintenta `4xx` (excepto `429`).

## 8. Versionado

- **Breaking change:** crear v2 sin tocar v1. Anunciar deprecación con 60 días.
- **Aditivo:** OK en la misma versión (agregar campos opcionales en request, campos nuevos en response).
- **Cambios en validación:** si una regla se vuelve más estricta → nueva versión. Más permisiva → puede ir en la misma.

## 9. Documentación de cada Edge Function

Cada función incluye un `README.md` en su carpeta:

```
supabase/functions/create_sale/
├── index.ts
├── README.md          # ← documentación
└── test/
    └── index.test.ts
```

El README contiene:
- Propósito.
- Schema del payload.
- Posibles errores.
- Permisos requeridos.
- Side effects (qué tablas escribe).
- Idempotencia.
- Ejemplos de uso.

## 10. Tests por función

Cada Edge Function tiene tests que verifican:
- Happy path.
- Validación de schema (3-5 casos inválidos).
- Auth: rechaza sin sesión.
- Authz: rechaza con permiso insuficiente.
- Tenant mismatch: rechaza payload de otro tenant.
- Idempotencia (si aplica).
- Auditoría: verifica que se escribió en `audit_logs`.

## 11. API pública (Fase 5) — adelanto

Cuando llegue la fase 5:
- Endpoint base: `https://api.ninjasoft.com.ar/v1/`.
- Auth: OAuth 2.0 client credentials.
- Rate limit: 1000 req/min en Pro, 10000 en Enterprise.
- Versionado en path: `/v1`, `/v2`.
- OpenAPI spec generado automáticamente.
- Webhooks para eventos importantes (venta creada, stock agotado, etc.).

No se diseña ahora, pero las convenciones de Edge Functions ya están pensadas para escalar a esto.
