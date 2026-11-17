# Matriz de validación de las Edge Functions públicas (SEC-28)

- **Fecha:** 2026-11-17
- **Alcance:** las Edge Functions con `verify_jwt = false` en `supabase/config.toml`. Son **24**, las mismas de `PUBLIC_FUNCTIONS` en `scripts/deploy-check.mjs`. `internal_impersonate` ya tiene `verify_jwt = true` (SEC-26) y queda fuera.
- **Método:** se leyó el `index.ts` de cada Edge y los `_shared` que usa. No se tocó ninguna Edge desplegada: cambiar un `index.ts` genera drift con producción.
- **Registro máquina-legible:** `supabase/security/public-edges.json` (`name`, `auth`, `ipLimit`, `bodyLimit`, `unitTest`, `tasks`, `notes`). `tests/unit/publicEdgesRegistry.test.ts` falla si:
  - una Edge pública no está en el registro;
  - el registro tiene una Edge que ya no es pública (contra `PUBLIC_FUNCTIONS` y contra `config.toml`);
  - lo que declara no se ve en el código: `createIpLimiter`, `readJsonLimited` / `readTextLimited`, verificación de firma, tabla de `state`, SHA-256 o `safeEqual`.
- **Tests de cuerpo malicioso:** `tests/unit/publicEdgesMalicious.test.ts`, contra la lógica pura de `_shared`. Ver § 3.
- **Responsable:** equipo NinjaSoft (seguridad). Las remediaciones quedan en las tareas citadas.

## 1. Glosario de la columna "Autenticación"

| Clave | Qué significa |
|---|---|
| `hmac` | Firma verificada con un secreto compartido (HMAC-SHA256). |
| `reconsulta` | El cuerpo es sólo una pista. El recurso se vuelve a leer en el proveedor con la credencial del negocio (o de la plataforma), y se acredita sólo si coinciden el estado, el intent y el monto. |
| `state` | `state` de OAuth de un solo uso. |
| `api_key` | Clave propia de NinjaSoft, guardada como hash SHA-256. |
| `link_token` | El uuid del cobro, que viaja en el link público, funciona como credencial. |
| `static_token` | Header con un secreto fijo compartido con el proveedor. |
| `app_id` | `application_id` de la app más una cuenta conectada. Sin firma. |
| `rate_limit_email` | Límite por email guardado en la base. |

En la columna "Cuerpo", "sí" significa que la Edge lee el cuerpo con `readJsonLimited` / `readTextLimited` (64 KB por defecto). En la columna "Límite IP", "sí" significa que usa `createIpLimiter`: es best-effort, por isolate (ADR-098).

## 2. Matriz

| Edge | Quién la llama | Autenticación | Cuerpo | Límite IP | Idempotencia | Qué acredita / escribe | Riesgo residual | Tarea |
|---|---|---|---|---|---|---|---|---|
| `catalog_purchase_webhook` | MP (cuenta de la plataforma), `?intent=` | reconsulta (`/v1/payments/{id}` con el token de la plataforma; `external_reference` = intent; monto ±0,01) | sí | no | corta si el intent está `approved`; `finalize_catalog_purchase` idempotente (un 2º pago se audita como duplicado) | compra del catálogo (`finalize_catalog_purchase`), `catalog_payment_intents`, `audit_logs`, `notifications` | sin `x-signature` aunque la plataforma ya tiene `webhook_secret`; el `payment_id` del cuerpo va al path de MP sin validar formato; sin `withWebhookLog` | SEC-32; firma: sin tarea (proponer) |
| `clover_webhook` | Clover (webhook por app) | static_token (`X-Clover-Auth` = `CLOVER_WEBHOOK_AUTH`, `safeEqual`) + reconsulta de hasta 20 intents pendientes por merchant | sí | no | sincroniza intents `pending` (updates condicionales en `clover_server`) | estado de `mp_payment_intents` de Clover | el `POST {verificationCode}` no se autentica (sólo se escribe en el log); el secreto es estático y compartido por todos los merchants | SEC-32 |
| `delivery_channel_webhook` | PedidosYa, Rappi, Uber Eats, MP Delivery, simulador; `?c=<conexión>` | hmac por adaptador: simulador y Rappi con ventana de 300 s; PedidosYa, Uber Eats y MP Delivery rechazan todo (fail closed) | sí (64 KB) | sí (600/min) | `delivery_channel_ingest_event` por conexión + id del evento | pedidos, comandas, estados (RPC con service_role) | gating de `canales_delivery` después de la firma (bien); los adaptadores reales esperan el contrato | — |
| `directo_webhook` | Directo, `?intent=<uuid>` | reconsulta (`get_by_notification/{id}` con la credencial del cobro; `merchantOrderId` del intent) | sí | no | corta si está `approved`; updates condicionales | estado del intent y datos del crédito | por diseño (ADR-181) no exige el monto: si el capital difiere, aprueba y lo marca con `capital_differs` | SEC-32 |
| `dlocalgo_webhook` | dLocal Go, `?intent=` o `?refund=` | hmac (`V2-HMAC-SHA256` con la Secret Key sobre `api_key + cuerpo`) + reconsulta (PAID + `order_id` + ARS + monto exacto) | sí | no | corta si está `approved` / `refunded`; updates condicionales | intent y `dlocalgo_refunds`, `audit_logs` | la firma no lleva timestamp: no hay ventana anti-replay (la idempotencia lo mitiga) | SEC-32 |
| `getnet_checkout` | página pública `/pagar/[intent]?p=getnet` (cliente sin sesión) | link_token (uuid + `init_point` del checkout propio; feature `tenant_has_feature_for`) | sí | sí (120/min) | el `payment_id` se reserva en el intent antes de cobrar (update condicional) | cobro con tarjeta; intent `approved` / `rejected`, `audit_logs` | quien tenga el link puede probar tarjetas (card testing) hasta 120/min por IP y por isolate; el PAN pasa por la Edge (`pay` apagado sin `GETNET_CHECKOUT_API_PCI_ATTESTED`) | — |
| `getnet_webhook` | Getnet y el navegador (retorno); `?intent=` o el `payment_intent_id` del cuerpo | reconsulta (orden con el token del negocio; monto exacto) | sí | no | corta si está `approved`; updates condicionales | estado del intent, `audit_logs` | sin `?intent` busca por el `preference_id` del cuerpo (después se re-consulta igual) | SEC-32 |
| `gocuotas_webhook` | GO Cuotas y el navegador, `?intent=<uuid>` | reconsulta (API Key; `order_reference_id` = intent; centavos exactos) | sí | no | corta si está `approved`; updates condicionales | estado del intent | sin firma documentada; cada aviso dispara una consulta saliente | SEC-32 |
| `ml_oauth_callback` | ruta `/api/ml/oauth/callback` de Next | state (64 hex, `DELETE … RETURNING`, vence a los 15 min) + PKCE | sí | no | el state se consume al leerlo | `ml_account_upsert` (tokens en `ml_tokens`), `audit_logs` | bajo | SEC-32 |
| `ml_webhook` | Mercado Libre (no firma) | app_id (`application_id` de la app, `user_id` conectado, `resource` con el patrón del tópico) | sí (16 KB) | sí (600/min) | `ml_notification_ingest` por `_id` | sólo encola; el worker lee con el token del vendedor | un aviso falso con datos válidos sólo agrega una lectura | — |
| `mobbex_webhook` | Mobbex, `?intent=<id>` | reconsulta (operación con `api_key` + `access_token`; `reference` = intent; `requestedTotal`) | sí | no | corta si está `approved`; `approved` usa `neq approved` y el resto `eq pending` | estado del intent | el `?intent` no se valida como uuid antes de consultar (la base lo rechaza) | SEC-32 |
| `modo_webhook` | MODO, `?intent=<id>` | reconsulta best-effort (`external_intention_id` = intent obligatorio; contrato de MODO "VALIDAR MODO") | sí | no | corta si está `approved`; `neq approved` | estado del intent | **sin re-consulta aplica `rejected` / `cancelled` / `expired` del cuerpo sin verificar**: quien conozca el uuid del intent puede cancelar un cobro pendiente. **No hay `state` de un solo uso** (la tarjeta lo decía) | SEC-32; verificar negativos: sin tarea (proponer) |
| `mp_billing_webhook` | MP (suscripciones de NinjaSoft) | hmac **condicional** (sólo si `platform_secrets.mercadopago.webhook_secret` está cargado) + reconsulta con el token de la plataforma | sí | no | `claim_mp_webhook_event` por evento (`authpay:{id}`) | `subscriptions`, `billing_records`, `notifications`, `system_emails`, `audit_logs` | sin el secreto cargado no se exige firma | SEC-32 |
| `mp_oauth_callback` | front, tras el redirect de MP | state (`mp_oauth_states`, creado por `mp_oauth_start`) + canje del `code` | sí | no | el state se borra al final | `payment_secrets` (tokens), `tenant_payment_methods`, `audit_logs` | el state se lee con SELECT y se borra al final (no atómico); `mp_oauth_states` no tiene vencimiento | SEC-32; TTL del state: sin tarea (proponer) |
| `mp_orders_webhook` | MP Orders API (QR dinámico y Point) | hmac (`x-signature`, modo `report` por `system_settings.mp_webhook_signature_mode`, SEC-60) + reconsulta (processed + monto exacto + `external_reference`) | sí (en `_shared/mpWebhookHandlers.ts`) | no | transiciones desde `pending`; 503 ante fallas transitorias (PAY-27) | estado del intent (`applyOrderToIntent`) | en `report` una firma inválida sólo se anota | SEC-60 (pasar a `enforce`), SEC-32 |
| `mp_token_broker` | sistema externo del mismo negocio (servidor a servidor) | api_key (`x-api-key nsmp_…`, SHA-256, revocable, `allowed_ips` opcional) | no lee cuerpo | no | — | devuelve el access token de MP de producción; `audit_logs`, `last_used_at` | `allowed_ips` compara el primer `x-forwarded-for` (falsificable según el proxy, a confirmar); sin límite por IP (la clave de 40+ caracteres hace inviable adivinarla) | SEC-32 |
| `mp_webhook` | MP Checkout Pro (`?intent=`), contracargos y reclamos | hmac (`x-signature` en modo `report`, SEC-60) + reconsulta del pago con el token del negocio | sí (en `_shared/mpWebhookHandlers.ts`) | no | `neq approved`; 503 ante fallas transitorias (PAY-27) | estado del intent, disputas (`_payment_disputes_upsert`) | en `report` una firma inválida sólo se anota | SEC-60, SEC-32 |
| `nave_webhook` | Nave | reconsulta (`external_payment_id` uuid; URL validada contra los hosts Nave, anti-SSRF; APPROVED + correlación + monto) | sí | no | transiciones condicionales; 5xx ante fallas transitorias | estado del intent | bajo | SEC-32 |
| `payway_checkout` | página pública `/pagar/[intent]` | link_token (uuid del intent; el PAN va del navegador a Payway) | sí | sí (120/min) | `mp_payment_id` guardado; 409 mientras hay un pago en revisión | cobro; intent `approved` / `rejected` | card testing con el link, igual que Getnet | — |
| `payway_webhook` | Payway (legado) | reconsulta (`?i=<12 hex>` contra intents pendientes de 48 h; apikey privada; monto exacto + `site_transaction_id`) | sí | no | `eq pending` | estado del intent | con más de 200 pendientes en 48 h el prefijo puede no encontrarse (funcional, no de seguridad) | SEC-32 |
| `send_password_recovery` | login (sin sesión) | rate_limit_email (3 por email cada 15 min) | sí | sí (10 cada 10 min) | — | `system_emails` | **el `origin` del link sale del cuerpo y la allowlist acepta `https://ninja-soft-pos-<cualquier>.vercel.app` y `http://localhost:<puerto>`**: si un tercero registra ese subdominio en Vercel, el email legítimo lleva un `token_hash` válido a su sitio | sin tarea (proponer, prioridad alta) |
| `talo_webhook` | Talo (sin firma) | reconsulta (`paymentId` = el guardado; SUCCESS / OVERPAID + `external_id` + precio) | sí | no | updates condicionales | estado del intent, monto recibido, devoluciones | sin firma; cada aviso dispara token + consulta saliente | SEC-29, SEC-32 |
| `ualabis_webhook` | Ualá Bis (sin firma), `?intent=` / `?refund=` | reconsulta (uuid de la orden = el del intent; PROCESSED / APPROVED + `external_reference` + monto en pesos) | sí | no | updates condicionales | intent, `ualabis_refunds`, `audit_logs` | sin firma; consulta saliente por aviso | SEC-29, SEC-32 |
| `viumi_webhook` | Viumi (sin firma), `?intent=<uuid>` | reconsulta (uuid de la orden = el del intent; aprobado + centavos exactos) | sí | no | corta si está `approved`; updates condicionales | estado del intent | sin firma; consulta saliente por aviso | SEC-29, SEC-32 |

### Diferencias con lo que decía la tarjeta

- **`modo_webhook` no usa un `state` de un solo uso.** Exige `external_intention_id` = intent y hace una re-consulta best-effort. Sin re-consulta aplica los estados negativos del cuerpo.
- **El HMAC de `mp_billing_webhook` es condicional:** depende de que `webhook_secret` esté cargado en `platform_secrets`.
- **`createIpLimiter` está en 5 Edges:** `delivery_channel_webhook`, `getnet_checkout`, `ml_webhook`, `payway_checkout` y `send_password_recovery`. `mp_token_broker` no tiene límite por IP; sólo una allowlist opcional.
- **El resto se confirmó tal como lo describía la tarjeta:**
  - `x-signature` en `report` y 503 transitorio en `mp_webhook` / `mp_orders_webhook`;
  - HMAC en `delivery_channel_webhook`, `mp_billing_webhook` y `dlocalgo_webhook`;
  - `state` de un solo uso en los dos callbacks de OAuth (en `mp_oauth_callback` no es atómico).

## 3. Tests unitarios con cuerpo malicioso

`tests/unit/publicEdgesMalicious.test.ts` prueba, por proveedor, que ninguno de estos casos acredita:

- monto distinto;
- intent o cobro ajeno;
- id con caracteres de path o uuid inválido;
- firma adulterada, de otra clave, vencida o ausente.

Además, cada proveedor tiene un caso de control que sí acredita, para que el test no pase en vacío.

| Edge | Lógica probada (`_shared`) |
|---|---|
| `talo_webhook` | `talo.decideIntentUpdate`, `parseWebhook` |
| `viumi_webhook` | `viumi.decideIntentUpdate`, `parseWebhook`, `UUID_RE` |
| `ualabis_webhook` | `ualabis.decideIntentUpdate`, `parseWebhook` (incluye un monto en centavos que no vale como pesos) |
| `dlocalgo_webhook` | `dlocalgo.verifySignature`, `decideIntentUpdate`, `parseNotification` |
| `clover_webhook` | `clover.safeEqual`, `evaluateCloverPayment`, `parseCloverWebhook` |
| `nave_webhook` | `nave.resolvePaymentCheckUrl` (SSRF: otro host, http, credenciales en la URL, metadata), `evaluatePayment` |
| `payway_webhook` / `payway_checkout` | `payway.decidePaymentStatus`, `paywayPaymentId`, `classifyPayResponse` |
| `getnet_webhook` / `getnet_checkout` | `getnet.decideIntentUpdate`, `extractWebhookOrderId`, `getnet_api.classifyApiPayResponse`, `isOwnCheckoutIntent` |
| `gocuotas_webhook` | `gocuotas.decideIntentUpdate`, `extractWebhookHint` |
| `directo_webhook` | `directo.decideIntentUpdate` (orden ajena; el monto distinto aprueba y se marca, por diseño), `extractNotificationId` |
| `mobbex_webhook` | `mobbex.decideMobbex` |
| `mp_webhook` / `mp_orders_webhook` / `mp_billing_webhook` | `mpSignature.verifyMpSignature`. Los handlers completos de MP ya están probados en `tests/unit/mpWebhooks.test.ts` (OPS-23) |
| `ml_webhook` | `mercadolibre/notifications.parseNotification` |
| `delivery_channel_webhook` | `deliveryChannels/signature.verifySignatureHeader` y los adaptadores fail closed del registro |

### Sin test unitario: requiere extraer el handler (como OPS-23)

La lógica de estas Edges vive sólo en su `index.ts` y no tiene parser en `_shared`. No se extrajo ahora para no generar drift con lo desplegado.

| Edge | Qué habría que extraer |
|---|---|
| `catalog_purchase_webhook` | Decisión de acreditar: `external_reference`, monto ±0,01, duplicado. |
| `modo_webhook` | `readModo` / `mapStatus` y la regla "sin re-consulta no aprueba". |
| `mp_oauth_callback` | Validación y consumo del `state`, alcance de sucursal. |
| `ml_oauth_callback` | Consumo y vencimiento del `state`. |
| `mp_token_broker` | Formato de la clave, hash, `allowed_ips`. |
| `send_password_recovery` | Allowlist de `origin` y límite por email. |
| `mp_billing_webhook` | Parcial: la firma está probada, pero la decisión de acreditar (931 líneas) vive en el `index.ts`. |
| `getnet_checkout` / `payway_checkout` | Parcial: la clasificación de la respuesta y el monto están probados; el flujo `info` / `pay` (reserva del `payment_id`, recargo del plan) vive en el `index.ts`. |

## 4. Riesgos residuales, por prioridad

1. **`send_password_recovery`: origen del link controlable** (alta, a confirmar).
   - La regex `^https:\/\/ninja-soft-pos(-[a-z0-9-]+)?\.vercel\.app$` acepta cualquier subdominio `ninja-soft-pos-*.vercel.app`. En Vercel, el subdominio de un proyecto es del primero que lo registra.
   - Un tercero puede pedir la recuperación de la cuenta de otra persona con `origin` apuntando a su sitio. La víctima recibe el email legítimo de NinjaPos; si hace clic, el `token_hash` llega al tercero y puede tomar la cuenta. `http://localhost:*` tiene un problema parecido, pero acotado a la máquina de la víctima.
   - Remediación: aceptar sólo `pos.soft.ninja` y las previews del equipo (dominio con el sufijo del team de Vercel), o fijar el origen por variable de entorno.
2. **`getnet_checkout` / `payway_checkout`: card testing con el link del cobro** (media).
   - El uuid del intent es la única credencial. El límite es de 120/min por IP y por isolate, y no hay tope de intentos por intent.
   - Remediación: tope de intentos fallidos por intent en la base y límite por IP persistente (SEC-32).
3. **`modo_webhook`: estados negativos sin verificar** (media).
   - Si la re-consulta no es posible, un cuerpo con el `external_intention_id` correcto puede pasar a `rejected` / `cancelled` / `expired` un cobro pendiente. No acredita, pero corta el cobro.
   - Remediación: no aplicar estados del cuerpo sin re-consulta, o confirmar el contrato de MODO.
4. **Webhooks sin firma (Talo, Ualá Bis, Viumi, GO Cuotas, Getnet, Mobbex, Nave, Payway, Directo, Clover con token estático)** (media).
   - No pueden acreditar con un cuerpo falso (re-consulta), pero cada aviso dispara una consulta saliente con la credencial del negocio (y un token, en Talo). Sin límite por IP, se puede amplificar contra la API del proveedor y gastar su rate limit.
   - Remediación: SEC-29 (token HMAC en la URL de Ualá / Talo / Viumi) y SEC-32 (límite por IP).
5. **MP `x-signature` en `report`** (media-baja). La firma inválida sólo se anota hasta pasar a `enforce` (SEC-60). Mientras tanto la defensa es la re-consulta. `mp_billing_webhook` exige firma sólo con el secreto cargado.
6. **`catalog_purchase_webhook`** (baja).
   - Sin firma y con el `payment_id` del cuerpo directo en el path de `api.mercadopago.com/v1/payments/…` con el token de la plataforma. Un `../` puede apuntar a otro GET de MP. La respuesta no se devuelve y se exige `external_reference` = intent.
   - Remediación: validar `^\d+$` y verificar `x-signature`.
7. **`mp_oauth_callback`** (baja). `mp_oauth_states` no tiene vencimiento y el `state` se consume al final, sin `DELETE … RETURNING`. Remediación: igualarlo a `ml_oauth_callback`.
8. **`mp_token_broker`** (baja). `allowed_ips` confía en el primer `x-forwarded-for`. Hay que confirmar si el proxy de Supabase lo reescribe.
9. **`dlocalgo_webhook`** (baja). La firma no tiene timestamp: una notificación firmada se puede reenviar. Es idempotente, así que no duplica nada.

## 5. Validación de cierre

- `pnpm vitest run tests/unit/publicEdgesRegistry.test.ts tests/unit/publicEdgesMalicious.test.ts`.
- Al agregar o quitar una Edge pública hay que tocar `config.toml`, `PUBLIC_FUNCTIONS` y `supabase/security/public-edges.json`. Si falta alguno, el test de registro falla.
- Al sumar un límite por IP o de cuerpo a una Edge, hay que actualizar `ipLimit` / `bodyLimit` en el registro. El test compara lo declarado con el código.
