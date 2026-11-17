# Idempotencia de venta y anulación

Qué pasa si una venta o una anulación se manda dos veces (doble toque, reintento después de un corte, dos cajeros a la vez), qué la protege hoy y qué falta. F1.5, ADR-098; clave de idempotencia de la venta online: SEC-43, ADR-187.

## Resumen

| Operación | Protección en el servidor | Protección en el POS | Riesgo que queda |
|---|---|---|---|
| Venta online (`create_sale`) | Una transacción: entra todo o nada (venta, ítems, pagos, stock, caja, cupón, mesa, delivery, reserva). Clave de idempotencia opcional `p_client_request_id` (uuid, única por negocio): el reintento con la misma clave devuelve la venta ya grabada, sin efectos (SEC-43). | `handleSale` descarta un segundo "Cobrar" mientras el primero está en vuelo (ref síncrono + botón en carga) y manda la misma clave en los reintentos del mismo cobro. | Ninguno conocido para el POS. Quien llame sin clave (API vieja, otros clientes) sigue como antes. |
| Venta con reparto (`pos_sale_create_fulfilled`) | Misma clave dentro de `p_sale`; se mira **antes** de mover stock entre sucursales y devuelve la venta y sus entregas. | Igual que la venta online. | El reintento devuelve las entregas sin el código de retiro (sólo se guarda su hash). Con envío (`pos_sale_create_delivery`), una dirección marcada "guardar en el cliente" se vuelve a guardar. |
| Venta offline (`sync_offline_sale`) | `client_sale_id` único por negocio: el reenvío devuelve la venta ya creada. | La cola local sólo saca una venta cuando el servidor confirmó. | Ninguno conocido. Ver [`34-venta-offline.md`](./34-venta-offline.md), ADR-077. |
| Cobro en espera (`_pc_complete`) | La venta se emite una sola vez por cobro (estado + lock). | | Ninguno conocido. ADR-048. |
| Anulación (`void_sale`) | `select ... where status = 'completed' for update`: la segunda llamada encuentra la venta `voided` y falla con `sale_not_found_or_not_voidable`. No revierte stock ni caja dos veces. | | Ninguno: es idempotente por estado. |
| Devolución (`return_sale_v2`) | Lock de cada línea vendida (`for update`) y tope por lo ya devuelto (`qty_exceeds`). | | Ninguno conocido. |
| Pagos externos (QR, Point, link) | Intent con estado y updates condicionales; webhooks idempotentes; reintegro MP con `X-Idempotency-Key` (ADR-067). | | Ninguno conocido. |
| API pública (`/api/v1`) | Escrituras en lote con `Idempotency-Key` (ADR-094). | | Ninguno conocido. |

## Venta online: detalle

1. El POS arma el payload y llama a `create_sale` (RPC, una transacción) con `p_client_request_id`.
2. Doble toque: el ref `inFlight` de `modules/pos/screen/usePosSale.ts` corta el segundo llamado antes de que React vuelva a renderizar; después el botón queda deshabilitado por `sale.isPending`.
3. Error de red: el POS **no reintenta solo**. Con la venta offline habilitada muestra "Se cortó la conexión con NinjaSoft. Revisá en Ventas si la venta entró" y pasa a guardar sin conexión sólo cuando el cajero confirma de nuevo (ADR-077); sin ella, muestra "No se pudo cobrar" con el detalle. Si el cajero vuelve a cobrar **online** el mismo carrito, va la misma clave: si la venta había entrado, el servidor la devuelve y el POS la muestra como registrada.
4. Error de negocio (precio cambiado, stock, plan, PIN): la transacción no grabó nada (tampoco la clave); se puede reintentar.

**Regla operativa para el piloto:** ante un corte en el medio de un cobro, mirar **Ventas** antes de cobrar de nuevo, sobre todo si se va a guardar sin conexión (la cola offline usa su propia clave). El mensaje de error del POS lo dice.

## Clave de idempotencia (SEC-43)

**Servidor** (`supabase/migrations/20270123100000_sec43_create_sale_idempotency.sql`):

- `sales.client_request_id uuid` con índice único parcial `sales_client_request_uniq (tenant_id, client_request_id) where client_request_id is not null`. La misma clave en otro negocio no choca.
- `create_sale(..., p_client_request_id uuid default null)`: parámetro opcional al final; los llamadores internos (`_offline_run_sale`, `_channel_bill`, `_pc_complete`, `_pc_dry_run`, `exchange_sale`) siguen con 14 argumentos.
- Con clave, apenas resuelve el negocio toma un advisory lock por (negocio, clave) y busca la venta. Si existe, devuelve el mismo jsonb que dio la primera vez, rearmado desde las filas por `_sale_replay_result` (helper interno, sin EXECUTE de clientes), sin tocar nada más. Dos envíos simultáneos se serializan en ese lock, antes de cualquier lock de fila o efecto: el segundo espera, ve la venta del primero (read committed) y la devuelve.
- La venta se graba con la clave y el insert usa el índice como árbitro (`on conflict ... do nothing`): si otro camino grabó la misma clave, devuelve esa venta. El insert de la venta es lo primero que escribe la función, así que no hay stock, caja ni cupón que deshacer. Se eligió esto en lugar de capturar `unique_violation` porque un bloque `exception` abre una subtransacción en cada venta; `on conflict` con el índice explícito es igual de estricto (otra violación de unicidad sigue siendo error).
- `pos_sale_create_fulfilled` lee la clave de `p_sale` (`p_client_request_id`, o `client_request_id`) y hace el mismo chequeo **antes** de mover stock entre sucursales; le pasa la clave a `create_sale`.
- El reintento no compara el payload: con la misma clave, devuelve la venta grabada aunque el carrito o los pagos hayan cambiado.

**POS** (`lib/pos/saleRequestKey.ts`, `modules/pos/screen/usePosSale.ts`): la clave nace en el primer "Cobrar" del carrito, se reusa mientras el carrito (renglones, cliente, mesa, delivery, turno de agenda, reserva) sea el mismo (reintento por corte, PIN de supervisor, otro medio de pago después de un error) y se descarta al confirmar la venta: la siguiente, aunque sea idéntica, lleva otra.

**Tests:** `tests/unit/saleIdempotency.test.ts` (reglas de la clave en el POS; la migración es copia de producción con bloques marcados) y `tests/integration/rls-sale-idempotency.test.ts` (misma clave dos veces y en paralelo → una venta, un movimiento de stock y uno de caja; sin clave → dos ventas; otro negocio no choca).

## Pendiente

- `pos_sale_create_delivery` (venta con envío) guarda la dirección nueva en el cliente antes de llamar a `pos_sale_create_fulfilled`: en un reintento con la misma clave la vuelve a guardar. La venta, el stock y las entregas no se duplican.
- La cola offline y la venta online usan claves distintas (`client_sale_id` / `client_request_id`): si la venta online entró y el cajero la guarda sin conexión después del corte, se duplica al sincronizar. Por eso la regla operativa de mirar Ventas sigue.
