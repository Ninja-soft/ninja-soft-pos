// lib/purchases/landed.ts
//
// Hoja de costeo de importación (F18 · H102, ADR-050). Lógica PURA: del FOB de
// cada línea al costo unitario puesto en depósito, en pesos.
//
//   FOB (moneda de origen) + flete internacional + seguro  = CIF
//   CIF × tipo de cambio del despacho                       = CIF en pesos
//   + derechos de importación (% sobre CIF, por línea si la posición NCM difiere)
//   + tasa de estadística (% sobre CIF, con tope total opcional)
//   + otros tributos que son costo (% sobre CIF)
//   + gastos de nacionalización en pesos (despachante, terminal, depósito
//     fiscal, flete interno, gastos bancarios...)
//   = costo puesto en depósito
//
// Cada concepto se prorratea con su propia base: valor (FOB), peso, volumen o
// cantidad. El IVA de importación y las percepciones (IVA adicional,
// Ganancias, IIBB) son crédito fiscal o pago a cuenta: se calculan aparte, a
// título informativo, y NUNCA se suman al costo.
//
// Las alícuotas y topes son parámetros de la hoja (con vigencia en la norma),
// nunca constantes del código.

import { round } from "./costs";

export type ProrateBy = "value" | "weight" | "volume" | "qty";

export const PRORATE_LABEL: Record<ProrateBy, string> = {
  value: "Por valor",
  weight: "Por peso",
  volume: "Por volumen",
  qty: "Por cantidad",
};

export interface LandedLineInput {
  id: string;
  qty: number;
  /** FOB unitario en la moneda de origen. */
  fob_unit: number;
  /** Peso total de la línea (kg). */
  weight_kg?: number | null;
  /** Volumen total de la línea (m³). */
  volume_m3?: number | null;
  /** Derechos de importación de esta línea (% sobre CIF). Si falta, el de la hoja. */
  duty_pct?: number | null;
}

export interface LandedConcept {
  amount: number;
  prorate: ProrateBy;
}

export interface LandedExpense {
  description: string;
  /** Importe en pesos, neto de IVA. */
  amount_ars: number;
  prorate: ProrateBy;
}

export interface LandedTaxPct {
  description: string;
  pct: number;
}

export interface LandedSheet {
  currency: string;
  /** Pesos por unidad de moneda de origen (tipo de cambio del despacho). */
  fx_rate: number;
  /** Flete internacional en moneda de origen. */
  freight: LandedConcept;
  /** Seguro en moneda de origen. */
  insurance: LandedConcept;
  /** Derechos de importación por defecto (% sobre CIF). */
  duty_pct: number;
  /** Tasa de estadística (% sobre CIF). */
  statistics_pct: number;
  /** Tope total de la tasa de estadística en pesos (opcional). */
  statistics_cap_ars?: number | null;
  /** Otros tributos que son costo (% sobre CIF). */
  other_cost_taxes: LandedTaxPct[];
  /** Gastos de nacionalización en pesos. */
  expenses: LandedExpense[];
  /** Crédito fiscal y pagos a cuenta (informativo, % sobre CIF + derechos + tasa). */
  credit_taxes: LandedTaxPct[];
  dispatch_number?: string | null;
}

export interface LandedLineResult {
  id: string;
  qty: number;
  fob: number;
  freight: number;
  insurance: number;
  cif: number;
  cif_ars: number;
  duty: number;
  statistics: number;
  other_taxes: number;
  expenses: number;
  landed_total: number;
  landed_unit: number;
  /** Base imponible del IVA de importación (CIF + derechos + tasa) en pesos. */
  vat_base: number;
}

export interface LandedResult {
  lines: LandedLineResult[];
  totals: {
    fob: number;
    freight: number;
    insurance: number;
    cif: number;
    cif_ars: number;
    duty: number;
    statistics: number;
    other_taxes: number;
    expenses: number;
    landed: number;
    vat_base: number;
    credit_taxes: Array<{ description: string; pct: number; amount: number }>;
    credit_total: number;
  };
  warnings: string[];
}

export function emptyLandedSheet(currency = "USD", fxRate = 1): LandedSheet {
  return {
    currency,
    fx_rate: fxRate,
    freight: { amount: 0, prorate: "weight" },
    insurance: { amount: 0, prorate: "value" },
    duty_pct: 0,
    statistics_pct: 3,
    statistics_cap_ars: null,
    other_cost_taxes: [],
    expenses: [],
    credit_taxes: [
      { description: "IVA importación", pct: 21 },
      { description: "Percepción IVA adicional", pct: 20 },
      { description: "Percepción Ganancias", pct: 6 },
    ],
    dispatch_number: null,
  };
}

/**
 * Reparte `total` según `weights` en centavos exactos (resto mayor): la suma de
 * las partes es exactamente el total. Si todos los pesos son cero, reparte en
 * partes iguales.
 */
export function allocate(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const cents = Math.round(total * 100);
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? w : w.map(() => 1);
  const bsum = sum > 0 ? sum : n;
  const raw = base.map((x) => (cents * x) / bsum);
  const floors = raw.map((x) => Math.floor(x));
  let rest = cents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (rest <= 0) break;
    floors[o.i]! += 1;
    rest -= 1;
  }
  return floors.map((c) => c / 100);
}

function weightsFor(lines: LandedLineInput[], by: ProrateBy): number[] {
  switch (by) {
    case "value":
      return lines.map((l) => l.qty * l.fob_unit);
    case "weight":
      return lines.map((l) => Number(l.weight_kg ?? 0));
    case "volume":
      return lines.map((l) => Number(l.volume_m3 ?? 0));
    case "qty":
      return lines.map((l) => l.qty);
  }
}

function missingBasis(lines: LandedLineInput[], by: ProrateBy): boolean {
  if (by === "weight") return lines.every((l) => !(Number(l.weight_kg) > 0));
  if (by === "volume") return lines.every((l) => !(Number(l.volume_m3) > 0));
  return false;
}

export function computeLandedCost(
  sheet: LandedSheet,
  input: LandedLineInput[],
): LandedResult {
  const warnings: string[] = [];
  const lines = input.filter((l) => l.qty > 0);
  const fx = sheet.fx_rate > 0 ? sheet.fx_rate : 0;
  if (!(sheet.fx_rate > 0)) warnings.push("Falta el tipo de cambio del despacho.");
  if (lines.length === 0) warnings.push("No hay líneas con cantidad.");

  const fob = lines.map((l) => round(l.qty * l.fob_unit, 2));

  const conceptWeights = (by: ProrateBy, label: string) => {
    if (missingBasis(lines, by)) {
      warnings.push(`${label}: no hay ${by === "weight" ? "pesos" : "volúmenes"} cargados, se reparte en partes iguales.`);
    }
    return weightsFor(lines, by);
  };

  const freight = allocate(sheet.freight.amount || 0, conceptWeights(sheet.freight.prorate, "Flete"));
  const insurance = allocate(
    sheet.insurance.amount || 0,
    conceptWeights(sheet.insurance.prorate, "Seguro"),
  );
  const cif = lines.map((_, i) => round(fob[i]! + freight[i]! + insurance[i]!, 2));
  const cifArs = cif.map((c) => round(c * fx, 2));
  const cifArsTotal = round(cifArs.reduce((a, b) => a + b, 0), 2);

  const duty = lines.map((l, i) => round((cifArs[i]! * (l.duty_pct ?? sheet.duty_pct ?? 0)) / 100, 2));

  let statTotal = round((cifArsTotal * (sheet.statistics_pct || 0)) / 100, 2);
  if (sheet.statistics_cap_ars != null && sheet.statistics_cap_ars >= 0 && statTotal > sheet.statistics_cap_ars) {
    statTotal = round(sheet.statistics_cap_ars, 2);
  }
  const statistics = allocate(statTotal, cifArs);

  const otherPct = (sheet.other_cost_taxes ?? []).reduce((t, x) => t + (x.pct || 0), 0);
  const otherTotal = round((cifArsTotal * otherPct) / 100, 2);
  const otherTaxes = allocate(otherTotal, cifArs);

  const expenses = lines.map(() => 0);
  for (const e of sheet.expenses ?? []) {
    const parts = allocate(e.amount_ars || 0, conceptWeights(e.prorate, e.description || "Gasto"));
    parts.forEach((p, i) => (expenses[i] = round(expenses[i]! + p, 2)));
  }

  const result: LandedLineResult[] = lines.map((l, i) => {
    const landed = round(cifArs[i]! + duty[i]! + statistics[i]! + otherTaxes[i]! + expenses[i]!, 2);
    return {
      id: l.id,
      qty: l.qty,
      fob: fob[i]!,
      freight: freight[i]!,
      insurance: insurance[i]!,
      cif: cif[i]!,
      cif_ars: cifArs[i]!,
      duty: duty[i]!,
      statistics: statistics[i]!,
      other_taxes: otherTaxes[i]!,
      expenses: expenses[i]!,
      landed_total: landed,
      landed_unit: round(landed / l.qty, 4),
      vat_base: round(cifArs[i]! + duty[i]! + statistics[i]!, 2),
    };
  });

  const sum = (k: keyof LandedLineResult) =>
    round(result.reduce((t, r) => t + Number(r[k]), 0), 2);
  const vatBase = sum("vat_base");
  const credit = (sheet.credit_taxes ?? []).map((t) => ({
    description: t.description,
    pct: t.pct,
    amount: round((vatBase * (t.pct || 0)) / 100, 2),
  }));

  return {
    lines: result,
    totals: {
      fob: sum("fob"),
      freight: sum("freight"),
      insurance: sum("insurance"),
      cif: sum("cif"),
      cif_ars: sum("cif_ars"),
      duty: sum("duty"),
      statistics: sum("statistics"),
      other_taxes: sum("other_taxes"),
      expenses: sum("expenses"),
      landed: sum("landed_total"),
      vat_base: vatBase,
      credit_taxes: credit,
      credit_total: round(credit.reduce((t, c) => t + c.amount, 0), 2),
    },
    warnings,
  };
}

/**
 * N° de despacho de importación: 16 caracteres AAaaaTTTTnnnnnnX (año, aduana,
 * tipo de destinación, número y verificador). Validación de forma, no del
 * dígito verificador.
 */
export function normalizeDispatchNumber(v: string | null | undefined): string {
  return String(v ?? "").replace(/[\s-]/g, "").toUpperCase();
}

export function isValidDispatchNumber(v: string | null | undefined): boolean {
  return /^\d{2}\d{3}[A-Z0-9]{4}\d{6}[A-Z]$/.test(normalizeDispatchNumber(v));
}
