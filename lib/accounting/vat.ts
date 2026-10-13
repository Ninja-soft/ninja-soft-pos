// lib/accounting/vat.ts
//
// IVA incluido por alícuota (ADR-066). Espejo exacto de acc_vat_split
// (migración 20261029100200): reparte el total del comprobante en proporción
// a los importes de cada alícuota (de mayor a menor; la última absorbe el
// redondeo) y separa el IVA de cada parte. En centavos.

export type VatMode = "included_rate" | "none";

export interface VatItem {
  amount: number;
  rate: number | null | undefined;
}

export interface VatPart {
  rate: number;
  gross: number;
  net: number;
  vat: number;
}

/** Redondeo a centavos, mitad hacia arriba (como round(x, 2) de Postgres). */
export function round2(n: number): number {
  const v = Math.round(Number((Math.abs(n) * 100).toPrecision(15))) / 100;
  return n < 0 ? -v : v;
}

export function splitVat(total: number, items: VatItem[], mode: VatMode, defaultRate = 21): VatPart[] {
  const t = round2(total || 0);
  if (mode === "none") return [{ rate: 0, gross: t, net: t, vat: 0 }];

  const groups = new Map<number, number>();
  for (const it of items) {
    const r = it.rate == null || Number.isNaN(Number(it.rate)) ? defaultRate : Number(it.rate);
    groups.set(r, (groups.get(r) ?? 0) + (Number(it.amount) || 0));
  }
  const base = [...groups.values()].reduce((a, b) => a + b, 0);
  if (base <= 0 || groups.size === 0) {
    const vat = round2((t * defaultRate) / (100 + defaultRate));
    return [{ rate: defaultRate, gross: t, net: round2(t - vat), vat }];
  }

  const ordered = [...groups.entries()].sort((a, b) => b[0] - a[0]);
  let left = t;
  return ordered.map(([rate, amt], i) => {
    const gross = i === ordered.length - 1 ? round2(left) : round2((t * amt) / base);
    left = round2(left - gross);
    const vat = round2((gross * rate) / (100 + rate));
    return { rate, gross, net: round2(gross - vat), vat };
  });
}
