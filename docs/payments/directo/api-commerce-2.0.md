# Directo · API Ecommerce 2.0 (documento oficial)

Fuente: `IntegracionApiCommerce20.pdf` (en esta carpeta), "Documento de integración API (versión Directo 2.0). Generación de orden en Directo, Ecommerce". Lo consiguió el dueño el 2026-10-27. Reemplaza lo que habíamos inferido del plugin de WooCommerce (ADR-041): esta versión **no** usa API Key, Subscription Key ni MerchantHash.

> Importante (del documento): estas APIs no deben usarse para scoring masivo de bases; un uso excesivo puede bloquear los usuarios del comercio.

## Entornos

| Entorno | `API_BASE_URL` |
|---|---|
| Prueba (QA) | `https://public.qa.directo.com.ar/ecommerce-qa` |
| Producción | `https://public.pro.directo.com.ar/ecommerce-pro` |

Usuario y contraseña del comercio los entrega Directo (uno para QA y otro para producción).

## Secuencia

1. **Login** `POST {base}/api/v1/auth/token` con `{ "username", "password" }` → `{ "token" }`. El resto de las llamadas lleva `Authorization: Bearer <token>`. **HTTP 403** en cualquier llamada = las credenciales (el token) vencieron: hay que volver a loguearse.
2. **Buscar persona** (opcional) `GET {base}/api/v1/services/get_by_dni_type?sexTypeId=<ST>&dni=<DNI>` → `{ names: [{ firstName, lastName }] }`. `sexTypeId`: `2` o `M` masculino, `3` o `F` femenino.
3. **Scoring** (opcional, para mostrar la oferta) `POST {base}/api/v1/services/rating` con `{ name: "APELLIDOS,NOMBRES", dni, sexTypeId, policyProduct }` → `{ pendingRequestId, offer: [{ maximumAmount, minimumAmount, maximumRate }], campaignMessage? }`. Errores: 400 `Invalid Person`, 400 `policyProduct field is spected`, 404 `Rejected` (sin oferta) o `InvalidPlan` (configuración comercial), 500 `Comunication error`.
4. **Planes** (opcional) `POST {base}/api/v1/services/deadlines` con `{ amount, pendingRequestId }` → `{ deadlines: [{ quantityRate, amountRate, expirationDate, disclaimer[], plan[{ expiration, quote, amount }], planType: DEFERRED_PAYMENT | UPFRONT_PAYMENT }] }`. 404 `No Installments found`.
5. **Crear orden** `POST {base}/api/v1/services/create_order` con
   `{ price, fullName: "APELLIDOS,NOMBRES", dni, notifyUrl, returnUrlSuccess, returnUrlError, policyProduct }`
   → `{ merchantOrderId, creationDate, redirectUrl }` (el cliente completa la solicitud en `redirectUrl`).
6. **Estado** `GET {base}/api/v1/services/get_order_status/{merchantOrderId}` → `{ status, merchantOrderId, installments, installmentAmount, amount, creditNumber }`.
7. **Webhook** Directo hace `POST notifyUrl` con `{ "notification_id": 1255 }`. Hay que consultar `GET {base}/api/v1/services/get_by_notification/{notificationId}` (misma respuesta que el estado). **Obligatorio**: el webhook es el mecanismo definitivo del resultado, no la redirección.

`status`: `Success` | `Cancel` | `Pending`. En `Success` vienen (opcionales) `creditNumber`, `installments`, `installmentAmount` y `amount` (capital del crédito).

## policyProduct

Indica con qué política asignada al comercio se evalúa. Obligatorio si el usuario tiene más de una política, opcional si tiene una sola. Acepta el producto (`BNPL`, `ELECTRO`, `MOTO`…) o el código de política (`61`, `35`…); si hay varias políticas del mismo producto hay que mandar el código. Para Novogar: QA `62`, producción `65` (dato de Directo, como en el conector de E3).

## Implementado (ADR-181, 2026-10-27)

- Cliente puro: `supabase/functions/_shared/directo.ts` (tests en `tests/unit/directo.test.ts`); servidor: `_shared/directo_server.ts`, Edges `directo` (create, status, cancel, offer), `directo_webhook`, `set_payment_secret` y `pending_charges_sync`.
- Host por el switch Sandbox del medio (QA o producción); `api_base_url` sólo como override avanzado (https).
- Conexión: `username`, `password`, `policy_product` (opcional, recomendado), `timeout_seconds` (opcional, 5 a 120, por defecto 30). Se valida con un login, nunca con scoring. Credenciales viejas `merchant_username` / `merchant_password` se aceptan; el resto de la API vieja se ignora.
- Token en cache por instancia (hash de ambiente + URL + credencial); 403 → login nuevo y un reintento.
- Orden: `fullName` "APELLIDOS,NOMBRES" y `dni` confirmados por el cajero (prellenados con el cliente de la venta), `price` = total, `notifyUrl` = `https://hooks.soft.ninja/directo?intent=<id>`, regreso a `/pagar/listo?medio=directo`. `merchantOrderId` en `mp_payment_intents.preference_id`.
- Webhook: `notification_id` → `get_by_notification` con la credencial del intent; aprueba sólo `Success` con el `merchantOrderId` guardado. Poll del POS y cron con `get_order_status`.
- `amount` (capital) no frena la aprobación; si difiere del precio queda marcado. Datos del crédito en `audit_logs` (`directo_payment_approved`).
- "Consultar oferta": `rating` + `deadlines`, sólo a pedido del cajero, tope de 20 por hora por negocio.
- No implementado: `get_by_dni_type` en la UI (el cliente lo tiene, sin uso), cancelación o reversa en Directo.

## Pendiente de confirmar con Directo

- Duración del token (sólo sabemos que vence con 403).
- Si `price` admite decimales en string o sólo número (el ejemplo usa número).
- Cancelación o reversa de una orden y devoluciones: el documento no las describe.
- Firma del webhook: no hay; siempre se re-consulta por `notification_id`.
- Si `maximumRate` del scoring es la cantidad máxima de cuotas (así lo mostramos) o una tasa.
- Código HTTP de un login con credenciales inválidas (tomamos 400, 401 o 403).
