# Idempotencia de venta y anulación

Qué pasa si una venta o una anulación se manda dos veces (doble toque, reintento después de un corte, dos cajeros a la vez), qué la protege hoy y qué falta. F1.5, ADR-098.

## Resumen

| Operación | Protección en el servidor | Protección en el POS | Riesgo que queda |
|---|---|---|---|
| Venta online (`create_sale`) | Una transacción: entra todo o nada (venta, ítems, pagos, stock, caja, cupón, mesa, delivery, reserva). Sin clave de idempotencia. | `handleSale` descarta un segundo "Cobrar" mientras el primero está en vuelo (ref síncrono + botón en carga). | Si se corta la red **después** de que el servidor grabó y **antes** de la respuesta, reintentar duplica la venta. |
| Venta offline (`sync_offline_sale`) | `client_sale_id` único por negocio: el reenvío devuelve la venta ya creada. | La cola local sólo saca una venta cuando el servidor confirmó. | Ninguno conocido. Ver [`34-venta-offline.md`](./34-venta-offline.md), ADR-077. |
| Cobro en espera (`_pc_complete`) | La venta se emite una sola vez por cobro (estado + lock). | | Ninguno conocido. ADR-048. |
| Anulación (`void_sale`) | `select ... where status = 'completed' for update`: la segunda llamada encuentra la venta `voided` y falla con `sale_not_found_or_not_voidable`. No revierte stock ni caja dos veces. | | Ninguno: es idempotente por estado. |
| Devolución (`return_sale_v2`) | Lock de cada línea vendida (`for update`) y tope por lo ya devuelto (`qty_exceeds`). | | Ninguno conocido. |
| Pagos externos (QR, Point, link) | Intent con estado y updates condicionales; webhooks idempotentes; reintegro MP con `X-Idempotency-Key` (ADR-067). | | Ninguno conocido. |
| API pública (`/api/v1`) | Escrituras en lote con `Idempotency-Key` (ADR-094). | | Ninguno conocido. |

## Venta online: detalle

1. El POS arma el payload y llama a `create_sale` (RPC, una transacción).
2. Doble toque: el ref `inFlight` de `modules/pos/screen/usePosSale.ts` corta el segundo llamado antes de que React vuelva a renderizar; después el botón queda deshabilitado por `sale.isPending`.
3. Error de red: el POS **no reintenta solo**. Con la venta offline habilitada muestra "Se cortó la conexión con NinjaSoft. Revisá en Ventas si la venta entró" y pasa a guardar sin conexión sólo cuando el cajero confirma de nuevo (ADR-077); sin ella, muestra "No se pudo cobrar" con el detalle.
4. Error de negocio (precio cambiado, stock, plan, PIN): la transacción no grabó nada; se puede reintentar.

**Regla operativa para el piloto:** ante un corte en el medio de un cobro, mirar **Ventas** antes de cobrar de nuevo. El mensaje de error del POS lo dice.

## Deuda

- **Clave de idempotencia en `create_sale`** (`p_client_sale_id` opcional, único por negocio, como la venta offline): el reintento devolvería la venta existente. No se hace en esta rama porque `create_sale` lo recrean otras ramas (ADR-093, ADR-096); va en la próxima recreación de la función, con su test de doble envío.
- Hasta entonces el riesgo es acotado: requiere un corte exacto entre el commit y la respuesta, y el mensaje del POS lleva a revisar Ventas. Una venta duplicada se anula con motivo y queda auditada.
