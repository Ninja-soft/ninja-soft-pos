# 30 · Integración con NubCeo

> Documento vivo. Decisión en [ADR-062](./17-decision-log.md). Si el código y este documento dicen cosas distintas, manda el código: `supabase/functions/_shared/nubceo.ts` (lógica pura, con tests), `supabase/functions/nubceo_sync/index.ts` (Edge) y `supabase/migrations/20261025100000_integracion_nubceo.sql`.

## 1. Para qué sirve

NubCeo es un sistema de **conciliación de cobros**: recibe cada venta con el detalle de cómo se pagó (tarjeta, cupón, lote, autorización, n° de comercio, billetera, operación de Mercado Pago...) y la cruza con lo que después liquidan las pasarelas (Prisma/Payway, Fiserv, Getnet, Mercado Pago, Naranja, GO Cuotas). Con eso arma los **asientos contables** de cada liquidación.

NinjaPOS le manda **una venta por comprobante con sus pagos adentro**, de una sola mano, y trae de vuelta los asientos.

El conocimiento de la API sale de la integración de ANDESMAR (mismo dueño), que manda ventas reales a producción desde el 14-09-2026, y del documento oficial **"Especificación API Ventas y Contabilidad, nubceo Conciliaciones 5.0" (versión 5)**. Acá se reimplementó de forma nativa: Edge Function + pg_cron, sin servicio externo.

## 2. La API (lo que se usa)

| Uso | Pedido | Notas |
|---|---|---|
| Login | `POST https://connectapi.nubceo.com/authenticate` `{API_KEY, API_SECRET}` → `{token}` | JWT de ~1 h. Se renueva a los 50 min o ante un 401 (un reintento). |
| Mandar ventas | `POST /v1/tenants/:tenant/reconciler/sales` `[venta...]` | Hasta 500 por pedido. **Todos los pedidos son secuenciales** (lo exige NubCeo). |
| Borrar ventas | `POST /v1/tenants/:tenant/:companyId/reconciler/sales/delete` `{ids}` | No borra una venta con pagos ya conciliados. |
| Compañías | `GET /v1/tenants/tenants/:tenant/companies` | Para el `companyId` (se elige por CUIT). |
| **Asientos** | `GET /v1/tenants/:tenant/accounting/ledger-header` | Paginado (`page`, `pageSize`), filtros `filter[prop][op]=valor`, orden `sort[prop][dir]`. Devuelve cabeceras con `LedgerEntries[]` y su `AccountingAccount`. |
| Confirmar asientos | `PATCH /v1/tenants/:tenant/accounting/ledger-header/status` `{status, ids}` | `confirmed` / `not_confirmed`. |

**Hallazgo clave:** la API **sí expone lectura de asientos** (sección "Endpoints de Contabilidad" de la especificación 5). ANDESMAR no la usa (sólo manda); NinjaPOS la usa para importar. Además se dejó la importación por **CSV** como alternativa (para quien baja la exportación o todavía no tiene la API habilitada); NubCeo no publica el formato de su exportación, así que el lector acepta los nombres de columna habituales (ver §7).

También existen (no se usan todavía): `GET /reconciler/sales` con `reconciliationStatus` y `getReconciledSales=true` (estado de conciliación por venta y pago), `PUT .../reconciler/sales/:saleId` (modificar) y los procesos asincrónicos `insert-async` / `delete-async` / `request-result`.

### Respuestas (misma lectura que ANDESMAR)

| Respuesta | Resultado |
|---|---|
| 200: la venta en `insertedSales` | Enviada |
| 200: la venta en `summary.existingSalesIds` ("ID for company id N") | Enviada, marcada "Ya estaba" |
| 200 sin nombrarla | Reintento (es seguro: el id es fijo) |
| 400 con `SaleIndexNumber` | Esas ventas a error "Rechazada por NubCeo" con el mensaje; **el resto de la tanda se reenvía** en la misma vuelta (un 400 rechaza toda la tanda) |
| 400 sin índice | Se parte la tanda en mitades hasta aislar la que falla |
| 401/403 | Credenciales: nada cambia de intento, la vuelta falla; tres vueltas seguidas fallidas pausan 30 min |
| 5xx, red, timeout | Reintento con espera creciente 1, 5, 15, 30, 60 y 180 min; con los intentos agotados (8 por defecto), error |

## 3. Qué se manda

Una venta completada de NinjaPOS, con:

| Campo de NubCeo | De dónde sale |
|---|---|
| `id` | **Llave de idempotencia.** Prefijo (por defecto `NP-`) + n° de venta (o el uuid). Se fija al encolar y no cambia nunca (renumerar duplicaría en NubCeo). Si choca con uno ya usado se le suma el comienzo del uuid. |
| `customerBranchReference` | El **código de sucursal cabecera** que el negocio carga por sucursal (la sucursal dada de alta en NubCeo). Sin código, la venta queda en error de configuración. |
| `taxCode` | CUIT de la conexión (obligatorio si la cuenta de NubCeo tiene varias empresas). |
| `date` | Fecha de la venta en hora de Argentina (`-03:00`). |
| `type` | `invoice`; una devolución en efectivo va como `creditNote` con todo negativo e id `<id de la venta>-NC<n° de devolución>`. |
| `grossAmount` | Suma de los pagos incluidos, **sin el vuelto** (si los cobros superan el total, el excedente sale del efectivo). |
| `netAmount` / `taxAmount` | NinjaPOS guarda precios finales (sin IVA separado): por defecto neto = total. El negocio puede elegir IVA 21 %, 10,5 % o 27 % incluido. Se calcula en centavos: `gross = net + tax` siempre cierra (NubCeo rechaza si no). |
| `categoryOne/Two/Three` | A elección: sucursal, caja, cajero, cliente, canal (`POS`), texto fijo o nada. Por defecto sucursal, caja y `POS`. |
| `internalReference` | "Venta N" (o nada). |
| `relatedPayments[]` | Un pago por cobro incluido: `id` = `<id>-<n>` (orden estable), `paymentType` y plataforma por medio, cupón, lote, autorización, cuotas, últimos 4 enmascarados, n° de comercio, terminal, operación del proveedor y documento del cliente (cada dato se puede apagar). |

**Plataforma de cada pago** (`platformExternalCode`): la fija del medio si el negocio la eligió; si no, la del proveedor que cobró (QR, link o Point: `mercadopago` → `mercadopago_ar`, `getnet_point` → `getnet_ar`, `fiserv_point` → `fiserv_ar`...) o la de la **terminal elegida en el cupón del posnet** (`card_voucher.adquirente`: Payway → `prisma_ar`, Getnet → `getnet_ar`...). Sin plataforma, la clave no viaja (NubCeo no la exige).

**Marca** (`cardBrand`): la del cupón traducida a la lista de NubCeo (Visa → `VISA`, con débito `VISA DEBIT`; American Express → `AMEX`...), con excepciones configurables.

**Medios por defecto:** efectivo, débito, crédito, transferencia (`offline`), QR (`qr`) y Directo van; otro medio, vale o saldo a favor y cuenta corriente **no** van (no es plata que entra). Una venta sin ningún medio incluido no se manda.

## 4. Cómo funciona

```
venta completada ──trigger──► nubceo_sync (pending)
                               │
pg_cron cada minuto ──► ¿nubceo_any_due()? ──► Edge nubceo_sync (X-Cron-Secret)
                               │
       por negocio vencido (activo, en su ventana, con la feature):
       siembra → toma con lease → snapshot → clasifica y arma →
       [solo simular: guarda el JSON] / [POST secuencial a NubCeo] →
       borra las anuladas → resultados fila por fila → cierre de la vuelta
```

- **Encolado:** trigger `AFTER INSERT OR UPDATE OF status ON sales` (completada → pendiente; anulada → excluida si no salió, **borrado en NubCeo** si ya salió, o marcada si se está mandando) y `AFTER INSERT OR UPDATE OF total ON sale_returns` (nota de crédito). Los triggers están envueltos en `exception when others`: **NubCeo nunca frena una venta**. La "siembra" de cada vuelta recupera lo que el trigger no alcanzó (desde la fecha de inicio).
- **Ritmo:** cada 5, 15, 30 minutos, 1, 2, 6, 12 horas o una vez por día, con **ventana horaria** en hora de Argentina (días y franja; una franja que cruza la medianoche cuenta el día del inicio). La base decide (`next_run_at`, `nubceo_in_window`); la Edge procesa hasta 20 negocios por llamada con un presupuesto de 40 s. "Enviar ahora" corre una vuelta en el momento (ignora la ventana).
- **Solo simular:** arma cada venta y guarda el JSON (`simulated`) sin mandar nada. Apagar la simulación **no** manda lo simulado (para no generar una avalancha): en Envíos, "Mandar las simuladas".
- **Fecha de inicio:** sólo se mandan ventas desde ahí. Si se prende sin fecha, desde ese momento (nunca el histórico sin pedirlo).
- **Estados:** `pending` → `sending` (lease de 10 min) → `synced` / `error`; `excluded` (regla, usuario o anulación); `simulated`; `delete_pending` → `deleted` (o vuelve a `synced` con el aviso "NubCeo ya la concilió").
- **Cambiar la configuración** devuelve a la cola lo excluido por regla y lo que falló por configuración (nunca lo ya enviado).

## 5. Pantallas

**Configuración > Integraciones > NubCeo** (dueño o encargado; escribir pide la feature):

1. **Configuración:** conexión por ambiente (Prueba / Producción: API key, API secret, tenant, CUIT, URL avanzada) con "Probar conexión" (login + compañías, guarda el `companyId` del CUIT); envío (activa, ambiente, solo simular, desde, ritmo, ventana); sucursales incluidas con su código de sucursal cabecera; medios de pago (va, `paymentType`, plataforma) y plataforma por proveedor o terminal; **mapeo de campos** (campo de NubCeo → dato de NinjaPOS) con vista previa del JSON de una venta de ejemplo; devoluciones, anulaciones y asientos automáticos.
2. **Envíos:** estado (modo, última vuelta, próxima, "Enviar ahora"), período, sucursal y búsqueda; pestañas Enviadas, Pendientes, Con error y Excluidas con cantidades; por fila el JSON enviado (o cómo saldría), la respuesta de NubCeo, Reintentar, Excluir (con motivo) y Borrar de NubCeo (con motivo); "Reintentar todas" y "Mandar las simuladas"; **totales por día** y las últimas vueltas.
3. **Asientos contables:** "Traer de NubCeo" (desde la última importación o la fecha elegida), "Importar CSV" con vista previa, filtros por fecha y estado, renglones con cuenta, subcuenta, centro de costo, Debe y Haber, y confirmar o desconfirmar en NubCeo los que vinieron por API.

## 6. Seguridad

- `nubceo_credentials`: RLS activa **sin policies** y sin grants a `anon` ni `authenticated`; sólo la Edge (service_role) la lee. Se escribe por `nubceo_credentials_set` (el secreto vacío conserva el guardado); `nubceo_settings_get` devuelve sólo la terminación de la API key, nunca el secreto. Los secretos no se loguean ni se auditan.
- `api_url` sólo acepta `https://*.nubceo.com` (check en la tabla, RPC y TS): quien configura no puede mandar el secreto a otro servidor.
- Lectura de `nubceo_settings`, `nubceo_sync`, `nubceo_runs` y asientos: `(tenant_id = current_tenant_id() and nubceo_can_view()) or internal_scope()` (ADR-052). La cajera no ve nada. Sin escritura directa: todo por RPC `SECURITY DEFINER` con auditoría.
- Las funciones del sincronizador (`nubceo_claim`, `nubceo_snapshots`, `nubceo_apply_results`, `nubceo_seed`, `nubceo_due_tenants`, `nubceo_finish_run`, `nubceo_ledger_upsert`, `nubceo_edge_guard`) sólo para `service_role`.
- La Edge en modo usuario exige JWT de dueño o encargado del negocio activo con la feature (`nubceo_edge_guard`).

## 7. CSV de asientos

Un renglón por línea del asiento. Columnas reconocidas (sin importar mayúsculas, tildes ni orden): fecha, número (o id del asiento), categoría, estado, moneda, código y nombre de cuenta, subcuenta, centro de costo, y **Debe y Haber** o un **importe con signo** (positivo al Debe). Separador `;`, `,` o tabulación; decimales con coma o punto; fechas `dd/mm/aaaa` o `aaaa-mm-dd`. Se agrupa por id o por número + fecha; un asiento que ya estaba se reemplaza. Avisa los que no cierran.

## 8. Puesta en marcha

1. Aplicar `20261025100000_integracion_nubceo.sql` y `20261025100100_nubceo_cron.sql` (después de las de ADR-060).
2. Desplegar la Edge `nubceo_sync` con **verify_jwt = true** (el cron manda el anon key como Bearer; la autenticación real es `X-Cron-Secret`). Usa los secrets estándar `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_ANON_KEY`; el cron lee `platform_secrets('internal_cron')` (`token` y `apikey`), igual que `account_reminders` y `pending_charges_sync`.
3. El dueño pide a NubCeo: **API key, API secret y número de tenant** (y si hay ambiente de prueba, su URL), y da de alta en NubCeo cada **sucursal cabecera** con un código.
4. En NinjaPOS: cargar las credenciales, "Probar conexión", cargar el código de cada sucursal, revisar medios y mapeo, prender en **Solo simular** unas horas y revisar los JSON en Envíos.
5. Apagar la simulación con una venta chica y controlarla en NubCeo; después "Mandar las simuladas" si corresponde.

## 9. Preguntas abiertas para NubCeo (no bloquean)

- ¿`platformBranchReference` es el "Número de comercio" de su planilla de sucursales? (misma duda que ANDESMAR).
- ¿Tienen ambiente de prueba con otra URL o se usa un tenant de prueba en producción?
- Formato exacto de la exportación de asientos (para afinar el CSV) y signo de `LedgerEntry.amount` (se asume positivo = Debe).
- Límites de frecuencia y tamaño de tanda recomendados (se usa 100 por tanda, máximo 500).
- `moddo_ar` es MODO: confirmar el código.

## 10. Pendientes

- Mostrar el estado de conciliación por venta (`GET /reconciler/sales` con `reconciliationStatus`).
- Modificar una venta ya enviada (`PUT`) en lugar de borrar y reenviar.
- Nota de crédito por anulación parcial y devoluciones a tarjeta (hoy sólo efectivo).
- Aviso por email o WhatsApp cuando una vuelta falla seguido (hoy se ve en la pantalla).
