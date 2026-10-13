// =============================================================================
// Comisiones estimadas por medio de pago (F8 · ADR-099).
//
// Espejo puro de payment_fees_report (migración 20261109800100): qué regla
// aplica a cada grupo de cobros (medio, procesador, cuotas) y cuánto da la
// comisión estimada, el IVA sobre la comisión y el neto. La RPC calcula lo del
// reporte; esto lo usa la UI para la vista previa del editor y los tests.
// =============================================================================

export const FEE_METHODS = ["debit", "credit", "qr", "transfer", "other", "directo"] as const;
export type FeeMethod = (typeof FEE_METHODS)[number];

/** IVA sobre la comisión del procesador (Argentina, 21 %). */
export const FEE_VAT_RATE = 0.21;

export interface FeeRule {
  id: string;
  method: string;
  provider_key: string | null;
  installments: number | null;
  fee_pct: number;
  fixed_fee: number;
  vat_on_fee: boolean;
  note?: string | null;
  created_at?: string;
}

export interface FeeGroup {
  method: string;
  provider_key: string | null;
  installments: number | null;
  count: number;
  gross: number;
}

export interface FeeEstimate {
  fee: number;
  vat: number;
  net: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Puntaje de especificidad: procesador pesa 2 y cuotas 1 (como la RPC). */
function specificity(r: FeeRule): number {
  return (r.provider_key ? 2 : 0) + (r.installments != null ? 1 : 0);
}

/** La regla más específica que aplica al grupo, o null si no hay. */
export function pickFeeRule(rules: readonly FeeRule[], g: Pick<FeeGroup, "method" | "provider_key" | "installments">): FeeRule | null {
  const hits = rules.filter(
    (r) =>
      r.method === g.method &&
      (r.provider_key == null || r.provider_key === g.provider_key) &&
      (r.installments == null || r.installments === g.installments),
  );
  if (hits.length === 0) return null;
  return [...hits].sort((a, b) => {
    const d = specificity(b) - specificity(a);
    if (d !== 0) return d;
    return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  })[0] ?? null;
}

/** comisión = bruto × % / 100 + fijo × cobros; IVA sobre la comisión si corresponde. */
export function estimateFee(
  rule: Pick<FeeRule, "fee_pct" | "fixed_fee" | "vat_on_fee"> | null,
  gross: number,
  count: number,
): FeeEstimate {
  if (!rule) return { fee: 0, vat: 0, net: round2(gross) };
  const fee = round2((gross * Number(rule.fee_pct || 0)) / 100 + Number(rule.fixed_fee || 0) * count);
  const vat = rule.vat_on_fee ? round2(fee * FEE_VAT_RATE) : 0;
  return { fee, vat, net: round2(gross - fee - vat) };
}

export interface FeeReportRow extends FeeGroup, FeeEstimate {
  rule_id: string | null;
  fee_pct: number;
  fixed_fee: number;
  vat_on_fee: boolean;
}

export interface FeeReportTip {
  method: string;
  count: number;
  amount: number;
}

export interface FeeReport {
  rows: FeeReportRow[];
  tips: FeeReportTip[];
}

/** Normaliza el jsonb de la RPC (números como number, nulls coherentes). */
export function normalizeFeeReport(raw: unknown): FeeReport {
  const o = (raw ?? {}) as { rows?: unknown[]; tips?: unknown[] };
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const rows = (Array.isArray(o.rows) ? o.rows : []).map((x) => {
    const r = x as Record<string, unknown>;
    return {
      method: String(r.method ?? "other"),
      provider_key: r.provider_key ? String(r.provider_key) : null,
      installments: r.installments == null ? null : num(r.installments),
      count: num(r.count),
      gross: num(r.gross),
      rule_id: r.rule_id ? String(r.rule_id) : null,
      fee_pct: num(r.fee_pct),
      fixed_fee: num(r.fixed_fee),
      vat_on_fee: r.vat_on_fee === true,
      fee: num(r.fee),
      vat: num(r.vat),
      net: num(r.net),
    };
  });
  const tips = (Array.isArray(o.tips) ? o.tips : []).map((x) => {
    const t = x as Record<string, unknown>;
    return { method: String(t.method ?? "other"), count: num(t.count), amount: num(t.amount) };
  });
  return { rows, tips };
}

export interface FeeTotals {
  gross: number;
  fee: number;
  vat: number;
  net: number;
  /** Comisión + IVA sobre lo cobrado por medios con comisión, en %. */
  effectivePct: number;
  /** Grupos con cobros electrónicos sin regla cargada. */
  withoutRule: number;
}

export function feeTotals(rows: readonly FeeReportRow[]): FeeTotals {
  const gross = round2(rows.reduce((a, r) => a + r.gross, 0));
  const fee = round2(rows.reduce((a, r) => a + r.fee, 0));
  const vat = round2(rows.reduce((a, r) => a + r.vat, 0));
  const net = round2(rows.reduce((a, r) => a + r.net, 0));
  const charged = rows.filter((r) => r.rule_id).reduce((a, r) => a + r.gross, 0);
  const effectivePct = charged > 0 ? round2(((fee + vat) / charged) * 100) : 0;
  const withoutRule = rows.filter(
    (r) => !r.rule_id && (FEE_METHODS as readonly string[]).includes(r.method),
  ).length;
  return { gross, fee, vat, net, effectivePct, withoutRule };
}

export interface FeeRuleDraft {
  method: string;
  provider_key: string | null;
  installments: number | null;
  fee_pct: number;
  fixed_fee: number;
  vat_on_fee: boolean;
  note: string | null;
}

/** Validación del editor, espejo de los checks de payment_fee_rules. */
export function validateFeeRule(d: FeeRuleDraft): string | null {
  if (!(FEE_METHODS as readonly string[]).includes(d.method)) return "Elegí un medio de pago.";
  if (d.installments != null && (!Number.isInteger(d.installments) || d.installments < 1 || d.installments > 99))
    return "Las cuotas van de 1 a 99.";
  if (!Number.isFinite(d.fee_pct) || d.fee_pct < 0 || d.fee_pct > 100) return "La comisión va de 0 a 100 %.";
  if (!Number.isFinite(d.fixed_fee) || d.fixed_fee < 0 || d.fixed_fee > 1_000_000) return "El cargo fijo no es válido.";
  if (d.note && d.note.length > 120) return "La nota tiene hasta 120 caracteres.";
  return null;
}

/** Texto corto de la regla: "3,5 % + $10 + IVA". */
export function describeFeeRule(r: Pick<FeeRule, "fee_pct" | "fixed_fee" | "vat_on_fee">): string {
  const parts: string[] = [];
  if (r.fee_pct > 0) parts.push(`${String(r.fee_pct).replace(".", ",")} %`);
  if (r.fixed_fee > 0) parts.push(`$${String(r.fixed_fee).replace(".", ",")} por cobro`);
  if (parts.length === 0) return "Sin comisión";
  return parts.join(" + ") + (r.vat_on_fee ? " + IVA" : "");
}
