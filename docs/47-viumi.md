# 47 · Viumi

> Relevamiento del 2026-10-20 y lo que integramos (ADR-173). Viumi es la solución de cobros para comercios de Banco Macro, sobre la plataforma de Geopagos (la misma que usa Getnet por API, ADR-031): link de pago, checkout para tiendas online y lectores de tarjeta.

## 1. Qué ofrece y qué tiene API

| Producto | Qué es | ¿API pública? | En NinjaSoft |
|---|---|---|---|
| **Checkout API v2** | Orden de pago con checkout hosted de Viumi (tarjeta de crédito y débito, con cuotas). Consulta de órdenes y webhook de pago. | **Sí**, documentada ([developers.viumi.com.ar](https://developers.viumi.com.ar)) | **Integrada**: link de pago y QR en la hoja de cobro, cobros en espera, webhook y conciliación |
| Lectores y terminales Viumi | Cobro con tarjeta en el mostrador | **No** (sin API para mandarles el monto) | Descartado como Point (ver [`payments/research-points-2026-10.md`](payments/research-points-2026-10.md)) |
| Devoluciones | Devolución de un pago | **No documentada** en la API | Se hacen desde la app o el panel de Viumi |
| Plugin de WooCommerce | "cool-payment-gateway-viumi-for-woocommerce" (público) | Usa la misma API | No aplica; lo usamos como segunda fuente para los hosts y la forma de las respuestas |

## 2. API (Checkout API v2)

Fuentes: [developers.viumi.com.ar](https://developers.viumi.com.ar) y el código del plugin público de WooCommerce, leídos el 2026-10-20.

### Ambientes

| Servicio | Prueba | Producción |
|---|---|---|
| Autenticación (doc) | `https://auth.stg.geopagos.io` | `https://auth.prd.geopagos.io` |
| Autenticación (plugin) | `https://auth.sandbox.geopagos.com` | `https://auth.geopagos.com` |
| Órdenes (doc) | `https://api-mpos-macro.stg.geopagos.io` | `https://api.viumi.com.ar` |
| Órdenes (plugin, sólo prueba) | `https://api-macro.sandbox.geopagos.com` | |

La integración pide el token primero al host de la doc y, si no responde o da 404, al del plugin. Para las órdenes usa los hosts de la doc; el host de prueba del plugin queda anotado acá por si el de la doc no anda con las credenciales de prueba.

### Credenciales

`client_id` y `client_secret` por comercio y por ambiente. No se sacan de un panel: se piden a Viumi por mail a **consultas@viumi.com.ar**.

### Endpoints

| Acción | Llamada | Notas |
|---|---|---|
| Token | `POST {auth}/oauth/token` `{ grant_type: "client_credentials", client_id, client_secret, scope: "api_orders_post" }` | `{ token_type: "Bearer", expires_in, access_token }` |
| Crear orden | `POST {checkout}/api/v2/orders`, `Content-Type` y `Accept` `application/vnd.api+json`, Bearer | `{ data: { attributes: { currency: "032", items: [{ id, name, quantity, unitPrice: { currency, amount } }], redirect_urls: { success, failed }, webhookUrl, expireLimitMinutes } } }`. `amount` en **centavos** como string entero (`"123456"` = $1.234,56). Responde el uuid en `data.id` y el link en `data.links.checkout` (doc) o `data.links[0].checkout` (plugin) |
| Consultar orden | `GET {checkout}/api/v2/orders/{uuid}` | `data.attributes`: `uuid`, `orderNumber`, `status` (`SUCCESS` pagada), `hasPendingPayment`, `payment { status }`, `payments[]`, `price { amount, currency }`, `items` |

No hay endpoints documentados para anular una orden ni para devolver un pago.

### Webhooks

- `POST` a `webhookUrl` con `{ data: { type: "Payment", order: { uuid, status, source }, payment: { id, authorizationCode, refNumber, status } } }`.
- **Sin firma documentada** (ni HMAC ni header propio). El cuerpo es sólo una pista: siempre re-consultamos la orden con la credencial del negocio.
- Respondemos siempre 200.

## 3. Qué implementamos

- **Link de pago y QR desde el POS** (Edge `viumi`, action `create`): orden con un ítem (la descripción de la venta, hasta 63 caracteres) por el total, el id del intent como id del ítem y en el `webhookUrl` (`https://hooks.soft.ninja/viumi?intent=<id>`), y `expireLimitMinutes` 1440 (el mismo tope de cobros en espera). El link de checkout se muestra como QR y como link para compartir.
- **Acreditación**: webhook (`viumi_webhook`) + sondeo del POS cada 3 s (`status`) + el cron de cobros en espera (`pending_charges_sync`, cada 2 min) como respaldo. Sólo acredita la orden guardada en el intent, con un pago `APPROVED` o `PROCESSED` y el monto exacto en centavos (`price.amount` o, sin él, la suma de los ítems). Idempotente: updates condicionales por estado.
- **Token**: cache por instancia con clave SHA-256 del ambiente y la credencial (nunca el secreto en claro, hasta 200 entradas), vence 5 minutos antes que el token (mínimo 60 s). Si una llamada da 401 o 403, pide un token nuevo y reintenta una vez.
- **Cancelar**: baja local del intent (action `cancel`). El link vence solo; si el cliente igual paga, el webhook lo registra y queda en la conciliación como cobro sin venta.
- **Credenciales por negocio o por sucursal** (`payment_secrets` provider `viumi`, ADR-057), cifradas en el servidor. Al guardarlas, `set_payment_secret` pide un token en el ambiente elegido: si Viumi las rechaza, no se guardan (`viumi_invalid_credentials`). **Probar conexión** (action `probe`) prueba las tipeadas o las guardadas y avisa si son del otro ambiente.
- **Ambiente de prueba**: el switch Sandbox del medio usa los hosts de prueba. No hicimos cobros reales: todo se testeó con fetch simulado.
- **Conciliación**: los cobros entran en **Ventas › Cobros QR** (filtro Viumi). Un cobro aprobado sin venta muestra que la devolución se hace desde la app o el panel de Viumi.
- **Plan**: feature `viumi` OPTIONAL desde Pro; gating real en la Edge (`tenant_has_feature_for`) y en el trigger de `payments` (`payment_method_plan_key('viumi')`). Migración `20270111100000_viumi`.
- **Logo**: no hay un logo oficial de Viumi en el repo. No se inventó uno: la UI usa el respaldo genérico (sin isotipo) hasta que se sume el archivo oficial en `public/images/payments/viumi-*.webp` y su entrada en `lib/payments/logos.ts`.

## 4. Inferido (a confirmar con credenciales de prueba)

- **`expires_in`**: el ejemplo de la doc parece un timestamp unix y el plugin lo toma como segundos. Si es mayor a 1e9 lo tomamos como timestamp en segundos; si no, como duración.
- **Estados de la orden** distintos de `SUCCESS`: `REJECTED`, `DECLINED` y `FAILED` como rechazo; `EXPIRED`, `CANCELLED` y `CANCELED` como cancelado; el resto, pendiente. Una orden `SUCCESS` sin un pago aprobado a la vista queda pendiente (no se acredita a ciegas). Getnet, sobre la misma plataforma, toma `SUCCESS` solo como aprobado.
- **Montos mínimo y máximo**: la doc no los dice. Usamos $1 y $9.999.999,99.
- **Referencia externa**: no hay un campo documentado. El intent viaja como id del ítem y en la query del webhook, pero lo que se verifica es el uuid de la orden.
- **Hosts**: cuál de los dos juegos (doc o plugin) es el vigente para cada ambiente.

## 5. Qué tiene que hacer el dueño

1. Pedirle a Viumi las credenciales de la API (Client ID y Client Secret, de prueba y de producción) por mail a consultas@viumi.com.ar.
2. En NinjaSoft: **Configuración › Medios de pago › Viumi › Conectar**, pegar las credenciales, elegir el ambiente y **Probar credenciales**.
3. Probar en Prueba y pasar a Producción.
4. Las devoluciones las hace desde la app o el panel de Viumi.

## 6. Pendientes

- Validar con credenciales de prueba reales los hosts, `expires_in`, la forma de la respuesta y los estados.
- Logo oficial de Viumi (isotipo y logo horizontal, con variante para fondo oscuro si hace falta).
- Devoluciones y anulación por API si Viumi las publica.
- Datos del procesador (tarjeta, cuotas, autorización) en el detalle del pago a partir de `GET /api/v2/orders/{uuid}`.
- Viumi en la conciliación de liquidaciones (`settlements`) y en el reporte de procesadores.
