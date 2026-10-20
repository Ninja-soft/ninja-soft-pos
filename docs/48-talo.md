# 48 · Talo

> Relevamiento del 2026-10-20 y lo que integramos (ADR-175). Talo (Talo Pay) es una fintech argentina que cobra transferencias bancarias con un **CVU y un alias únicos por pago** y confirma la acreditación sola, sin pedir comprobante.

## 1. Qué ofrece

| Producto | Qué es | ¿API pública? | En NinjaSoft |
|---|---|---|---|
| **Payments API (transferencias)** | Un pago con CVU y alias exclusivos, link de pago (`payment_url`), estados SUCCESS / OVERPAID / UNDERPAID / EXPIRED y webhook ([docs](https://docs.talo.com.ar/transfers/payments-api)) | **Sí**, con sandbox propio y simulador | **Integrada**: hoja de cobro, cobros en espera, webhook, cron y devoluciones |
| Devoluciones | Total o parcial sobre un pago ([docs](https://docs.talo.com.ar/transfers/refunds)) | Sí | **Integrada** (total y diferencia de un OVERPAID) |
| Customers API (clientes fijos) | CVU permanente por cliente ([docs](https://docs.talo.com.ar/transfers/customers-api)) | Sí | No (un CVU por venta alcanza para el POS) |
| Reportería y conciliación | Listado de pagos y transacciones ([docs](https://docs.talo.com.ar/transfers/reporting)) | Sí | Pendiente (ver §6) |
| Programa de partners | La plataforma da de alta comercios y opera en su nombre con un token `PAR-` ([intro](https://docs.talo.com.ar/partners/introduction), [autenticación](https://docs.talo.com.ar/partners/authentication)) | Sí, con credenciales de partner (producción a pedido) | **Dormido**: la credencial `PAR-` ya se acepta; falta el flujo de alta (ver §6) |
| Crypto y PIX | Cobro en cripto y pagos de Brasil | Deprecados desde el 1/10/2026 (HTTP 503) | No aplica |

## 2. API verificada

Fuente: [docs.talo.com.ar](https://docs.talo.com.ar), leída el 2026-10-20.

### Ambientes ([sandbox](https://docs.talo.com.ar/sandbox), [simulador](https://docs.talo.com.ar/sandbox/simulator))

| | Sandbox | Producción |
|---|---|---|
| API | `https://sandbox-api.talo.com.ar` | `https://api.talo.com.ar` |

La cuenta de sandbox es **aparte** de la de producción (se crea en Talo Sandbox, con sus propias credenciales). El simulador acredita una transferencia de prueba: `POST /cvu/{cvu}/faucet { amount }` con Bearer.

### Autenticación de un comercio ([docs](https://docs.talo.com.ar/ecommerce/API/API_Reference/authentication))

- El comercio genera **`client_id` y `client_secret`** en **Dashboard › Usuario › Credenciales**.
- Token: `POST /users/{user_id}/tokens { client_id, client_secret }` → `{ message, error, data: { token: "TL-..." } }`.
- Se usa como `Authorization: Bearer TL-...` en todas las llamadas autenticadas. La doc **no dice cuánto dura** el token.

Es la credencial que usamos: no necesita el programa de partners ni un acuerdo comercial.

### Pagos ([docs](https://docs.talo.com.ar/transfers/payments-api))

- **Crear:** `POST /payments/` (**público**, sin `Authorization`: el `user_id` del cuerpo identifica al comercio) con `user_id`, `price: { amount, currency: "ARS" }`, `payment_options: ["transfer"]` y opcionales `external_id`, `webhook_url`, `redirect_url`, `motive`, `client_data`. Respuesta: `data.id`, `payment_status: "PENDING"`, `quotes[0].cvu`, `quotes[0].alias`, `payment_url`, `expiration_timestamp`.
- **Consultar:** `GET /payments/{id}` (Bearer). `quotes[0].address` es el CVU, `transaction_fields.total_paid` lo recibido y `refunds[]` las devoluciones.
- **Estados:** `PENDING`, `SUCCESS` (monto exacto), `OVERPAID` (de más), `UNDERPAID` (de menos), `EXPIRED` (el CVU vence a los ~5 días; se extiende con `PUT /payments/{id}/expiration`).

### Webhook ([docs](https://docs.talo.com.ar/transfers/webhooks))

- `POST` a `webhook_url` con `{ "message": "Pago Actualizado", "paymentId", "externalId" }`.
- **Sin firma**: la firma HMAC `X-Talo-Signature` figura como "próximamente". La doc pide confirmar siempre con `GET /payments/{id}` y responder 200 rápido (menos de 3 segundos).
- No documenta reintentos.

### Devoluciones ([docs](https://docs.talo.com.ar/transfers/refunds))

- `POST /payments/{id}/refunds` (Bearer) con `refund_type: "FULL" | "PARTIAL"`, `amount` (string, sólo PARTIAL), `currency: "ARS"`, **`blame: { team_id, mail }` obligatorio** (quién pide la devolución) y `user_id`.
- `blame` **no es un enum**: es un objeto que identifica al equipo y a la persona responsable. Mandamos `team_id: "ninjasoft-pos"` y el email del usuario de NinjaSoft que la pide.
- La respuesta trae el **pago completo**; la devolución nueva es el último de `data.refunds[]` (`refund_status` PENDING, SUCCESS o FAILED).

## 3. Qué implementamos

- **Feature `talo`** (OPTIONAL, grupo `pagos`, Pro, Business y Enterprise), `payment_method_plan_key('talo')`, catálogo (`payment_providers`, marca `talo`, canal `qr_link`). Migración `20270113100000_talo`.
- **Conexión** (Configuración › Medios de pago › Talo): User ID, Client ID y Client Secret en `payment_secrets` (provider `talo`, por negocio o por sucursal). `set_payment_secret` pide un token antes de guardar: si Talo las rechaza, no se guardan. "Probar conexión" detecta credenciales del otro ambiente. El switch Sandbox elige el host.
- **Cobro en el POS:** en el grupo **Transferencia**, el botón **Talo**. Crea un intent (`mp_payment_intents`, `provider_key='talo'`) y el pago con `external_id` = intent y `webhook_url` = `https://hooks.soft.ninja/talo?intent=<id>`. La pantalla muestra el **alias y el CVU grandes y copiables**, el total y un **QR del link de Talo**. Sondea cada 3 segundos (Edge `talo`, action `status`).
- **Confirmación** (siempre sobre el pago **re-consultado**, nunca sobre el cuerpo del webhook): tiene que ser el pago guardado en el intent, con el intent como `external_id` y el precio del intent.
  - `SUCCESS` → venta confirmada.
  - `OVERPAID` → venta confirmada por el total y aviso de la diferencia, que se devuelve desde Ventas › Cobros QR.
  - `UNDERPAID` → la venta **no** se cierra: el POS muestra cuánto llegó y cuánto falta.
  - `EXPIRED` → cancelado.
  - `mp_payment_intents.paid_amount` guarda lo recibido.
- **Webhook** `talo_webhook` (`verify_jwt = false`, `withWebhookLog`, siempre 200): re-consulta y sincroniza de forma idempotente. Un cobro cerrado en el POS al que igual le llega la transferencia pasa a aprobado y queda en la conciliación como cobro sin venta.
- **Cobros en espera:** se pueden dejar en espera (el link de Talo se comparte). Tope de 3 días (`pending_charge_max_ttl('talo') = 4320`, espejo en `modules/pending-charges/logic.ts`): el CVU vive ~5 días. El cron `pending_charges_sync` también re-consulta los de Talo, porque el webhook no tiene firma ni reintentos documentados y una transferencia puede llegar horas después.
- **Devoluciones** (Ventas › Cobros QR, dueño o encargado), tabla `talo_refunds` (RLS sólo lectura del negocio, una devolución en curso por cobro, una hecha por tipo):
  - **Devolver**: todo lo cobrado, sin venta vigente. Es `FULL`, o `PARTIAL` por el saldo si ya hubo otra devolución.
  - **Devolver diferencia**: lo transferido de más en un OVERPAID (`PARTIAL`), con la venta vigente.
  - El monto sale siempre del pago re-consultado. El estado de una devolución en curso se actualiza con cada re-consulta del pago.
- **Logos oficiales:** isotipo y logo del encabezado de talo.com.ar (SVG con el isotipo verde `#71E150`), en `public/images/payments/talo-*.webp`.

## 4. Inferido (a confirmar con el sandbox)

- El cuerpo del create puede venir con o sin el envelope `{ data }` (la doc muestra los dos estilos según el endpoint): se aceptan los dos.
- La vida útil del token `TL-`: se toma el `exp` si es un JWT y, si no, se renueva cada 10 minutos (y ante un 401).
- Una segunda transferencia al mismo CVU suma a `total_paid` (un UNDERPAID que se completa pasa a SUCCESS u OVERPAID). Por eso el POS le dice al cliente que transfiera lo que falta al mismo CVU.
- La devolución vuelve a la cuenta de origen de la transferencia (la doc muestra una transacción OUTBOUND ligada a la de entrada).
- Talo no fija un monto mínimo ni máximo por pago: usamos un tope propio de $99.999.999.

## 5. Qué tiene que hacer el dueño

1. Crear su cuenta en Talo y activarla (para probar, una cuenta en Talo Sandbox).
2. En el Dashboard de Talo, **Usuario › Credenciales**: generar las credenciales y copiar el **User ID**, el **Client ID** y el **Client Secret**.
3. En NinjaPOS, **Configuración › Medios de pago › Talo › Conectar**: elegir el ambiente (Sandbox o Producción), pegar los tres datos y guardar. Activar el canal.
4. Cobrar: en el POS, **Transferencia › Talo**.

No hace falta cargar la URL del webhook en Talo: va en cada pago.

## 6. Pendientes

- **Deploy:** aplicar `20270113100000_talo`; desplegar las Edge `talo` y `talo_webhook`, más `set_payment_secret` y `pending_charges_sync`. El dominio de hooks ya enruta `/talo` (`lib/hooks.ts`).
- **Primer cobro real en sandbox:** confirmar con el simulador (`/cvu/{cvu}/faucet`) los puntos de §4 y una devolución.
- **Programa de partners** (alta de comercios sin que copien credenciales): requiere credenciales de partner de producción (se piden a soporte de Talo). La credencial `{ user_id, access_token: "PAR-..." }` ya se acepta en `payment_secrets` y el cliente la usa como Bearer. Falta:
  - el flujo de alta: redirect a `https://app.talo.com.ar/authorize/{partner_id}?referred_user_id=...`, callback con `code` (vale 5 minutos) y `POST /auth/tokens { code, client_id: partner_id, client_secret }`;
  - guardar el `partner_id` y el secreto en `platform_secrets` (`talo_partner`) para que quede dormido hasta tenerlos;
  - mandar `partner_id` al crear pagos.

  La doc no dice si el token `PAR-` vence ni cómo se renueva.
- **Firma del webhook:** cuando Talo publique `X-Talo-Signature`, validarla con el `client_secret` (hoy se re-consulta siempre, así que no es un hueco de seguridad).
- **Extender el vencimiento** (`PUT /payments/{id}/expiration`) al extender un cobro en espera: hoy el tope de 3 días queda dentro de los ~5 días del CVU.
- **Conciliación de liquidaciones y tesorería:** Talo como billetera en Tesorería y su reporte de transacciones en la conciliación de procesadores (`settlements`).
- **Viumi:** en esta rama sólo se sumaron sus logos oficiales (viumi.com.ar) y el logo en el panel del login. La integración vive en otra rama.
