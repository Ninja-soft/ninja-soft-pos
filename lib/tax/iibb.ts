// Liquidación mensual de Ingresos Brutos por jurisdicción · F18 · H106/H108,
// ADR-095. PURO.
//
// computeIibb es el ESPEJO EXACTO de _iibb_math (migración 20261109300100):
//   1. Base de cada actividad: la de la jurisdicción (régimen local) o, en
//      Convenio Multilateral, la base de todo el país × coeficiente unificado
//      de la jurisdicción, redondeada a centavos.
//   2. Impuesto de la actividad = base × alícuota % (centavos, mitad hacia
//      arriba). Base cero o negativa: impuesto cero (con aviso). Si la
//      actividad tiene impuesto mínimo y el cálculo da menos, va el mínimo.
//   3. Impuesto determinado = suma de las actividades.
//   4. Deducciones del mes: retenciones, percepciones (incluidas las de
//      facturas de proveedor), SIRCREB y SIRTAC; más el saldo a favor que
//      dejó la liquidación anterior (o el saldo inicial cargado).
//   5. Se usa lo disponible hasta cubrir el impuesto: lo que falta es el
//      saldo a pagar; lo que sobra queda como saldo a favor para el mes
//      siguiente.
// Paridad con tests/fixtures/iibbMatrix.ts en unit (TS) y en PGlite (SQL).
//
// Valores orientativos: alícuotas, mínimos y coeficientes los carga el
// negocio con su contador (ver docs/32-impuestos.md § 9).

import { pct, round2 } from "./retentions";

export interface IibbActivityInput {
  key: string;
  /** Base del mes sin coeficiente (ventas − anulaciones − devoluciones, neto de IVA). */
  base_raw: number;
  rate: number;
  min_tax: number;
}

export interface IibbDeductions {
  retencion: number;
  percepcion: number;
  sircreb: number;
  sirtac: number;
}

export interface IibbInput {
  activities: IibbActivityInput[];
  /** Coeficiente unificado (Convenio Multilateral); null = régimen local. */
  coefficient: number | null;
  deductions: IibbDeductions;
  previous_credit: number;
}

export interface IibbActivityResult {
  key: string;
  base: number;
  tax: number;
  minimum_applied: boolean;
}

export interface IibbResult {
  activities: IibbActivityResult[];
  base_total: number;
  determined: number;
  deductions_total: number;
  previous_credit: number;
  available: number;
  used: number;
  to_pay: number;
  credit_next: number;
}

const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

/** round(x, 2) mitad hacia arriba (también para negativos, como Postgres). */
function r2(x: number): number {
  return x < 0 ? -round2(-x) : round2(x);
}

/** base × coeficiente redondeado a centavos (coeficiente con hasta 6 decimales). */
export function applyCoefficient(base: number, coefficient: number): number {
  const b = BigInt(cents(base));
  const k = BigInt(Math.round(coefficient * 1_000_000));
  const num = b * k;
  const den = 1_000_000n;
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (den * 2n);
  return fromCents(Number(neg ? -q : q));
}

export function computeIibb(input: IibbInput): IibbResult {
  const activities: IibbActivityResult[] = input.activities.map((a) => {
    const base = input.coefficient === null ? r2(a.base_raw) : applyCoefficient(a.base_raw, input.coefficient);
    let tax = base > 0 ? pct(base, a.rate) : 0;
    let minimum = false;
    if (a.min_tax > 0 && tax < a.min_tax) {
      tax = round2(a.min_tax);
      minimum = true;
    }
    return { key: a.key, base, tax, minimum_applied: minimum };
  });
  const sum = (xs: number[]) => fromCents(xs.reduce((s, x) => s + cents(x), 0));
  const base_total = sum(activities.map((a) => a.base));
  const determined = sum(activities.map((a) => a.tax));
  const d = input.deductions;
  const deductions_total = sum([d.retencion, d.percepcion, d.sircreb, d.sirtac].map((x) => round2(Math.max(0, x))));
  const previous_credit = round2(Math.max(0, input.previous_credit));
  const available = sum([deductions_total, previous_credit]);
  const used = Math.min(available, determined);
  const to_pay = fromCents(cents(determined) - cents(used));
  const credit_next = fromCents(cents(available) - cents(used));
  return { activities, base_total, determined, deductions_total, previous_credit, available, used, to_pay, credit_next };
}

// ---------------------------------------------------------------------------
// Datos que devuelve iibb_liquidation_preview (y guarda la confirmación).
// ---------------------------------------------------------------------------
export interface IibbPreviewActivity {
  id: string;
  code: string | null;
  name: string;
  rate: number;
  min_tax: number;
  sales: number;
  voids: number;
  returns: number;
  base_raw: number;
  base: number;
  tax: number;
  minimum_applied: boolean;
}

export interface IibbPreview {
  jurisdiction: string;
  period: string;
  regime: "local" | "cm";
  coefficient: number | null;
  activities: IibbPreviewActivity[];
  base_total: number;
  determined: number;
  deductions: IibbDeductions & { compras: number };
  deductions_total: number;
  previous_credit: number;
  previous_liquidation_id: string | null;
  previous_period: string | null;
  opening_credit: number | null;
  available: number;
  used: number;
  to_pay: number;
  credit_next: number;
  entries: number;
  purchase_perceptions: number;
  sales_count: number;
  sales_without_breakdown: number;
  warnings: string[];
}

export const IIBB_WARNING_TEXT: Record<string, string> = {
  monotributo: "El negocio figura como monotributista: si estás en el Régimen Simplificado de Ingresos Brutos pagás un monto fijo y esta liquidación no corresponde.",
  no_activity_match: "Hay ventas de categorías sin actividad asignada: fueron a la actividad principal.",
  negative_base: "Alguna actividad da base negativa (más devoluciones que ventas): el impuesto queda en cero y conviene revisarlo con el contador.",
  legacy_sales: "Hay ventas anteriores al desglose de IVA: su neto se estimó con la alícuota del ítem.",
  gap: "La liquidación anterior confirmada no es la del mes previo: el saldo a favor viene de un mes más viejo.",
  opening_ignored: "Ya hay una liquidación anterior confirmada: el saldo inicial cargado no se usa.",
  cm_without_coefficient: "Convenio Multilateral sin coeficiente vigente para la jurisdicción: cargalo en la pestaña Convenio Multilateral.",
  review_pending: "Hay retenciones de Ingresos Brutos para revisar (sin jurisdicción identificada): no entran hasta que les asignes la jurisdicción.",
  current_month: "El mes todavía no terminó: es una vista previa.",
};

/** Filas de la planilla de la liquidación (XLSX). */
export function iibbSheetRows(p: IibbPreview): Array<{ concepto: string; importe: number | null; detalle?: string }> {
  const rows: Array<{ concepto: string; importe: number | null; detalle?: string }> = [];
  for (const a of p.activities) {
    rows.push({
      concepto: `${a.code ? `${a.code} · ` : ""}${a.name}`,
      importe: a.tax,
      detalle: `Base ${a.base.toFixed(2)} × ${a.rate} %${a.minimum_applied ? " (mínimo)" : ""}`,
    });
  }
  rows.push({ concepto: "Impuesto determinado", importe: p.determined });
  rows.push({ concepto: "Retenciones sufridas", importe: -p.deductions.retencion });
  rows.push({ concepto: "Percepciones sufridas", importe: -p.deductions.percepcion, detalle: `de las cuales en compras ${p.deductions.compras.toFixed(2)}` });
  rows.push({ concepto: "SIRCREB", importe: -p.deductions.sircreb });
  rows.push({ concepto: "SIRTAC", importe: -p.deductions.sirtac });
  rows.push({ concepto: "Saldo a favor anterior", importe: -p.previous_credit });
  rows.push({ concepto: "Saldo a pagar", importe: p.to_pay });
  rows.push({ concepto: "Saldo a favor para el mes siguiente", importe: p.credit_next });
  return rows;
}
