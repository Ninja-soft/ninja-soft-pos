# Relevamiento de terminales ("Points") para un POS en la nube · Argentina, 2026-10

> Fecha: 2026-10-12. Contexto: NinjaSoft POS es web (Next.js + Supabase Edge Functions). Un "Point" integrado es una terminal de tarjeta a la que el POS le manda el monto **desde la nube** y de la que recibe el resultado, sin agentes locales en la PC de la caja. Ya integrados: Mercado Pago Point (Orders API, ADR-032) y Nave Point (Ranty `payment_requests/smart_pos`, ADR-030). Decisión resultante: ADR-047.
>
> Notación: **[V]** verificado en la fuente enlazada; **[I]** inferido o sin confirmar.

## Resumen

| Proveedor | API cloud pública para mandar cobros a la terminal | Acceso | Estado en NinjaSoft |
|---|---|---|---|
| **Clover (Fiserv)** | Sí: Cloud Pay Display / REST Pay Display API | Self-service (cuenta de desarrollador global + sandbox); producción con app aprobada | **Implementado** (`fiserv_point`, Edge `clover_point`), pendiente de validar en sandbox |
| Mercado Pago Point | Sí (Orders API) | Self-service | Implementado (ADR-032) |
| Nave Point | Sí (Ranty) | Alta con Nave | Implementado (ADR-030) |
| Payway Point (Prisma) | No publicada (sólo reversas y cierres de lote PayStore) | Comercial / homologación | Próximamente |
| Getnet Point | Cloud2Cloud de "Integrated POS" (librería), sin confirmar para AR | Partner | Próximamente |
| Mobbex | No (sólo checkout online) | | Descartado como Point |
| MODO | No tiene terminal (QR sobre terminales Payway/Fiserv) | | Descartado como Point |
| Ualá Bis | No (sólo API de cobros online) | | Descartado como Point |
| Viumi (Macro) | No (sólo Checkout API) | | Descartado como Point |
| Naranja X | No tiene terminal propia (cubierto por Nave) | | Descartado |
| Posnet / LaPos legacy | No: protocolo serie/ethernet local bajo acuerdo | | Descartado (requiere agente local) |
| Cuenta DNI, Personal Pay | No tienen terminal propia | | Descartado |

## 1. Clover (Fiserv Argentina)

**Conclusión:** es la única terminal de un adquirente grande con API cloud documentada y sandbox self-service. Se implementa ahora con Cloud Pay Display. Hay una contradicción en la documentación de Clover sobre Argentina que hay que despejar en el primer cobro de prueba (ver "Riesgo").

### Qué está verificado

- **Clover vende en Argentina** (Flex y Mini) y tiene guía para desarrolladores en español para Argentina, que lista dos semi-integraciones: **Cloud Pay Display** ("conecta tu sistema de punto de venta a la nube de Clover... siendo necesario tener conectividad a Internet") y REST Pay Display (red local). [V] <https://docs.clover.com/dev/docs/quick-reference-guides-latam-developers> (actualizada 2026-07-15).
- **Matriz de Pay Display por región:** Argentina (AR), Flex y Mini: Cloud Pay Display, REST Pay Display y Secure Network Pay Display (Mini también USB). [V] <https://docs.clover.com/dev/docs/pay-display-apps-support-matrix-by-devices-and-regions>.
- **Hosts:** sandbox único `https://apisandbox.dev.clover.com`; producción Latinoamérica `https://api.la.clover.com` (OAuth en `https://la.clover.com/`). [V] <https://docs.clover.com/dev/docs/clover-environments>, <https://docs.clover.com/dev/docs/obtaining-an-oauth-token>.
- **Cloud Pay Display:** base `{host}/connect`. Headers obligatorios `X-Clover-Device-Id` (número de serie de la terminal) y `X-POS-Id` (libre); `Idempotency-Key` obligatorio en `/v1/payments`, refunds, void, etc. [V] <https://docs.clover.com/docs/api-tutorials>, <https://docs.clover.com/dev/docs/build-a-cloud-connection-request>.
- **Cobro:** `POST /connect/v1/payments` `{ amount (centavos), externalPaymentId (máx. 32), final, capture, tipAmount, taxAmount }`. Bloquea hasta que el cliente termina; respuestas 209 (cancelado), 400, 401, 415, 500 (indeterminado: no repetir sin analizar), 501, 503 (terminal ocupada), 504 (no respondió a tiempo). Header opcional `X-Clover-Timeout` (0 a 300 s). [V] <https://docs.clover.com/dev/reference/pay>.
- **Consultar:** `GET /connect/v1/payments/external/{externalPaymentId}` → `{ payment }` con `result` (`SUCCESS`, `FAIL`, `INITIATED`, `VOIDED`, `VOIDING`, `VOID_FAILED`, `AUTH`, ...), `amount`, `tipAmount`, `cardTransaction`. [V] <https://docs.clover.com/dev/reference/get_payment_by_external_payment_id>.
- **Cancelar lo que está en curso:** `PUT /connect/v1/device/reset`. **Ping:** `POST /connect/v1/device/ping` → `{ connected }`. **Anular:** `POST /connect/v1/payments/{id}/void`; **devolver:** `/v1/payments/{id}/refunds`. [V] <https://docs.clover.com/dev/docs/resetting-the-device>, <https://docs.clover.com/dev/docs/verifying-connectivity>, <https://docs.clover.com/dev/reference/void>.
- **Terminales del comercio:** `GET /v3/merchants/{mId}/devices` (con `serial`). **Pago con tender** (débito o crédito): `GET /v3/merchants/{mId}/payments/{id}?expand=tender`. [V] <https://docs.clover.com/dev/reference/devicegetmerchantdevices>, <https://docs.clover.com/dev/reference/paygetpayment>.
- **Argentina, cuotas y factura:** la terminal muestra pantalla de factura fiscal y de cuotas; por REST se pueden fijar con `regionalExtras.argentina.numInstallments` (1 a 99) e `invoiceNumber` / `skipInvoiceDisplay`. Pesos (ARS) y bimoneda USD. [V] <https://docs.clover.com/dev/docs/regional-extras>.
- **Argentina, limitaciones:** sin preautorizaciones, sin cierre manual (cierre automático), sin devoluciones manuales (sólo de un pago puntual), sin tarjetas guardadas; el App Market no cobra apps al comercio. [V] <https://docs.clover.com/docs/argentine-merchants>.
- **Token:** las llamadas de Pay Display requieren token OAuth (`access_token`); en sandbox se puede usar el token de API específico del comercio de prueba (Settings, API tokens). Producción exige tokens que vencen (v2/OAuth, `access_token` + `refresh_token`, renovación en `POST /oauth/v2/refresh { client_id, refresh_token }`). [V] <https://docs.clover.com/dev/docs/gdp-create-merchant-specific-api-token>, <https://docs.clover.com/dev/docs/generate-expiring-tokens-using-v2-oauth-flow>, <https://docs.clover.com/dev/docs/expiring-tokens-required-in-all-regions>.
- **Webhooks:** son por app (una URL), con verificación por `verificationCode` y header `X-Clover-Auth`; payload `{ appId, merchants: { mId: [{ objectId: "P:<id>", type, ts }] } }`. [V] <https://docs.clover.com/dev/docs/webhooks>.

### Riesgo (a confirmar en sandbox y con Fiserv)

- La página "Argentina merchants" (actualizada 2026-07-08) marca Cloud Pay Display como **no** soportado y sólo Secure Network Pay Display + Payment Connector, mientras que la guía LATAM en español (2026-07-15) y la matriz por región lo listan como disponible. [V ambas]. Un hilo de la comunidad reporta que Cloud Pay Display no aparecía en el App Market de producción para un comercio LATAM [V] <https://community.clover.com/questions/40041/cloud-pay-display-not-available-in-prod-for-a-merc.html>. Un módulo de Odoo afirma funcionar con REST Pay Display en Argentina [V la afirmación] <https://apps.odoo.com/apps/modules/19.0/cr_clover_pos_payment>.
- **Inferido:** que el token de API generado por el comercio sirva en producción para Cloud Pay Display (los docs piden token OAuth de una app semi-integrada). Por eso la conexión acepta `refresh_token` y la Edge renueva el par con la app de NinjaSoft (`CLOVER_APP_ID`).
- **Inferido:** que `regionalExtras` viaje igual en Cloud Pay Display que en el SDK Remote Pay (el esquema OpenAPI de `/v1/payments` no lo lista; la guía regional sí muestra el JSON REST). Sólo se manda si el cajero fija cuotas.
- **Inferido:** que el tender del pago traiga `labelKey` `com.clover.tender.debit_card` / `credit_card` en Argentina. Si no, el POS registra el cobro como crédito (igual que Mercado Point sin dato).

### Pasos para Lucas (no se crearon cuentas a su nombre)

1. Crear la **cuenta de desarrollador global** de Clover con un email que NO esté asociado a otra cuenta de Clover: <https://www.clover.com/global-developer-home/home> (video en español en la guía LATAM). Activar 2FA.
2. En el Global Developer Dashboard: **Test Merchants**, crear un comercio de prueba de **Argentina**.
3. **Create app** semi-integrada (REST Pay Display) con permisos Merchant Read, Payments Read y Payments Write; instalarla en el comercio de prueba.
4. Token de prueba: en el Dashboard del comercio de prueba, con un empleado Admin, Settings, Business Operations, **API tokens**, crear token. Copiar también el **Merchant ID** del comercio de prueba.
5. Terminal: pedir un **Dev Kit** (Flex o Mini) para el sandbox o usar el **emulador Android de Clover** (<https://docs.clover.com/dev/docs/android-emulator-overview>). Instalar y abrir **Cloud Pay Display** (Más herramientas, buscar "cloud", Conectar). Anotar el número de serie (Setup, Devices).
6. En NinjaSoft: Medios de pago, Fiserv, Conectar: Merchant ID, token, Prueba. Habilitar Clover Point y cobrar desde el POS.
7. Webhook (opcional, el poll ya alcanza): en la app, App Settings, Webhooks, URL `https://<proyecto>.supabase.co/functions/v1/clover_webhook`, "Send Verification Code", copiar el código del log de la función, Verify, suscribir **Payments**. Guardar el **Clover Auth Code** como secret de función `CLOVER_WEBHOOK_AUTH`.
8. Producción: enviar la cuenta de desarrollador y la app a aprobación, y escribir a <mailto:developer-relations@devrel.clover.com> y al ejecutivo de Fiserv Argentina preguntando: "¿Cloud Pay Display está habilitado en producción para comercios argentinos (api.la.clover.com) en Flex y Mini? ¿Cómo es la publicación privada de una app semi-integrada en el App Market de Argentina?". Con la app aprobada, cargar `CLOVER_APP_ID` (secret de función) para renovar tokens.

## 2. Payway Point (Prisma)

- Payway ofrece "terminales integradas y PINpad que se conectan a tu sistema de gestión" para grandes comercios [V por snippet: <https://www.payway.com.ar/terminales-punto-venta>; la página dio error de certificado].
- El portal <https://developers.payway.com.ar/catalog> lista APIs "PayStore Terminals" (Reversals, Settlements: anulaciones, devoluciones y cierres de lote) con OAuth2 [V parcial: <https://developers.payway.com.ar/catalog/doc/paystore_terminals_reversals_v1>, SPA no legible]. **No aparece una API para mandar un cobro a la terminal** [I].
- "PayStore" sería la tienda de apps de Smart POS (Phoebus): el camino probable es una app propia en la Terminal Smart con homologación, no un REST [I].
- **Estado:** Próximamente. **Bloqueo:** falta la API de pago a terminal y la vía de homologación.
- **Pasos:** registrarse en el portal de developers de Payway (self-service para comercios) y revisar si existe "PayStore Terminals - Payments"; pedir al ejecutivo de Payway el kit de integradores (API de terminales, homologación PayStore, SDK de la Terminal Smart).

## 3. Getnet Point (Santander)

- El portal global documenta "In-Store Payments: Integrated POS" con modos SDK (USB/HTTP), **Cloud2Cloud** (`CreateCloud`, polling, Sale/Refund, timeout 5 min) y App2App [V] <https://docs.globalgetnet.com/en/products/in-store-payments/integrated-pos>. Es una librería, no un REST plano: desde una Edge Function probablemente haga falta un intermediario [I].
- No dice en qué países aplica; que Cloud2Cloud esté habilitado en Argentina **no está verificado**.
- **Estado:** Próximamente. **Bloqueo:** confirmación de Getnet AR y credenciales de partner.
- **Pasos:** registrarse en docs.globalgetnet.com y usar "Contact us"; contactar a Partnerships de Getnet Argentina (caso e.tres: <https://en.e3stores.com/blog/e-tres-suma-a-getnet-como-solucion-de-cobros-integrada-al-ecosistema>) y preguntar: "¿Cloud2Cloud de Integrated POS está disponible en Argentina para Get Smart / Get POS? ¿Cómo es la homologación?".

## 4. Resto (descartados como Point)

- **Mobbex:** docs públicas sólo de checkout online <https://mobbex.dev>; en 2026 anunció Smart POS multiadquirente sin API documentada [V] <https://mercado.com.ar/tecnologia/mobbex-cumple-10-anos-y-presento-click-to-pay-junto-a-visa>. Paso opcional: consulta comercial.
- **MODO:** no tiene terminal; su QR corre en terminales Payway y Fiserv. Ya integrado como QR.
- **Ualá Bis:** <https://developers.ualabis.com.ar> sólo API de cobros online (v1 se depreca el 31/12/2026) [V]; hardware POS Mini/Pro sin API [I].
- **Viumi (Macro):** <https://developers.viumi.com.ar> sólo Checkout API [V].
- **Naranja X:** usa terminales de Payway, Posnet, Clover o Getnet [V] <https://www.naranjax.com/comercios>; su solución Point es Nave (ya integrada).
- **Posnet / LaPos legacy:** integración "Posnet/LaPos integrado" por serie o ethernet local con protocolo bajo acuerdo, sin docs públicas [I]; requiere un agente en la PC de la caja, no encaja con una web app. Reemplazo moderno: Clover y Terminal Smart.
- **Cuenta DNI (Banco Provincia):** sin terminal propia (funciona sobre Fiserv y Payway) [V] <https://www.bancoprovincia.com.ar/cuentadni/contenidos/cdniComerciosFaq/>. **Personal Pay:** sin terminal ni API presencial [I].

## Ranking

1. **Clover:** implementado; validar en sandbox y confirmar Cloud Pay Display en producción AR.
2. **Getnet:** existe Cloud2Cloud; falta confirmar Argentina y credenciales.
3. **Payway:** hay APIs de terminales en el portal; falta la de pago y la homologación.

Limitaciones: payway.com.ar y developers.payway.com.ar no se pudieron leer directamente; parte de Getnet Cloud2Cloud dio 404; varias conclusiones de "no existe API" se apoyan en no haber encontrado nada.
