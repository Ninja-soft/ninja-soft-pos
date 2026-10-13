// Motor de impuestos de la venta (F18 · H103-H105, ADR-068). PURO.
//
// Espejo EXACTO de `_tax_price_to_final` y `_sale_tax_compute` (SQL, migración
// 20261028100100_impuestos_base). Todo en centavos enteros con mitad hacia
// arriba, igual que `round(x, 2)` de Postgres sobre numeric.
//
// Modelo (precio final = lo que paga el cliente sin percepciones):
//
//   G = N + I + V      G: precio final de la línea, ya con su parte de los
//                         descuentos de la venta, del redondeo y del envío
//                      N: neto gravado (o exento, o no gravado)
//                      I: impuestos internos (se discriminan aparte y NO
//                         integran la base del IVA: art. 10 de la Ley de IVA)
//                      V: IVA
//
// 1. El total de la venta se reparte entre las líneas en proporción a su bruto
//    (resto mayor: los centavos que sobran van a las fracciones más grandes y,
//    a igualdad, a la primera línea). Así los descuentos generales, la promo,
//    el cupón y el redondeo de caja quedan dentro de cada ítem.
// 2. Internos por línea: monto fijo × cantidad, % sobre el costo × cantidad o
//    % sobre el precio. Sobre el precio la tasa es NOMINAL: el impuesto integra
//    su propia base, por eso la efectiva es t / (1 − t) (20 % nominal = 25 %
//    sobre el neto) y N = G / (1 + alícuota de IVA + efectiva).
// 3. IVA por alícuota sobre la BASE AGREGADA (lo que pide ARCA en AlicIva):
//    base = redondeo(Σ(G − I) / (1 + alícuota)), IVA = Σ(G − I) − base. La
//    base se reparte entre las líneas por resto mayor. El IVA de cada alícuota
//    difiere de base × alícuota en un centavo como mucho.
// 4. Emisor que no discrimina (monotributo, exento): N = G − I y V = 0.

import { IVA_RATES, type IvaCode } from "./catalog";

export type InternalMode = "none" | "pct" | "fixed";
export type InternalBase = "price" | "cost";

export interface InternalTax {
  mode: InternalMode;
  base: InternalBase;
  /** Tasa nominal en % (mode = pct). */
  rate: number | null;
  /** Monto fijo por unidad (mode = fixed). */
  amount: number | null;
  /** true: el precio cargado ya incluye los internos. */
  included: boolean;
}

export const NO_INTERNAL: InternalTax = { mode: "none", base: "price", rate: null, amount: null, included: true };

/** Redondeo a entero con mitad hacia arriba (lejos del cero), sin ruido binario. */
export function roundHalf(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const a = Number(Math.abs(x).toFixed(6));
  const r = Math.floor(a + 0.5);
  return x < 0 ? -r : r;
}

export const toCents = (pesos: number | string | null | undefined): number => roundHalf(Number(pesos ?? 0) * 100);
export const fromCents = (c: number): number => c / 100;

function ivaRateOf(code: IvaCode, discriminates: boolean, rates?: Partial<Record<string, number>> | null): number {
  const r = IVA_RATES[code] ?? IVA_RATES["21"];
  if (!discriminates || r.kind !== "gravado") return 0;
  // ADR-101: alícuota propia del negocio (price_context_snapshot.tax.rates).
  const own = rates?.[r.code];
  return own != null && Number.isFinite(Number(own)) ? Number(own) : r.rate;
}

/**
 * Reparte `total` (centavos) en proporción a `weights` (centavos, >= 0) por
 * resto mayor. La suma da exactamente `total`. Sin pesos, todo en cero.
 */
export function allocate(total: number, weights: number[]): number[] {
  const w = weights.map((x) => Math.max(0, Math.round(x)));
  const S = w.reduce((a, b) => a + b, 0);
  if (S <= 0 || total <= 0) return w.map(() => 0);
  const T = BigInt(Math.round(total));
  const Sb = BigInt(S);
  const floors: bigint[] = [];
  const rems: bigint[] = [];
  for (const x of w) {
    const p = T * BigInt(x);
    floors.push(p / Sb);
    rems.push(p % Sb);
  }
  let left = Number(T - floors.reduce((a, b) => a + b, 0n));
  const order = w
    .map((_, i) => i)
    .sort((a, b) => (rems[b]! > rems[a]! ? 1 : rems[b]! < rems[a]! ? -1 : a - b));
  const out = floors.map(Number);
  for (const i of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

// ── Precio cargado → precio final (resolver) ───────────────────────────────

export interface PriceTaxContext {
  rateCode: IvaCode;
  internal?: InternalTax | null;
  /** products.cost (base de internos sobre costo). */
  unitCost?: number | null;
  /** El emisor discrimina IVA (responsable inscripto o sin configurar). */
  discriminates: boolean;
  /** El negocio tiene `impuestos_internos`. */
  internalEnabled: boolean;
  /** La lista guarda precios con IVA (true) o netos (false). */
  listIncludesIva: boolean;
  /** Alícuotas de IVA propias del negocio que difieren de la plantilla (ADR-101). */
  rates?: Partial<Record<string, number>> | null;
}

/**
 * Lleva el precio de la lista al precio final que paga el cliente: suma el
 * IVA si la lista es neta y los internos si no están incluidos. En el caso
 * común (lista con IVA, sin internos adicionales) devuelve el mismo precio.
 */
export function priceToFinal(price: number, c: PriceTaxContext): number {
  const P = Number(price) || 0;
  const r = ivaRateOf(c.rateCode, c.discriminates, c.rates) / 100;
  const it = c.internalEnabled && c.internal && c.internal.mode !== "none" ? c.internal : null;
  let F: number;
  if (!it) {
    F = c.listIncludesIva ? P : P * (1 + r);
  } else if (it.mode === "pct" && it.base === "price") {
    const t = Math.min(Math.max(Number(it.rate) || 0, 0), 99) / 100;
    const e = t / (1 - t);
    if (it.included) F = c.listIncludesIva ? P : P + (r * P) / (1 + e);
    else F = c.listIncludesIva ? P + (e * P) / (1 + r) : P * (1 + r) + e * P;
  } else {
    const I =
      it.mode === "fixed"
        ? Number(it.amount) || 0
        : (Number(c.unitCost) || 0) * (Math.min(Math.max(Number(it.rate) || 0, 0), 99) / 100);
    if (it.included) F = c.listIncludesIva ? P : P + r * Math.max(P - I, 0);
    else F = c.listIncludesIva ? P + I : P * (1 + r) + I;
  }
  return fromCents(Math.max(0, roundHalf(F * 100)));
}

// ── Desglose de la venta ───────────────────────────────────────────────────

export interface TaxLineInput {
  /** unit_price × cantidad − descuento de la línea (antes del reparto). */
  gross: number;
  quantity: number;
  rateCode: IvaCode;
  internal?: InternalTax | null;
  unitCost?: number | null;
}

export interface SaleTaxInput {
  lines: TaxLineInput[];
  /** Total de la venta sin percepciones (con descuentos, redondeo y envío). */
  total: number;
  discriminates: boolean;
  internalEnabled: boolean;
}

export interface TaxLineResult {
  rateCode: IvaCode;
  ivaRate: number;
  /** Precio final de la línea después del reparto (G). */
  taxedTotal: number;
  net: number;
  iva: number;
  internal: number;
}

export interface IvaGroup {
  code: IvaCode;
  arcaId: number;
  rate: number;
  base: number;
  amount: number;
}

export interface SaleTaxResult {
  lines: TaxLineResult[];
  /** AlicIva: una fila por alícuota gravada con base e importe. */
  iva: IvaGroup[];
  netTaxed: number;
  netExempt: number;
  netUntaxed: number;
  ivaTotal: number;
  internalTotal: number;
}

function internalCents(
  G: number,
  l: TaxLineInput,
  rRate: number,
  enabled: boolean,
): number {
  const it = l.internal;
  if (!enabled || !it || it.mode === "none" || G <= 0) return 0;
  const qty = Number(l.quantity) || 0;
  let I = 0;
  if (it.mode === "fixed") {
    I = roundHalf(qty * (Number(it.amount) || 0) * 100);
  } else {
    const t = Math.min(Math.max(Number(it.rate) || 0, 0), 99) / 100;
    if (it.base === "cost") {
      I = roundHalf(qty * (Number(l.unitCost) || 0) * t * 100);
    } else {
      const e = t / (1 - t);
      const Nn = roundHalf(G / (1 + rRate / 100 + e));
      I = roundHalf(Nn * e);
    }
  }
  return Math.min(Math.max(I, 0), G);
}

export function computeSaleTaxes(input: SaleTaxInput): SaleTaxResult {
  const lines = input.lines;
  const G = allocate(
    Math.max(0, toCents(input.total)),
    lines.map((l) => Math.max(0, toCents(l.gross))),
  );
  const rates = lines.map((l) => ivaRateOf(l.rateCode, input.discriminates));
  const I = lines.map((l, i) => internalCents(G[i]!, l, rates[i]!, input.internalEnabled));
  const A = G.map((g, i) => g - I[i]!);
  const N = A.slice();
  const groups: IvaGroup[] = [];

  // Agrupar por alícuota (orden de primera aparición).
  const byCode = new Map<IvaCode, number[]>();
  lines.forEach((l, i) => {
    const arr = byCode.get(l.rateCode) ?? [];
    arr.push(i);
    byCode.set(l.rateCode, arr);
  });
  for (const [code, idx] of byCode) {
    const def = IVA_RATES[code];
    if (!input.discriminates || def.kind !== "gravado") continue;
    const sumA = idx.reduce((s, i) => s + A[i]!, 0);
    let base = sumA;
    if (def.rate > 0) {
      base = roundHalf((sumA * 100) / (100 + def.rate));
      const alloc = allocate(base, idx.map((i) => A[i]!));
      idx.forEach((i, k) => (N[i] = alloc[k]!));
    }
    groups.push({ code, arcaId: def.arcaId, rate: def.rate, base: fromCents(base), amount: fromCents(sumA - base) });
  }

  let netTaxed = 0;
  let netExempt = 0;
  let netUntaxed = 0;
  const out: TaxLineResult[] = lines.map((l, i) => {
    const kind = IVA_RATES[l.rateCode].kind;
    if (!input.discriminates || kind === "gravado") netTaxed += N[i]!;
    else if (kind === "exento") netExempt += N[i]!;
    else netUntaxed += N[i]!;
    return {
      rateCode: l.rateCode,
      ivaRate: rates[i]!,
      taxedTotal: fromCents(G[i]!),
      net: fromCents(N[i]!),
      iva: fromCents(A[i]! - N[i]!),
      internal: fromCents(I[i]!),
    };
  });

  return {
    lines: out,
    iva: groups,
    netTaxed: fromCents(netTaxed),
    netExempt: fromCents(netExempt),
    netUntaxed: fromCents(netUntaxed),
    ivaTotal: fromCents(A.reduce((s, a, i) => s + a - N[i]!, 0)),
    internalTotal: fromCents(I.reduce((s, x) => s + x, 0)),
  };
}

// ── Percepciones ───────────────────────────────────────────────────────────

export type PerceptionBase = "net" | "net_taxed" | "total";

export interface PerceptionRateInput {
  /** El régimen usa padrón. */
  usesPadron: boolean;
  /** Alícuota del padrón para el CUIT y la fecha (null = no figura). */
  padronRate: number | null;
  /** Alícuota por condición del cliente (pisa la general). */
  ratesByCondition?: Record<string, number> | null;
  condition: string | null;
  /** Alícuota general (sin padrón o no figura). null = no se percibe. */
  defaultRate: number | null;
  /** % de exclusión vigente (certificado), 0 a 100. */
  exemptionPct?: number | null;
}

/** Alícuota a aplicar (en %, 4 decimales) o null si no corresponde percibir. */
export function resolvePerceptionRate(i: PerceptionRateInput): number | null {
  let rate: number | null = null;
  if (i.usesPadron && i.padronRate != null) rate = Number(i.padronRate);
  else {
    const byCond = i.condition && i.ratesByCondition ? i.ratesByCondition[i.condition] : undefined;
    rate = byCond != null ? Number(byCond) : i.defaultRate != null ? Number(i.defaultRate) : null;
  }
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return rate === 0 ? 0 : null;
  const ex = Math.min(Math.max(Number(i.exemptionPct) || 0, 0), 100);
  return Math.round(rate * (1 - ex / 100) * 10000) / 10000;
}

export interface PerceptionBases {
  netTaxed: number;
  /** Neto gravado + exento + no gravado (sin IVA ni internos). */
  net: number;
  total: number;
}

export function perceptionBase(kind: PerceptionBase, b: PerceptionBases): number {
  return kind === "net_taxed" ? b.netTaxed : kind === "total" ? b.total : b.net;
}

/** Monto de la percepción o null si no supera los mínimos. */
export function perceptionAmount(
  rule: { baseKind: PerceptionBase; rate: number; minBase: number; minAmount: number },
  b: PerceptionBases,
): { base: number; amount: number } | null {
  const base = perceptionBase(rule.baseKind, b);
  if (!(rule.rate > 0) || base <= 0) return null;
  if (base < (Number(rule.minBase) || 0)) return null;
  const amount = fromCents(roundHalf((toCents(base) * rule.rate) / 100));
  if (amount <= 0 || amount < (Number(rule.minAmount) || 0)) return null;
  return { base, amount };
}
