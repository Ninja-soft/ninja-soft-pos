// Reparto de propinas entre mozos (F13 · H52). Puro: trabaja sobre los totales
// por mozo de gastro_turnover_report. Dos criterios:
//   * "por_mozo": cada mozo se lleva lo que generaron sus mesas.
//   * "pozo":     se junta todo y se reparte en partes iguales entre los mozos
//                 que atendieron mesas en el período.
// Reconciliación en centavos: el remanente del redondeo va al primero, así la
// suma del reparto es exactamente el total de propinas.

export type TipSplitMode = "por_mozo" | "pozo";

export interface WaiterTipRow {
  waiter: string;
  tips: number;
  orders: number;
}

export interface TipShare {
  waiter: string;
  generated: number;
  share: number;
}

const toCents = (n: number) => Math.round((Number(n) || 0) * 100);

export function splitTips(rows: WaiterTipRow[], mode: TipSplitMode): TipShare[] {
  const active = rows.filter((r) => r.orders > 0);
  if (mode === "por_mozo") {
    return active.map((r) => ({ waiter: r.waiter, generated: r.tips, share: toCents(r.tips) / 100 }));
  }
  const totalCents = active.reduce((acc, r) => acc + toCents(r.tips), 0);
  const n = active.length;
  if (n === 0) return [];
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return active.map((r, i) => ({
    waiter: r.waiter,
    generated: r.tips,
    share: (base + (i < rest ? 1 : 0)) / 100,
  }));
}

export function tipsTotal(rows: WaiterTipRow[]): number {
  return rows.reduce((acc, r) => acc + toCents(r.tips), 0) / 100;
}
