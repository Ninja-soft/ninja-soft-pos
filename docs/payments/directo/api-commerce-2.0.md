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

## Pendiente de confirmar con Directo

- Duración del token (sólo sabemos que vence con 403).
- Si `price` admite decimales en string o sólo número (el ejemplo usa número).
- Cancelación o reversa de una orden y devoluciones: el documento no las describe.
- Firma del webhook: no hay; siempre se re-consulta por `notification_id`.
