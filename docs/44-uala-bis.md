# 44 · Ualá Bis

> Relevamiento del 2026-10-15 y lo que integramos (ADR-143). Ualá Bis es la cuenta para comercios de Ualá (Alau Tecnología S.A.U.): link de pago, QR, POS Mini, POS Pro, Tap en tu celu y checkout para tiendas online.

## 1. Qué ofrece y qué tiene API

| Producto | Qué es | ¿API pública? | En NinjaSoft |
|---|---|---|---|
| **API Cobros Online v2** (API checkout) | Orden de pago con checkout de Ualá: tarjeta de crédito, débito o prepaga, con cuotas. Consulta de órdenes, devolución total y webhooks. | **Sí**, documentada y con ambiente de prueba ([developers.ualabis.com.ar/v2](https://developers.ualabis.com.ar/v2)) | **Integrada**: link de pago y QR en la hoja de cobro, cobros en espera, webhook, conciliación y devolución |
| Link de pago (desde la app) | Link que arma el comercio en la app de Ualá ([ualabis.com.ar/link-de-pago](https://www.ualabis.com.ar/link-de-pago)) | No (se arma a mano en la app). La API v2 es la versión programable | Lo reemplaza la integración por API |
| QR de Ualá Bis | QR para cobrar con dinero en cuenta, débito o crédito ([ualabis.com.ar/qr](https://www.ualabis.com.ar/qr)) | **No** | Registro manual con número de operación |
| POS Mini y POS Pro | Lectores de tarjeta (el Pro es una terminal autónoma con 4G e impresora) ([ualabis.com.ar/pos-pro](https://www.ualabis.com.ar/pos-pro), [/pos-mini](https://www.ualabis.com.ar/pos-mini)) | **No** (sin API ni SDK para mandarles el monto) | Registro manual con número de operación |
| Tap en tu celu | Cobro contactless con el celular Android ([ualabis.com.ar/tap-en-tu-celu](https://www.ualabis.com.ar/tap-en-tu-celu)) | **No** | Registro manual con número de operación |
| Tiendanube, WooCommerce, Magento, Empretienda, Woflox | Plugins para tiendas online ([developers.ualabis.com.ar/other-stores/options](https://developers.ualabis.com.ar/other-stores/options)) | Usan la misma API | No aplica (NinjaSoft no es una tienda de esas plataformas) |
| Autenticación por link (integraciones comerciales) | Flujo tipo OAuth: el comercio inicia sesión en Ualá y la plataforma recibe sus credenciales ([/v2/commercial-integrations/authentication-link](https://developers.ualabis.com.ar/v2/commercial-integrations/authentication-link)) | Sí, pero está pensado para plataformas dadas de alta con Ualá | **Pendiente**: requiere acuerdo comercial con Ualá (ver §6) |

SDKs oficiales (de la API v1, deprecada): [ualabis-nodejs](https://github.com/Uala-Developers/ualabis-nodejs), [ualabis-php](https://github.com/Uala-Developers/ualabis-php), [ualabis-magento](https://github.com/Uala-Developers/ualabis-magento). No los usamos: la v1 se da de baja el 31/12/2026 ([migración](https://developers.ualabis.com.ar/v2/migracion)) y la integración llama a la v2 directo.

## 2. API Cobros Online v2

Fuente: [developers.ualabis.com.ar/v2](https://developers.ualabis.com.ar/v2), leída el 2026-10-15.

### Ambientes y credenciales ([/v2/ambientes](https://developers.ualabis.com.ar/v2/ambientes))

| Servicio | Prueba (stage) | Producción |
|---|---|---|
| Autenticación | `https://auth.stage.developers.ar.ua.la/v2/api` | `https://auth.developers.ar.ua.la/v2/api` |
| Órdenes y devoluciones | `https://checkout.stage.developers.ar.ua.la/v2/api` | `https://checkout.developers.ar.ua.la/v2/api` |

- Credenciales: en la app o la web de Ualá, **Ualá Bis › Cobros online › API**. Cada ambiente tiene su `username`, `client_id` y `client_secret_id` (usar una por la otra da error de autenticación).
- Prueba: pagos simulados con la tarjeta de prueba de la cuenta (**Credenciales de prueba › Ver datos de tarjeta de prueba**). Los webhooks funcionan igual que en producción. Las devoluciones también se pueden probar.
- Contacto técnico: developers.ualabis@uala.com.ar.

### Endpoints

| Acción | Llamada | Notas |
|---|---|---|
| Token ([/v2/authentication/create](https://developers.ualabis.com.ar/v2/authentication/create)) | `POST {auth}/auth/token` `{ username, client_id, client_secret_id, grant_type: "client_credentials" }` | `{ access_token, expires_in: 86400, token_type: "Bearer" }`. El token dura 24 h |
| Crear orden ([/v2/orders/create](https://developers.ualabis.com.ar/v2/orders/create)) | `POST {checkout}/checkout` con Bearer | `amount` en **centavos** como string (`"2500"` a `"999999900"`, o sea $25 a $9.999.999), `description`, `callback_success`, `callback_fail`, `notification_url` y `external_reference` opcionales. Responde `{ uuid, status: "PENDING", links.checkout_link }` |
| Consultar orden ([/v2/orders/get](https://developers.ualabis.com.ar/v2/orders/get)) | `GET {checkout}/orders/{uuid}` | Estado, monto, comisiones e impuestos (sólo APPROVED), datos de la tarjeta y cuotas, historial |
| Listar órdenes ([/v2/orders/find](https://developers.ualabis.com.ar/v2/orders/find)) | `GET {checkout}/orders?limit&fromDate&toDate&status&last_search_key` | Paginado por `last_search_key` |
| Devolución ([/v2/refunds/create](https://developers.ualabis.com.ar/v2/refunds/create)) | `POST {checkout}/orders/{uuid}/refund` `{ amount, notification_url? }` | `{ status: "INITIATED" }`. Sólo órdenes APPROVED, sin otra devolución en curso, dentro de los 90 días |

**Estados de la orden:** `PENDING` (creada), `PROCESSED` (pagada, falta el desembolso), `APPROVED` (pagada y desembolsada en la cuenta Ualá), `REJECTED`, `REFUNDED`. Algunos ejemplos de la doc escriben `PROCCESED`: aceptamos las dos formas.

### Webhooks

- **Orden** ([/v2/orders/create/webhook](https://developers.ualabis.com.ar/v2/orders/create/webhook)): `POST` a `notification_url` con `{ uuid, external_reference, status, created_date, api_version }`. Hay que responder 200; si no, Ualá reintenta 3 veces más (4 intentos).
- **Devolución** ([/v2/refunds/create/webhook](https://developers.ualabis.com.ar/v2/refunds/create/webhook)): `{ uuid, external_reference, status: REFUNDED | NOT_REFUNDED, ... }`.
- **No vienen firmados** (ni HMAC ni header propio ni IPs publicadas). Por eso el cuerpo es sólo una pista: siempre re-consultamos la orden con la credencial del negocio.

### Comisiones (públicas, sin IVA)

- Link de pago y API: **4,9 % + IVA** con crédito, débito y prepaga ([link de pago](https://www.ualabis.com.ar/link-de-pago)). Cuotas sin interés a cargo del comercio ([/cft](https://www.ualabis.com.ar/cft)).
- QR: 0 % los primeros 3 meses con dinero en cuenta; después 0,8 % dinero en cuenta, 2,9 % débito y 4,9 % crédito y prepaga ([/qr](https://www.ualabis.com.ar/qr)).
- Tap en tu celu y POS Pro: 2,9 % + IVA débito, 4,9 % + IVA crédito y prepaga.
- La plata se acredita en la cuenta Ualá "en el acto" según el sitio. Los porcentajes pueden cambiar: cargalos en **Comisiones estimadas** (ADR-099) para ver el neto.

### Requisitos

Cuenta de Ualá con **Ualá Bis** activo (persona humana o jurídica, [/personas-juridicas](https://www.ualabis.com.ar/personas-juridicas)). Las credenciales de la API salen de la propia app.

## 3. Qué implementamos

- **Link de pago y QR desde el POS** (Edge `ualabis`, action `create`): orden con `external_reference` = id del intent y `notification_url` = `https://hooks.soft.ninja/ualabis?intent=<id>`. El `checkout_link` se muestra como QR y como link para compartir. Mínimo $25 (también en la hoja de cobro).
- **Acreditación**: webhook (`ualabis_webhook`) + sondeo del POS cada 3 s (`status`) + el cron de cobros en espera (`pending_charges_sync`, cada 2 min) como respaldo. Sólo acredita la orden guardada en el intent, con `external_reference` propio, estado `PROCESSED` o `APPROVED` y el monto exacto. Idempotente: updates condicionales por estado.
- **Cobros en espera / compartir link**: el link de Ualá entra en el circuito de ADR-048 como los demás proveedores (24 h máximo).
- **Credenciales por negocio o por sucursal** (`payment_secrets`, ADR-057), cifradas en el servidor; nunca viajan al navegador ni a los logs. Al guardarlas, `set_payment_secret` pide un token en el ambiente elegido: si Ualá las rechaza, no se guardan. **Probar conexión** en el modal (action `probe`) prueba las tipeadas o las guardadas y avisa si son del otro ambiente.
- **Ambiente de prueba real**: el switch Sandbox del medio usa `stage` (pagos simulados). No hicimos cobros reales: todo se testeó con fetch simulado.
- **Conciliación**: los cobros entran en **Ventas › Cobros QR** (filtro Ualá Bis) y en el reporte de procesadores (por archivo). Un cobro aprobado sin venta queda marcado como siempre.
- **Devolución total** (action `refund`, dueño o encargado): sólo cobros aprobados sin venta vigente (si hubo venta, se anula primero). Tabla `ualabis_refunds` con una devolución viva por cobro; el resultado llega por el webhook de devolución y se confirma re-consultando la orden (`REFUNDED`).
- **Registro manual** (`payments.method = 'ualabis'`, número de operación obligatorio): para el QR, el POS Mini / Pro y Tap en tu celu. Se ofrece siempre que el medio esté habilitado, con o sin API.
- **Plan**: feature `ualabis` OPTIONAL desde Pro; gating real en la Edge (`tenant_has_feature_for`) y en el trigger de `payments` (`payment_method_plan_key('ualabis')`).
- **Logos**: isotipo del SVG oficial del portal de desarrolladores (`logo-small.svg`) y logo horizontal del encabezado de ualabis.com.ar, sin fondo. Las variantes para fondo oscuro pasan el azul de la marca a blanco. Están en `public/images/payments/ualabis-*.webp`.

## 4. Inferido (a confirmar con credenciales de prueba)

- Unidad del `amount` en las **respuestas** (la doc muestra `3005` sin aclarar): lo aceptamos como centavos o como pesos, siempre contra el monto del intent.
- Si existe la **devolución parcial**: la doc no la menciona; pedimos siempre el total.
- Si `PROCESSED` puede terminar rechazada: lo tomamos como pago exitoso (la doc dice "procesada con éxito, pendiente de desembolso").

## 5. Qué tiene que hacer el dueño

1. En la app de Ualá: **Ualá Bis › Cobros online › API**, copiar usuario, Client ID y Client Secret (de prueba y de producción).
2. En NinjaSoft: **Configuración › Medios de pago › Ualá Bis › Conectar**, pegar las credenciales, elegir el ambiente y **Probar credenciales**.
3. Probar en Prueba con la tarjeta de prueba de su cuenta y pasar a Producción.
4. Para el QR, POS o Tap: habilitar Ualá Bis (aunque no conecte la API) y cobrar con **QR, POS o Tap** cargando el número de operación.

## 6. Pendientes

- **Autenticación por link** (conectar sin copiar credenciales): pedir a Ualá el alta de NinjaSoft como integración comercial.
- Datos del procesador (tarjeta, cuotas, comisión real) en el detalle del pago (`payment_provider_data`) a partir de `GET /orders/{uuid}`.
- Liquidaciones por API (`GET /orders` con `commissions` y `taxes`) en el reporte de procesadores.
- Si Ualá publica API para el QR, el POS o Tap, integrarlos como los Point de los otros proveedores.
