# Getnet Checkout API: checkout propio en /pagar (ADR-069)

> Investigación del 2026-10-12 sobre la "Checkout API" de Getnet (credenciales "Checkout API / Plugin VTEX") y cómo se usa en NinjaPOS. Complementa ADR-065 (Web Checkout, QR y link) y ADR-031.

> **Decisión del dueño (2026-10-13, ADR-069 adenda):** al cliente se le pide **sólo** "Web Checkout / Plugin Magento / Plugin WooCommerce". Las de "Checkout API / Plugin VTEX" dan error al generar el QR y no sirven sin certificación PCI: mientras el checkout propio esté apagado no se muestran, no se pueden guardar y, si alguien las pega en Web Checkout, se rechazan. El código de la Checkout API queda en el repo, apagado. Ver sección 3.

## 1. Las dos credenciales de Getnet

Getnet le da al comercio dos juegos de credenciales. **No son intercambiables**:

| En el Portal Getnet dice | Qué API es | Para qué la usa NinjaPOS | Dónde se carga |
|---|---|---|---|
| Web Checkout / Plugin Magento / Plugin WooCommerce | Web Checkout (checkout hosted de Getnet) o la API Getnet Argentina del plugin de WooCommerce (Geopagos) | **QR y link**: el cliente paga en la página de Getnet | Medios de pago › Getnet › **Web Checkout** |
| Checkout API / Plugin VTEX | Global API ("Single Entry Point", cobro directo con tarjeta, sin página de Getnet) | **Checkout propio** `/pagar/{intent}?p=getnet`, con la marca del negocio y sus cuotas, como Payway | Medios de pago › Getnet › **Checkout API** |

Por qué el QR fallaba con las de Checkout API: el QR y el link necesitan una página de pago de Getnet (`POST /dpy/web-checkout/v1/payment-intent` → `redirect_url`). La Checkout API no tiene esa página: es un cobro directo de tarjeta. Con esas credenciales el token puede salir, pero Web Checkout no es su producto.

"Probar credenciales" prueba las dos APIs y detecta si una credencial es del otro juego (Web Checkout falla en el token o en `GET /sellers` y la Checkout API da token, o al revés). En Web Checkout, unas de Checkout API / Plugin VTEX se rechazan con "Estas credenciales son de Checkout API / Plugin VTEX. Cargá las de Web Checkout / Plugin Magento / Plugin WooCommerce." y no se guardan.

## 2. Checkout API: lo que verificamos

Fuente principal: el OpenAPI **"Global API GetNet" v1.0.4** publicado en el portal (embebido en la página del API Reference) y las guías del mismo portal.

### Disponibilidad en Argentina

- La Global API lista Argentina entre sus países (AR, BR, CL, CO, MX, PT, ES, UY). [Overview](https://docs.globalgetnet.com/en/products/online-payments/regional-api)
- La cotización de cuotas (`/payments/quotes`) es **sólo para Argentina y Chile**, y en esos países el `quote_id` es obligatorio para cobrar en cuotas. [API Reference](https://docs.globalgetnet.com/en/products/online-payments/regional-api/swagger)
- Moneda `ARS`; montos enteros en centavos.

### Autenticación

- `POST {host}/authentication/oauth2/access_token`, `Authorization: Basic base64(client_id:client_secret)`, `Content-Type: application/x-www-form-urlencoded`, cuerpo `grant_type=client_credentials`. Respuesta `{ access_token (JWT), scope "digital-platform:gateway-api", token_type "Bearer", expires_in 3599 }`. [Authentication](https://docs.globalgetnet.com/en/products/online-payments/regional-api?doc=first-step-authentication)
- Diferencia con Web Checkout: Web Checkout manda `client_id` y `client_secret` en el cuerpo; la Checkout API, en Basic auth.
- El JWT trae `sellerId` y `country` (claims). Casi todas las llamadas piden el header `x-seller-id`; lo leemos del token (o el dueño lo carga a mano).
- `x-transaction-channel-entry`: código de plataforma que **asigna Getnet a pedido** ("The code to be informed must be previously requested from GetNet"). Campo opcional en la conexión.
- Hosts: producción `https://api.globalgetnet.com`, homologación `https://api.pre.globalgetnet.com`, sandbox `https://api-sbx.globalgetnet.com` (algún link del portal usa `api-sbx.pre.globalgetnet.com`). [Quickstart](https://docs.globalgetnet.com/en/products/online-payments/regional-api?doc=quickstart-guide)

### Tokenización de la tarjeta (PCI)

- `POST /dpm/cofre-gw-proxy/v1/tokens/card` `{ card_number, customer_id }` → `{ number_token }` (128 caracteres). Errores: 403 `CONFIG-403 Product not enabled` si el comercio no tiene la bóveda ("cofre"). [API Reference, Cards › Generate Token](https://docs.globalgetnet.com/en/products/online-payments/regional-api/swagger)
- **Pide el Bearer del comercio**: es una llamada servidor a servidor. **No hay SDK de JavaScript, campos seguros ni clave pública** para tokenizar desde el navegador (a diferencia de Payway, que tokeniza con la API Key pública).
- Comprobado el 2026-10-12: el preflight CORS desde un origen web a `tokens/card` responde **403 (sandbox) y 404 (producción) sin `Access-Control-Allow-Origin`**. El navegador no puede llamar a Getnet.
- Consecuencia: **la tarjeta tiene que pasar por nuestro servidor** para tokenizarla. Eso pone a NinjaSoft dentro del alcance PCI DSS (como proveedor de servicios: SAQ D o ROC según volumen). Las plataformas que usan estas credenciales (VTEX) son gateways certificados PCI nivel 1.
- Alternativa para no tocar la tarjeta: los modos **iframe y lightbox de Web Checkout** (el formulario de tarjeta es de Getnet, embebido en la página). Usan las credenciales de Web Checkout, no las de Checkout API, y la carga de tarjeta y cuotas la resuelve Getnet. [Integration options](https://docs.globalgetnet.com/en/products/online-payments/web-checkout?doc=integration-options-wbc)

### Cuotas

- `POST /dpm/payments-gwproxy/v2/payments/quotes` `{ amount, bin (9 dígitos), number_token, installment_type_filter: "no_interest" | "with_interest" }` → `{ options: [{ quote_id, schema (plan_ahora, plan_emisor…), type, number, installment_amount, total_amount }] }`.
- En el cobro: `data.payment.transaction_type` `FULL` | `INSTALL_NO_INTEREST` | `INSTALL_WITH_INTEREST`, `number_installments`, y `data.additional_data.installment.quote_id` (obligatorio en AR).

### Cobro

- `POST /dpm/payments-gwproxy/v2/payments` con `idempotency_key` (UUID por cobro), `order_id`, `data.amount` (centavos), `data.currency "ARS"`, `data.payment.payment_id` (opcional: si lo mandamos, lo usamos para re-consultar), `payment_method` `CREDIT` | `DEBIT`, `card.{ number_token, expiration_month, expiration_year, cardholder_name, security_code, brand }`.
- Respuesta: `{ payment_id, amount, status APPROVED | AUTHORIZED | CAPTURED | DENIED | ERROR, reason_code, reason_message, authorization_code, brand, acquirer_transaction_id }`.
- 3DS: opcional (`/dpm/security-gwproxy/v2/enrolments-initial`, `enrolments-continue`, `validations`). En Argentina no es obligatorio; si el comercio no lo tiene habilitado, mandar `authentication` da `3ds_not_enabled`. No lo usamos en esta versión.

### Estado, anulación y devolución

- `GET /dpm/hub-payment-info/v1/payments/info/{payment_id}` → `{ status, payment, records[] }` con estados `AUTHORIZED, APPROVED, CAPTURED, CANCELED, REFUNDED, DENIED, ERROR, PENDING`.
- Anular / devolver en **Argentina**: por la API legacy de Web Checkout con el mismo Bearer: `POST /digital-checkout/v1/payments/{payment_id}/cancellation` (mismo día, total) y `POST /digital-checkout/v1/payments/{payment_id}/refund` (desde D+1, `amount` opcional en centavos). Para el resto de los países, `POST /dpm/payments-gwproxy/v2/payments/cancel`. [Cancel or refund (Web Checkout)](https://docs.globalgetnet.com/en/products/online-payments/web-checkout?doc=cancell-or-refund-a-payment-wbc) · [Refund a payment](https://docs.globalgetnet.com/en/products/online-payments/regional-api?doc=refund-payment)

### Webhooks

- `POST /dpm/webhooks/v1/subscriptions` (scope `digital-platform-webhooks-api:rw`, header `x-seller-id`) con eventos `APPROVED_TRANSACTIONS`, `REJECTED_TRANSACTIONS`, `CANCELLED_TRANSACTIONS`, `REFUNDED_TRANSACTIONS`… Getnet reintenta hasta 5 veces y después cada hora hasta 72 h.
- No los usamos: el cobro del checkout propio es sincrónico (la respuesta del `POST /payments`) y el POS re-consulta el `payment_id` mientras espera.

### Sandbox y tarjetas de prueba

- Sandbox `api-sbx.globalgetnet.com` con credenciales que entrega Getnet. Tarjetas de prueba: [Test cards](https://docs.globalgetnet.com/es/articles/test-cards).
- Formas de error leídas con credenciales de mentira (2026-10-12):
  - token con Basic inválido: `401 {"error_description":"Client authentication failed","error":"invalid_client"}`;
  - token con form inválido: `400` con el mismo cuerpo;
  - `tokens/card` o `payments` con Bearer inválido: `401 {"statusCode":401,"message":"Invalid token"}`.

## 3. Cómo quedó en NinjaPOS

### Lo que ve el cliente hoy (checkout propio apagado)

- **Asistente de conexión:** una sola tarjeta, **"Web Checkout / Plugin Magento / Plugin WooCommerce"**, con el texto "Estas son las credenciales que tenés que cargar. Las encontrás en el portal de Getnet como Web Checkout, Plugin Magento o Plugin WooCommerce." y el aviso "No uses las de Checkout API / Plugin VTEX: no funcionan para cobrar con QR ni link desde NinjaSoft." La guía de conexión pide buscar esas credenciales en el portal.
- **Probar y guardar:** "Conectar" corre la prueba si no se hizo y **no guarda** si falla (el resultado queda en rojo). `set_payment_secret` vuelve a probar un Client ID / Secret nuevo de Web Checkout antes de guardarlo y responde `getnet_checkout_api_credentials` (422) si es de Checkout API / Plugin VTEX o `getnet_invalid_credentials` (422) si Getnet lo rechaza en todas sus APIs. Un corte de Getnet (red o 5xx) no bloquea el guardado.
- **Slot Checkout API:** la tarjeta no aparece; `set_payment_secret` rechaza cualquier clave `api_*` con `checkout_api_unavailable` (409) y la Edge `getnet` no prueba ese slot.
- **POS:** "Link (checkout propio)" no aparece. Getnet QR y Link siguen con Web Checkout.
- **Flag:** la Edge `getnet` (action `capabilities`) devuelve `{ own_checkout_enabled }`, un booleano derivado de `GETNET_CHECKOUT_API_PCI_ATTESTED`; nunca el valor del secret. Lo leen el asistente y el POS (este último sólo si hay Checkout API cargada). Ante error, apagado.

### Cuando se habilite el checkout propio

- **Conexión:** Getnet guarda dos slots en la misma credencial (por ambiente y por sucursal, ADR-057): Web Checkout (`client_id`, `client_secret`, `api_profile`, `environment`) y Checkout API (`api_client_id`, `api_client_secret`, `api_environment`, `api_seller_id`, `api_channel_entry`). Cada slot se guarda sin pisar el otro y se hereda por separado (sucursal → negocio). `tenant_payment_methods.config` marca `web_checkout_connected` y `checkout_api_connected`.
- **POS:** Getnet QR y Link exigen Web Checkout; **"Link (checkout propio)"** exige Checkout API y la feature `getnet_checkout_propio`. Comparte link, QR y cobros en espera como Payway.
- **/pagar:** la misma página de Payway con `?p=getnet`: marca del negocio, tarjeta, cuotas de los Planes de Getnet con su interés. La tarjeta va a la Edge `getnet_checkout`, que en el mismo request pide token, tokeniza, cotiza las cuotas y cobra con el monto calculado en el servidor. No se guarda, no se loguea (los mensajes del proveedor pasan por un filtro que tapa números de tarjeta) y nunca vuelve en una respuesta.
- **Apagado por PCI:** el cobro (`getnet_checkout` pay) y la creación del link propio responden `checkout_api_unavailable` hasta que el secret `GETNET_CHECKOUT_API_PCI_ATTESTED=true` esté cargado en Supabase. Ver ADR-069.

## 4. Supuestos a validar con el primer cobro real

1. Que el comercio tenga habilitados la bóveda (`cofre`) y las cuotas en la Checkout API.
2. Que nuestro recargo de cuotas vaya como `INSTALL_NO_INTEREST` con una cotización `no_interest` cuyo total coincide con el nuestro (si Getnet sólo ofrece planes del emisor, hay que pasar a `INSTALL_WITH_INTEREST` y mostrar el total de Getnet).
3. Si Getnet exige `x-transaction-channel-entry` para la plataforma.
4. Que `GET /payments/info` devuelva el monto en `payment.amount` o `amount` (centavos).
5. Si hace falta enviar `customer` con documento (`DNI_AR`) para el antifraude.
