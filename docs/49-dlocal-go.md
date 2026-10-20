# 49 · dLocal Go y cupones Rapipago / Pago Fácil

> Relevamiento del 2026-10-20 y lo que integramos (ADR-180). Dos medios para cobrar a distancia: **dLocal Go** (link de pago con su checkout) y el **cupón de pago en efectivo** de Mercado Pago (Rapipago o Pago Fácil) con la conexión de Mercado Pago que el negocio ya tiene.

## 1. dLocal Go

dLocal Go es la versión para pymes de dLocal: link de pago, botón de pago y API de pagos con checkout hosted (tarjeta de crédito, débito y medios locales según el país).

### 1.1 API verificada

Fuente: [docs.dlocalgo.com/integration-api](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api), leída el 2026-10-20 (índice en [llms.txt](https://docs.dlocalgo.com/integration-api/llms.txt)).

| | Testing | Producción |
|---|---|---|
| API | `https://api-sbx.dlocalgo.com` | `https://api.dlocalgo.com` |
| Dashboard | `https://dashboard-sbx.dlocalgo.com` | `https://dashboard.dlocalgo.com` |

- **Autenticación** ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/authentication)): `Authorization: Bearer <API_KEY>:<SECRET_KEY>`. Cada ambiente tiene su par de claves, en el dashboard › Integraciones › API Integration. La cuenta queda atada al sitio declarado ([FAQ](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/faq-preguntas-frecuentes)).
- **Crear un pago** ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/create-a-payment)): `POST /v1/payments` con `currency` y `amount` obligatorios y `country`, `order_id` (hasta 128), `description` (hasta 100), `success_url`, `back_url`, `notification_url`, `payer`, `expiration_type` / `expiration_value`, `payment_type`, `max_installments`. Respuesta: `id` (`DP-...`), `status: PENDING`, `order_id`, `redirect_url` (checkout hosted) y `merchant_checkout_token`.
- **Consultar** ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/retrieve-a-payment)): `GET /v1/payments/{id}`. Estados `PENDING`, `PAID`, `REJECTED`, `CANCELLED`, `EXPIRED` y `status_detail`. El `redirect_url` no es reutilizable y **vence a las 24 h**.
- **Notificaciones** ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/notifications)): `POST` al `notification_url` con `{ "payment_id": "..." }`. Firmadas: header `Authorization: V2-HMAC-SHA256, Signature: <hex>` con `HMAC-SHA256(clave = SECRET_KEY, mensaje = API_KEY + cuerpo)`. Ante una respuesta distinta de 200 reintenta cada 10 minutos hasta 30 días.
- **Devoluciones** ([crear](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/create-a-refund), [consultar](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/retrieve-a-refund)): `POST /v1/refunds { payment_id, amount?, notification_url? }` → `{ id: "REF-...", status: PENDING }`; `GET /v1/refunds/{id}` con `PENDING`, `SUCCESS`, `REJECTED`, `CANCELLED`.
- **Errores** ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/errors/payment-http-errors)): 403 `3001` credenciales inválidas, 404 `4000` pago inexistente, 400 `5007` monto excedido, `5016` monto muy bajo, `5009` order_id duplicado, 429 `6000`.
- **Consulta sin efectos** para probar la conexión: `GET /v1/currency-exchanges` ([doc](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/payments/retrieve-currency-exchange)).

**Inferido (a confirmar con credenciales de prueba):** el cuerpo de la notificación de una devolución (se ignora: re-consultamos la devolución por el id que guardamos) y que con `country: AR` + `currency: ARS` el monto informado es el mismo (sin conversión).

### 1.2 Qué integramos

| Pieza | Detalle |
|---|---|
| Proveedor y feature | `dlocalgo` (marca `dlocalgo`, canal `qr_link`), feature OPTIONAL `dlocalgo` desde Pro. `payment_method_plan_key('dlocalgo')`. |
| Conexión | `payment_secrets` provider `dlocalgo` con `api_key` y `secret_key`. `set_payment_secret` las prueba con `GET /v1/currency-exchanges` antes de guardar; "Probar conexión" detecta si son del otro ambiente. El switch Sandbox elige el host. |
| Edge `dlocalgo` | `create` (intent `provider_key='dlocalgo'`, pago en ARS con `order_id` = intent y `notification_url` = `https://hooks.soft.ninja/dlocalgo?intent=<id>`, el `redirect_url` es el link y el QR), `status`, `cancel` (baja local), `probe`, `refund` (total, sin venta vigente). |
| Edge `dlocalgo_webhook` | `verify_jwt = false`. Verifica la firma con la credencial del cobro; sin firma válida no procesa. Igual re-consulta el pago y acredita sólo `PAID` + mismo pago + `order_id` = intent + `ARS` + monto exacto. `?refund=` re-consulta la devolución. |
| Cobros en espera | Tope de 24 h (vida del link). El cron `pending_charges_sync` también los re-consulta. |
| Devoluciones | Tabla `dlocalgo_refunds` (una viva o hecha por cobro, RLS de lectura por negocio, escribe service_role) y acción "Devolver" en Ventas › Cobros QR. |
| UI | Tenders "dLocal Go · Link" y "dLocal Go · QR" (grupo Billeteras y links), tarjeta de conexión, guía, salud de webhooks, logo en el login. |

### 1.3 Logos

Oficiales de [dlocalgo.com](https://www.dlocalgo.com): el logo horizontal es el PNG del encabezado (`wp-content/uploads/2024/08/logo.png`, fondo blanco quitado, variante oscura con el texto negro en blanco) y el isotipo es el círculo azul con "go" del SVG oficial (`wp-content/themes/picostrap5-child-base/assets/logo-Go.svg`), sin el halo ni la sombra decorativos.

### 1.4 Lo que tiene que hacer el dueño

1. Crear la cuenta de dLocal Go (testing en `dashboard-sbx.dlocalgo.com`, producción en `dashboard.dlocalgo.com`) y activar la cuenta live.
2. Copiar la API Key y la Secret Key de Integraciones › API Integration.
3. Configuración › Medios de pago › dLocal Go › Conectar API (con el switch Sandbox para testing).

## 2. Cupones Rapipago / Pago Fácil (Mercado Pago)

### 2.1 API verificada

Fuente: Checkout API vía Orders, [Rapipago y Pago Fácil](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/payment-integration/rapipago-pagofacil), leída el 2026-10-20. Es la misma **Orders API** que ya usamos para el QR de la caja y el Point (`mp_qr`, `mp_point`, `mp_orders_webhook`).

- `POST /v1/orders` con `X-Idempotency-Key`: `type: "online"`, `processing_mode: "automatic"`, `total_amount` (string), `external_reference`, `payer` (`email` obligatorio, `first_name`, `last_name`, `identification { type, number }` obligatorio) y `transactions.payments[{ amount, expiration_time, payment_method { id: "rapipago" | "pagofacil", type: "ticket" } }]`. El vencimiento es ISO 8601, entre 1 y 30 días; recomiendan `P3D` porque la acreditación puede tardar hasta 2 horas hábiles. En modo automatic **no** va `expiration_time` a nivel order.
- La creación es asíncrona: la order puede volver `processing` sin datos. Después queda `action_required` / `waiting_payment` y el pago trae `payment_method.ticket_url`, `barcode_content`, `reference` y `verification_code`.
- Seguimiento por el webhook topic **Order** o `GET /v1/orders/{id}`. Un pago `action_required` se puede cancelar (`POST /v1/orders/{id}/cancel`).

**Inferido:** el estado final de un cupón pagado es el de cualquier order online acreditada (`processed` / `accredited`), que `resolveOrder` ya acredita con monto exacto y `external_reference`. La doc dice que `barcode_content` es EAN-13 pero el ejemplo trae 46 dígitos: **no dibujamos el código de barras** (podría no leerse); mostramos el número para dictarlo y el cupón oficial de Mercado Pago (`ticket_url`), que el cliente abre con el QR o el link.

### 2.2 Qué integramos

| Pieza | Detalle |
|---|---|
| Feature | `cupones_efectivo` OPTIONAL desde Pro (requiere `mercado_pago`). `payment_method_plan_key('mp_cupon')` → `cupones_efectivo`. Gating real en la Edge (las dos features). |
| Edge `mp_cupon` | `create` (pagador del cuerpo o del cliente de la venta, intent `provider_key='mp_cupon'` con `mp_order_id`, vencimiento `P3D`, re-lee la order unos segundos si todavía procesa), `status` (completa el cupón si faltaba y sincroniza con `applyOrderToIntent`), `cancel`. Usa la credencial de Mercado Pago del negocio o de la sucursal y el switch Sandbox (token de prueba). |
| Acreditación | `mp_orders_webhook` sin cambios: encuentra el intent por `mp_order_id` y aplica la regla de siempre. El cron `pending_charges_sync` también re-lee los cupones en espera. |
| `mp_payment_intents.voucher` | Datos del cupón (medio, ticket_url, código, referencia, vencimiento). |
| POS | Tender "Mercado Pago · Cupón Rapipago / Pago Fácil": pide email, nombre y DNI / CUIT (completa con el cliente), muestra el número copiable, "Ver cupón", el QR del cupón y el vencimiento; se comparte por WhatsApp, email o copiar y se deja **en espera** (arranca con 3 días). Al cerrar sin dejar en espera, el cupón se anula. |

### 2.3 Lo que tiene que hacer el dueño

Nada nuevo: con Mercado Pago conectado y un plan Pro o superior, el cupón aparece en el grupo Mercado Pago de la hoja de cobro. El webhook topic Order de la aplicación de Mercado Pago ya tiene que estar configurado (es el mismo del QR de la caja).

## 3. Pendiente

- Primer cobro real en testing de dLocal Go (confirmar firma de la notificación, cuerpo de la notificación de devolución y montos en ARS) y del cupón en sandbox de Mercado Pago (estado final de la order pagada).
- Cupón para cobrar deuda de **cuenta corriente** desde la ficha del cliente (hoy el cupón sale de la hoja de cobro del POS y de los cobros en espera; acreditar un pago de deuda sin caja ni cajero necesita su propio flujo en `account_collect`).
- Devolución del cupón por API (hoy desde la cuenta de Mercado Pago) y devoluciones parciales de dLocal Go.
- Conciliación de liquidaciones de dLocal Go ([Settlements](https://docs.dlocalgo.com/integration-api/welcome-to-dlocal-go-api/settlements)).
