// Simulador de medios de pago de la ficha pública (ADR-148). Puro.
//
// Con el precio del producto y la configuración del negocio (medios de pago
// habilitados con su recargo o descuento, y planes de tarjeta con cuotas y
// recargo) arma la tabla que ve el cliente: total y valor de cada cuota.
// Mismo criterio que la caja: el recargo del plan se aplica sobre el precio
// (lineSurcharge en lib/pos/checkoutMath.ts) y la cuota es total ÷ cuotas.

export interface PublicPaymentMethod {
  key: string;
  name: string;
  kind: string;
  surcharge_pct: number;
}

export interface PublicPaymentPlan {
  label: string;
  base: string; // efectivo | transferencia | debito | credito | qr | otro
  brand: string | null;
  installments: number;
  surcharge_pct: number;
  provider_key: string | null;
}

export interface SimRow {
  id: string;
  label: string;
  detail: string | null;
  installments: number;
  pct: number;
  total: number;
  perInstallment: number;
}

export interface SimGroup {
  key: string;
  title: string;
  rows: SimRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Total con recargo (pct > 0) o descuento (pct < 0), como en la caja. */
export function applyPct(price: number, pct: number): number {
  const p = Number.isFinite(pct) ? pct : 0;
  return round2(price + round2((price * p) / 100));
}

export function installmentAmount(total: number, n: number): number {
  const k = Math.max(1, Math.floor(n || 1));
  return round2(total / k);
}

const BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  master: "Mastercard",
  maestro: "Maestro",
  cabal: "Cabal",
  amex: "American Express",
  naranja: "Naranja",
  diners: "Diners",
};

const BASE_TITLES: Record<string, string> = {
  credito: "Tarjeta de crédito",
  debito: "Tarjeta de débito",
  qr: "QR y billeteras",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  otro: "Otros planes",
};

export function brandLabel(b: string | null | undefined): string | null {
  if (!b) return null;
  return BRAND_LABELS[b] ?? b.charAt(0).toUpperCase() + b.slice(1);
}

/**
 * Agrupa medios y planes. Los medios sin plan (efectivo, transferencia,
 * billeteras) van primero; después los planes de tarjeta por tipo, ordenados
 * por cuotas. Las cuotas repetidas (mismo tipo, marca y cuotas) quedan una.
 */
export function simulatePayments(price: number, methods: PublicPaymentMethod[], plans: PublicPaymentPlan[]): SimGroup[] {
  const groups: SimGroup[] = [];
  if (!(price > 0)) return groups;

  const simple = methods
    .filter((m) => m.kind === "manual" || m.kind === "qr" || m.key === "cash" || m.key === "transfer")
    .map<SimRow>((m) => {
      const pct = Number(m.surcharge_pct) || 0;
      const total = applyPct(price, pct);
      return { id: `m:${m.key}`, label: m.name, detail: null, installments: 1, pct, total, perInstallment: total };
    });
  if (simple.length) groups.push({ key: "methods", title: "Medios de pago", rows: simple });

  const byBase = new Map<string, SimRow[]>();
  const seen = new Set<string>();
  for (const p of plans) {
    const n = Math.max(1, Math.floor(Number(p.installments) || 1));
    const base = BASE_TITLES[p.base] ? p.base : "otro";
    const dedupe = `${base}|${p.brand ?? ""}|${n}|${Number(p.surcharge_pct) || 0}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const pct = Number(p.surcharge_pct) || 0;
    const total = applyPct(price, pct);
    const rows = byBase.get(base) ?? [];
    rows.push({
      id: `p:${dedupe}`,
      label: p.label || (n > 1 ? `${n} cuotas` : "1 pago"),
      detail: brandLabel(p.brand),
      installments: n,
      pct,
      total,
      perInstallment: installmentAmount(total, n),
    });
    byBase.set(base, rows);
  }
  const order = ["credito", "debito", "qr", "transferencia", "efectivo", "otro"];
  for (const base of order) {
    const rows = byBase.get(base);
    if (!rows?.length) continue;
    rows.sort((a, b) => a.installments - b.installments || a.pct - b.pct || a.label.localeCompare(b.label, "es"));
    groups.push({ key: base, title: BASE_TITLES[base]!, rows });
  }
  return groups;
}

/** Texto corto de la mejor opción en cuotas ("Hasta 12 cuotas de $ 1.000"). */
export function bestInstallmentText(groups: SimGroup[], fmt: (n: number) => string): string | null {
  let best: SimRow | null = null;
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.installments <= 1) continue;
      if (!best || r.installments > best.installments || (r.installments === best.installments && r.pct < best.pct)) best = r;
    }
  }
  if (!best) return null;
  return `Hasta ${best.installments} cuotas de ${fmt(best.perInstallment)}${best.pct === 0 ? " sin interés" : ""}`;
}
