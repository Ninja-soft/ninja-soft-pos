# Idempotencia de venta y anulación

Qué pasa si una venta o una anulación se manda dos veces (doble toque, reintento después de un corte, dos cajeros a la vez), qué la protege hoy y qué falta. F1.5, ADR-098; clave de idempotencia de la venta online: SEC-43, ADR-187.

## Resumen

| Operación | Protección en el servidor | Protección en el POS | Riesgo que queda |
|---|---|---|---|
| Venta online (`create_sale`) | Una transacción: entra todo o nada (venta, ítems, pagos, stock, caja, cupón, mesa, delivery, reserva). Clave de idempotencia opcional `p_client_request_id` (uuid, única por negocio): el reintento con la misma clave devuelve la venta ya grabada (`replayed: true`), sin efectos; con otros datos falla con `sale_request_mismatch` (SEC-43). | `handleSale` descarta un segundo "Cobrar" mientras el primero está en vuelo (ref síncrono + botón en carga) y manda la misma clave en los reintentos del mismo cobro. | Ninguno conocido para el POS. Quien llame sin clave (API vieja, otros clientes) sigue como antes. |
| Venta con reparto o envío (`pos_sale_create_fulfilled`, `pos_sale_create_delivery`) | Misma clave dentro de `p_sale`; se mira **antes** de mover stock entre sucursales y de guardar direcciones del cliente, y devuelve la venta y sus entregas. | Igual que la venta online. | El reintento devuelve las entregas sin el código de retiro (sólo se guarda su hash); el POS avisa. No hay forma de regenerarlo. |
| Venta offline (`sync_offline_sale`) | `client_sale_id` único por negocio: el reenvío devuelve la venta ya creada. Si la venta offline es el reintento de un cobro online cortado, lleva además su `client_request_id`: si la online sí entró, la sincronización la reconoce (`synced`, misma venta) y no duplica. | La cola local sólo saca una venta cuando el servidor confirmó. | Ninguno conocido. Ver [`34-venta-offline.md`](./34-venta-offline.md), ADR-077. |
| Cobro en espera (`complete_pending_charge` → `_pc_complete`) | Idempotente por estado: toma el cobro con `for update`; si ya está `completed` devuelve su venta, y si el intent de pago ya tiene venta, la enlaza sin crear otra. La venta se emite una sola vez por cobro. | | Ninguno conocido. ADR-048. No usa la clave de SEC-43 (no hace falta). |
| Anulación (`void_sale`) | `select ... where status = 'completed' for update`: la segunda llamada encuentra la venta `voided` y falla con `sale_not_found_or_not_voidable`. No revierte stock ni caja dos veces. | | Ninguno: es idempotente por estado. |
| Devolución (`return_sale_v2`) | Lock de cada línea vendida (`for update`) y tope por lo ya devuelto (`qty_exceeds`). | | Ninguno conocido. |
| Pagos externos (QR, Point, link) | Intent con estado y updates condicionales; webhooks idempotentes; reintegro MP con `X-Idempotency-Key` (ADR-067). | | Ninguno conocido. |
| API pública (`/api/v1`) | Escrituras en lote con `Idempotency-Key` (ADR-094). | | Ninguno conocido. |

## Venta online: detalle

1. El POS arma el payload y llama a `create_sale` (RPC, una transacción) con `p_client_request_id`.
2. Doble toque: el ref `inFlight` de `modules/pos/screen/usePosSale.ts` corta el segundo llamado antes de que React vuelva a renderizar; después el botón queda deshabilitado por `sale.isPending`.
3. Error de red: el POS **no reintenta solo**. Con la venta offline habilitada muestra "Se cortó la conexión con NinjaSoft. Revisá en Ventas si la venta entró" y pasa a guardar sin conexión sólo cuando el cajero confirma de nuevo (ADR-077); sin ella, muestra "No se pudo cobrar" con el detalle. Tanto si el cajero vuelve a cobrar online como si lo guarda sin conexión, va la misma clave: si la venta había entrado, el servidor la devuelve (online) o la reconoce al sincronizar (offline).
4. Error de negocio (precio cambiado, stock, plan, PIN): la transacción no grabó nada (tampoco la clave); se puede reintentar.
5. Misma clave con otros datos (por ejemplo, otro medio de pago después del corte): el servidor responde `sale_request_mismatch: <número>` y el POS muestra "Esta venta ya se registró (N° X) con otros datos. Revisá Ventas antes de volver a cobrar." La clave no se descarta (puede ser el reintento de esa venta): si de verdad es otra venta, el aviso tiene la acción **Es una venta nueva**, que rota la clave, y el cajero cobra de nuevo.

**Regla operativa para el piloto:** ante un corte en el medio de un cobro, mirar **Ventas** antes de cobrar de nuevo. El mensaje de error del POS lo dice.

## Clave de idempotencia (SEC-43)

**Servidor** (`supabase/migrations/20270123100000_sec43_create_sale_idempotency.sql`):

- `sales.client_request_id uuid` con índice único parcial `sales_client_request_uniq (tenant_id, client_request_id) where client_request_id is not null`. La misma clave en otro negocio no choca.
- `sales.client_request_hash text`: huella del pedido (md5 de un jsonb canónico). En `create_sale`: ítems, pagos, descuento, cliente, extras (propina, garantía, recargo, packs, turno, reserva), mesa, delivery, promo (monto e id) y cupón. Afuera quedan turno de caja, notas, nombre de la promo y período del servicio: la venta offline después de un corte no los manda igual. Con reparto o envío, la huella es la del pedido que mandó el POS (`p_sale` + plan, `_sale_request_plan_hash`), que el wrapper deja en `ninja.sale_request_hash` (recién cuando no es un replay) para que `create_sale` la guarde.
- `create_sale(..., p_client_request_id uuid default null)`: parámetro opcional al final; los llamadores internos (`_channel_bill`, `_pc_complete`, `_pc_dry_run`, `exchange_sale`) siguen con 14 argumentos.
- Con clave, apenas resuelve el negocio llama a `_sale_request_replay`: advisory lock por (negocio, clave), busca la venta y compara la huella. Si existe y coincide, devuelve el mismo jsonb que la primera vez más `replayed: true`, rearmado desde las filas por `_sale_replay_result`, sin tocar nada más. Si no coincide, `sale_request_mismatch: <número>` (detalle con `sale_id` y `number`). Dos envíos simultáneos se serializan en ese lock, antes de cualquier lock de fila o efecto: el segundo espera, ve la venta del primero (read committed) y la devuelve.
- La venta se graba con la clave y la huella, y el insert usa el índice como árbitro (`on conflict ... do nothing`): si otro camino grabó la misma clave, devuelve esa venta (con el mismo control de huella). El insert de la venta es lo primero que escribe la función, así que no hay stock, caja ni cupón que deshacer. Se eligió esto en lugar de capturar `unique_violation` porque un bloque `exception` abre una subtransacción en cada venta; `on conflict` con el índice explícito es igual de estricto.
- `pos_sale_create_fulfilled` lee la clave de `p_sale` (`p_client_request_id`, o `client_request_id`) y hace el chequeo **antes** de mover stock entre sucursales. `pos_sale_create_delivery` lo hace **antes** de guardar direcciones del cliente (`_customer_address_insert`) y del `update dispatches ... ship_to` con su auditoría: el reintento no escribe nada. Ambos devuelven la venta y sus entregas (`_sale_fulfilled_replay_result`) con `pickup_code: null` y `has_pickup_code`.
- `_offline_run_sale` pasa `client_request_id` del payload offline a `create_sale`. Si es un replay, no marca la venta online como offline (`offline_sold_at` / `offline_client_id`), y `sync_offline_sale` la deja `synced` con esa venta. Con otros datos queda `needs_review` con el error `sale_request_mismatch`.
- Todos los helpers son internos (`revoke all from public, anon, authenticated`).

**POS** (`lib/pos/saleRequestKey.ts`, `modules/pos/screen/usePosSale.ts`):

- La clave nace en el primer "Cobrar" del carrito y se reusa mientras el carrito sea el mismo: líneas base (`saleCartBaseItems`: sin el recargo del medio o de las cuotas ni la garantía que agrega la hoja de cobro), cliente, mesa, delivery, turno de agenda y reserva. Los pagos y el recargo no cuentan: cambiar de 3 cuotas a efectivo reusa la clave y el servidor detecta la venta ya hecha (`sale_request_mismatch`).
- Ciclo de vida (`saleKeyAfter`): se borra **sólo** al confirmar la venta (online o guardada sin conexión). Vaciar el carrito o un `sale_request_mismatch` no la borran; rota sola si cambia la firma del carrito y a mano con **Es una venta nueva**. Si el reintento devuelve una venta ya registrada, el aviso dice "La venta #N ya estaba registrada". Se guarda en `sessionStorage` (con try/catch) para sobrevivir a una recarga del POS.
- La venta guardada sin conexión después de un corte lleva la clave pendiente si el carrito es el mismo.
- Si el reintento devuelve entregas que piden código de retiro, el POS avisa que el código se mostró en el primer intento (no hay forma de regenerarlo; revisar la entrega en Expedición).
- La venta que crea la conciliación de Mercado Pago (`components/reports/processors/LineActionModals.tsx`) usa una clave por línea de conciliación (`stableRequestId`, en `sessionStorage`), que se borra al conciliar. En un mismatch sólo avisa (la venta de esa línea ya existe: se vincula a mano).
- Factura electrónica: el replay vuelve a llamar a `emitirVentaEnSegundoPlano`, sin riesgo. `arca_wsfe` (`emitir_venta`) no crea comprobantes: busca el de la venta y sólo procesa uno `pendiente` (por `arca_claim`); si ya está aprobado devuelve su estado. `fiscal_documents_idem_uq` impide dos comprobantes por venta, tipo y punto de venta.

**Tests:** `tests/unit/saleIdempotency.test.ts` (reglas de la clave, storage, mensaje; la migración es copia de producción con bloques marcados para las cuatro funciones) y `tests/integration/rls-sale-idempotency.test.ts` (misma clave dos veces y en paralelo; mismatch; sin clave; otro negocio; venta offline con la clave de una online que entró; venta con envío sin volver a guardar la dirección; helpers cerrados).

## Pendiente

- Nada conocido para el POS. Las integraciones que llaman a `create_sale` sin clave (canales, API) siguen con su propia idempotencia.
