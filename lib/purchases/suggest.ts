// lib/purchases/suggest.ts
//
// Cantidad sugerida para una orden de compra por sucursal (F18 · H101,
// ADR-050). Lógica PURA sobre las filas de la RPC purchase_suggestions.
//
// Cuando lo disponible queda debajo del mínimo (punto de pedido), el objetivo
// es llevar la sucursal a su máximo (o, si no tiene máximo, a su mínimo) contando el stock, lo que viene en camino por traslados y lo ya
// pedido en otras OC abiertas. Se redondea hacia arriba a la unidad de compra
// (caja, bulto) y se respeta el mínimo de compra del proveedor.

export interface SuggestInput {
  qty: number;
  min_qty: number;
  max_qty: number | null;
  in_transit_in?: number;
  on_order?: number;
  min_order_qty?: number | null;
  units_per_purchase?: number | null;
}

export function suggestPurchaseQty(r: SuggestInput): number {
  const available = Number(r.qty) + Number(r.in_transit_in ?? 0) + Number(r.on_order ?? 0);
  const min = Number(r.min_qty) || 0;
  // El mínimo es el punto de pedido: arriba de él no se sugiere comprar.
  if (!(min > 0) || available >= min) return 0;
  const target = r.max_qty != null && Number(r.max_qty) > min ? Number(r.max_qty) : min;
  let need = target - available;
  if (need <= 0) return 0;
  const pack = Number(r.units_per_purchase) > 0 ? Number(r.units_per_purchase) : 1;
  need = Math.ceil(Math.round((need / pack) * 1000) / 1000) * pack;
  const minOrder = Number(r.min_order_qty) > 0 ? Number(r.min_order_qty) : 0;
  if (need < minOrder) need = Math.ceil(minOrder / pack) * pack;
  return Math.round(need * 1000) / 1000;
}
