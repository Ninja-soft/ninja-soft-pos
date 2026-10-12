// lib/purchases/lots.ts
//
// Consumo por lote (F18 · H101 + H102, ADR-059). Lógica PURA, espejo de
// _lot_consume y _lot_release_sale (migración 20261022100100):
//   • Una venta consume los lotes con saldo de su sucursal por vencimiento
//     (los que vencen antes primero, FEFO) y, sin vencimiento o empatados, por
//     antigüedad de ingreso (FIFO). Lo que no alcanza queda "sin lote".
//   • Una anulación o devolución del cliente devuelve primero lo "sin lote" y
//     después los lotes, del último consumo al primero.

import { round } from "./costs";

export interface LotBalance {
  id: string;
  expires_on: string | null;
  created_at: string;
  qty_available: number;
}

export interface LotTake {
  lot_id: string | null;
  qty: number;
}

/** Orden de consumo: vencimiento (sin vencimiento al final), ingreso, id. */
export function lotConsumptionOrder(lots: LotBalance[]): LotBalance[] {
  return [...lots].sort((a, b) => {
    if (a.expires_on !== b.expires_on) {
      if (a.expires_on == null) return 1;
      if (b.expires_on == null) return -1;
      return a.expires_on.localeCompare(b.expires_on);
    }
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

/** Reparte `qty` entre los lotes; el resto va "sin lote" (lot_id null). */
export function assignLots(lots: LotBalance[], qty: number): LotTake[] {
  let left = round(Math.max(Number(qty) || 0, 0), 3);
  const out: LotTake[] = [];
  for (const l of lotConsumptionOrder(lots)) {
    if (left <= 0) break;
    if (!(l.qty_available > 0)) continue;
    const take = round(Math.min(left, l.qty_available), 3);
    out.push({ lot_id: l.id, qty: take });
    left = round(left - take, 3);
  }
  if (left > 0) out.push({ lot_id: null, qty: left });
  return out;
}

export interface SaleAllocation {
  lot_id: string | null;
  qty: number;
  created_at: string;
}

/**
 * Devuelve hasta `qty` de lo consumido por una venta. Entra el libro de esa
 * venta y producto (consumos > 0 y devoluciones < 0); sale lo que vuelve a
 * cada lote.
 */
export function releaseSaleLots(allocations: SaleAllocation[], qty: number): LotTake[] {
  const net = new Map<string, { lot_id: string | null; net: number; last: string }>();
  for (const a of allocations) {
    const k = a.lot_id ?? "";
    const cur = net.get(k) ?? { lot_id: a.lot_id, net: 0, last: "" };
    cur.net = round(cur.net + a.qty, 3);
    if (a.created_at > cur.last) cur.last = a.created_at;
    net.set(k, cur);
  }
  const rows = [...net.values()]
    .filter((r) => r.net > 0)
    .sort((a, b) => {
      if ((a.lot_id == null) !== (b.lot_id == null)) return a.lot_id == null ? -1 : 1;
      return b.last.localeCompare(a.last);
    });
  let left = round(Math.max(Number(qty) || 0, 0), 3);
  const out: LotTake[] = [];
  for (const r of rows) {
    if (left <= 0) break;
    const take = round(Math.min(left, r.net), 3);
    out.push({ lot_id: r.lot_id, qty: take });
    left = round(left - take, 3);
  }
  return out;
}

export type LotHealth = "expired" | "expiring" | "ok" | "empty";

/** Estado del lote para la lista (vencido, por vencer en `days`, ok, agotado). */
export function lotHealth(
  lot: { expires_on: string | null; qty_available: number },
  today: string,
  days = 30,
): LotHealth {
  if (!(lot.qty_available > 0)) return "empty";
  if (!lot.expires_on) return "ok";
  if (lot.expires_on < today) return "expired";
  const t = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const e = Date.UTC(+lot.expires_on.slice(0, 4), +lot.expires_on.slice(5, 7) - 1, +lot.expires_on.slice(8, 10));
  return (e - t) / 86_400_000 <= days ? "expiring" : "ok";
}
