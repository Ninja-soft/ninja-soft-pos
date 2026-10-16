# API pública de NinjaSoft POS (v1)

> Para quien integra una tienda online, un ERP o una planilla con NinjaSoft. Plan **Enterprise**. Decisión técnica: [ADR-094](17-decision-log.md). Especificación completa: **OpenAPI 3.1** en `/api/openapi.json` (generada desde [`lib/api/spec.ts`](../lib/api/spec.ts), ADR-159). Portal con referencia, colección de Postman y Probar contra el sandbox en **Configuración > Integraciones > API**.

## 1. En dos minutos

- **Base:** `https://pos.soft.ninja/api/v1`
- **Autenticación:** OAuth 2.0 *client credentials*. Con el `client_id` y el `client_secret` de una credencial pedís un token Bearer que dura **1 hora**.
- **El negocio sale de la credencial.** Ningún parámetro elige el negocio: un id, SKU o sucursal de otro negocio simplemente no existe para tu token.
- **Alcances (scopes):** cada credencial tiene sólo los permisos que el dueño le dio.
- **Lotes:** hasta **500** ítems por pedido, con resultado por ítem e `Idempotency-Key` opcional.
- **Límite:** pedidos por minuto por credencial (600 por defecto, configurable de 10 a 10.000). Pasado el límite, `429` con `Retry-After`.
- **Cuerpo máximo:** 1 MB. JSON (`Content-Type: application/json`).

## 2. Credenciales

Las crea **el dueño** en **Configuración > Integraciones > API**:

1. **Nueva credencial**: ambiente (**Prueba** o **Producción**), nombre (por ejemplo "Tienda online"), permisos y pedidos por minuto.
2. Se muestra el **secreto una sola vez**. NinjaSoft guarda sólo su huella (sha256): si se pierde, se **rota**.
3. **Rotar** genera un secreto nuevo; el anterior y los tokens emitidos dejan de servir en el acto.
4. **Revocar** corta el acceso para siempre (con motivo). Siempre se puede, aunque el plan ya no incluya la API.
5. Se ve el **último uso** de cada credencial. Todo queda en la auditoría del negocio.

Usá una credencial por sistema: si una se filtra, la revocás sin cortar las demás. Máximo 10 activas por negocio.

| Alcance | Permite |
|---|---|
| `products:read` | Listar productos (precio, costo y stock consolidado). |
| `products:write` | Crear y editar productos en lote por SKU. |
| `stock:read` | Sucursales y stock por sucursal. |
| `stock:write` | Ajustes y conteos de stock con motivo. |
| `prices:write` | Precio y costo en lote por SKU. |
| `sales:read` | Ventas por rango con ítems y cobros (sólo lectura). |
| `customers:read` | Clientes. |
| `customers:write` | Crear y editar clientes por id o id externo. |

La API **nunca** abre o cierra caja, cobra, anula ventas, toca personal, permisos, plan ni la cuenta corriente de un cliente.

## 3. Token

```bash
curl -s https://pos.soft.ninja/api/v1/oauth/token \
  -u "$NS_CLIENT_ID:$NS_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d "scope=products:read products:write"
```

```json
{ "access_token": "nsat_…", "token_type": "Bearer", "expires_in": 3600, "scope": "products:read products:write" }
```

Sin `scope`, el token lleva todos los alcances de la credencial. Los errores del token siguen OAuth: `{"error": "invalid_client", "error_description": "…"}` (`invalid_client`, `invalid_scope`, `unsupported_grant_type`, `feature_not_in_plan`, `tenant_inactive`, `rate_limited`). Pedí un token nuevo cuando el actual venza (401 `invalid_token`).

## 4. Errores

Todas las demás rutas responden errores así:

```json
{ "error": { "code": "insufficient_scope", "message": "El token no tiene el alcance products:write.", "details": { "required": "products:write" } } }
```

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `invalid_cursor`, `invalid_json`, `invalid_idempotency_key` | Pedido mal formado. |
| 401 | `invalid_token` | Falta el token, venció, se rotó o se revocó la credencial. |
| 403 | `insufficient_scope` | El token no tiene el alcance de la ruta. |
| 403 | `feature_not_in_plan`, `tenant_inactive` | El plan no incluye la API o el negocio está suspendido. |
| 404 | `store_not_found`, `not_found` | Sucursal o ruta inexistente. |
| 409 | `idempotency_conflict`, `idempotency_in_progress`, `conflict` | Clave repetida con otro cuerpo o escritura concurrente. |
| 413 | `payload_too_large` | Más de 1 MB. |
| 415 | `unsupported_media_type` | El cuerpo no es JSON. |
| 422 | `validation_error` | Datos inválidos (con `details` por campo o ítem). |
| 429 | `rate_limited` | Pasaste el límite por minuto. Esperá `Retry-After` segundos. |
| 500 / 503 | `internal_error`, `unavailable` | Reintentá con espera exponencial. |

Headers en cada respuesta autenticada: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (segundos hasta que cierra la ventana) y `X-Request-Id`.

## 5. Paginación por cursor

Las listas devuelven `{ "data": [...], "next_cursor": "…" | null }`. Pasá `?cursor=<next_cursor>` para la página siguiente. Productos y clientes se ordenan por fecha de modificación: guardando el último cursor (o usando `updated_since`) traés sólo lo que cambió. Un registro modificado mientras paginás vuelve a aparecer al final: nunca se pierde.

## 6. Ejemplos

```bash
API=https://pos.soft.ninja/api/v1
TOKEN=$(curl -s $API/oauth/token -u "$NS_CLIENT_ID:$NS_CLIENT_SECRET" -d grant_type=client_credentials | jq -r .access_token)
```

**Productos: alta y edición por SKU (hasta 500).** Un campo ausente no se toca; en un alta `name` es obligatorio.

```bash
curl -s -X POST $API/products/batch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: sync-2026-10-13-001" \
  -d '{"items":[{"sku":"YER-1KG","name":"Yerba 1 kg","barcode":"7790000000011","price":4200,"cost":2900},
                {"sku":"AZU-1KG","price":1350}]}'
```

```json
{ "summary": { "created": 1, "updated": 1, "unchanged": 0, "failed": 0 },
  "results": [ { "index": 0, "sku": "YER-1KG", "id": "…", "status": "created" },
               { "index": 1, "sku": "AZU-1KG", "id": "…", "status": "updated" } ] }
```

Errores por ítem: `barcode_in_use` (el código de barras ya es de otro producto) y `name_required`. Repetir el pedido con la misma `Idempotency-Key` y el mismo cuerpo devuelve la misma respuesta con `Idempotent-Replayed: true` sin volver a aplicar (24 h).

**Productos: listar cambios.**

```bash
curl -s "$API/products?limit=500&updated_since=2026-10-13T00:00:00Z" -H "Authorization: Bearer $TOKEN"
```

**Precios en lote.**

```bash
curl -s -X POST $API/prices/batch -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"YER-1KG","price":4500},{"sku":"AZU-1KG","price":1400,"cost":980}]}'
```

**Stock por sucursal.**

```bash
curl -s "$API/stores" -H "Authorization: Bearer $TOKEN"
curl -s "$API/stock?store_id=<uuid>&sku=YER-1KG,AZU-1KG" -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/stock/adjustments -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"sku":"YER-1KG","qty":24,"reason":"purchase","notes":"Remito 0001-123"},
                {"sku":"AZU-1KG","mode":"set","qty":10,"reason":"count"}]}'
```

`mode: "delta"` (por defecto) suma o resta; `mode: "set"` fija el saldo (conteo). Motivos: `purchase`, `adjustment`, `loss`, `return`, `count`, `production`. Sin `store_id` va a la sucursal principal; otra sucursal pide stock por sucursal en el plan. v1 cubre productos sin variantes (`variants_not_supported`).

**Ventas por rango (sólo lectura, hasta 93 días).**

```bash
curl -s "$API/sales?from=2026-10-01T00:00:00-03:00&to=2026-10-14T00:00:00-03:00&limit=200" -H "Authorization: Bearer $TOKEN"
```

**Clientes.** Cada ítem trae `id` (cliente existente) o `external_id` (tu clave, única por negocio).

```bash
curl -s -X POST $API/customers/batch -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"external_id":"WEB-1001","name":"Ana Pérez","email":"ana@example.com","document_type":"dni","document_number":"30123456"}]}'
curl -s "$API/customers?external_id=WEB-1001" -H "Authorization: Bearer $TOKEN"
```

## 6 bis. Sandbox (credenciales de prueba, ADR-159)

- Se crean igual que las de producción eligiendo el ambiente **Prueba**. Prefijos: `client_id` `nsc_test_`, secreto `nss_test_`, token `nsat_test_`. El ambiente se fija al crear y no cambia.
- **Escrituras** (`products/batch`, `prices/batch`, `stock/adjustments`, `customers/batch`): la base valida y ejecuta todo dentro de un subbloque y lo deshace antes de responder (*dry_run*). Misma respuesta que en producción con `"dry_run": true`; los `id` de altas son simulados. No queda nada: ni productos, ni stock, ni movimientos, ni auditoría del lote, ni la `Idempotency-Key`, ni lo que encolarían los triggers (Mercado Libre, catálogo).
- **Lecturas:** datos reales del negocio, sólo lectura, con los alcances de la credencial.
- Nunca factura en ARCA, no cobra ni publica: la API v1 no expone esas operaciones.
- Mismo plan (Enterprise), límite y errores que producción. Las respuestas traen `X-Ninja-Environment: test`.
- El **Probar** del portal sólo acepta credenciales de prueba; credenciales y token quedan en memoria de la pestaña.

## 7. Rendimiento

Criterio F5: sincronizar **1000 productos en menos de 60 s**. Con dos lotes de 500 el test de CI (`tests/integration/rls-api-publica.test.ts`) mide el alta y el cambio de precios y lo deja en el log.

## 8. Fuera de v1 (deuda)

Webhooks salientes (venta creada, stock bajo) con firma HMAC y reintentos; variantes; listas de precios; facturas; logs de pedidos por credencial visibles para el dueño; dominio propio `api.soft.ninja`. Ver ADR-094.
