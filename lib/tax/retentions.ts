// lib/tax/retentions.ts
//
// Retenciones como AGENTE en la orden de pago (F18 · H106, ADR-079). Lógica
// PURA y espejo EXACTO de `_tax_retention_compute` (migración
// 20261104200100_retenciones_agente_motor): mismos pasos, mismos códigos de
// motivo y mismo redondeo (centavos, mitad hacia arriba). La paridad se prueba
// con tests/fixtures/retentionMatrix.ts en unit (TS) y en integración (SQL vía
// tax_retention_preview).
//
// Qué calcula, por cada régimen de retención activo del negocio:
//
//   · Ganancias (RG 830): por CONCEPTO (bienes, servicios, honorarios,
//     alquileres, ...). Acumula los pagos del MES al mismo proveedor por el
//     mismo concepto: sujeto = acumulado − mínimo no sujeto; retención del mes
//     = sujeto × alícuota (o la escala del Anexo VIII para honorarios de
//     inscriptos); se retiene ahora lo que falta (retención del mes − lo ya
//     retenido en el mes). Sin inscripción en Ganancias: alícuota de no
//     inscripto y sin mínimo no sujeto. Monotributistas: no se retiene. Por
//     debajo del importe mínimo de retención no se retiene ahora y queda
//     acumulado para el próximo pago del mes.
//   · SUSS (RG 1784, 1556, 1769, 3983): sólo si el proveedor tiene cargada
//     una actividad alcanzada (construcción, limpieza, seguridad, eventuales).
//   · IVA e IIBB: alícuota del padrón, de la condición o general, sobre la
//     base del régimen (neto, neto gravado, total o el IVA facturado), con
//     mínimos de base y de importe.
//   · En todos: certificado de exclusión vigente (100 % no retiene; parcial
//     reduce).
//
// Los VALORES (mínimos, alícuotas, escala, códigos de SICORE) no viven acá:
// están en las tablas `tax_ret_concepts` y `tax_ret_scales` (seed versionado
// por vigencia, ver docs/32-impuestos.md) y el negocio puede pisarlos en
// `tax_ret_concept_settings`. Todos están marcados "verificar con contador".

export type RetTax = "ganancias" | "iva" | "iibb" | "suss";
export type RetBaseKind = "net" | "net_taxed" | "total" | "vat";
export type GananciasCondition = "inscripto" | "no_inscripto" | "exento" | "no_alcanzado";

export interface RetRegime {
  id: string;
  tax: RetTax;
  jurisdiction: string | null;
  name: string;
  padron_source: "none" | "arba" | "agip" | "generic";
  default_rate: number | null;
  rates_by_condition: Record<string, number>;
  base_kind: RetBaseKind;
  min_base: number;
  min_amount: number;
  applies_to: string[];
}

/** Concepto de Ganancias o actividad de SUSS ya combinado con los ajustes del negocio. */
export interface RetConcept {
  tax: "ganancias" | "suss";
  code: string;
  name: string;
  /** Mínimo no sujeto MENSUAL (Ganancias) o pago mínimo (SUSS). */
  min_non_taxable: number;
  /** Alícuota para inscriptos (Ganancias) o la del régimen (SUSS). null = usa escala. */
  rate_registered: number | null;
  /** Alícuota para no inscriptos en Ganancias. */
  rate_unregistered: number | null;
  uses_scale: boolean;
  scale_code: string | null;
  /** Importe mínimo de retención: por debajo no se retiene ahora. */
  min_withholding: number;
  /** ¿El mínimo no sujeto también se descuenta a los no inscriptos? (RG 830: no). */
  unregistered_min_applies: boolean;
  sicore_tax_code: number | null;
  sicore_regime_code: string | null;
}

export interface ScaleBracket {
  from: number;
  to: number | null;
  fixed: number;
  rate: number;
}

export interface RetSupplier {
  iva_condition: string | null;
  cuit: string | null;
  ganancias_condition: GananciasCondition | null;
  ganancias_concept: string | null;
  suss_code: string | null;
}

/** Bases de ESTE pago (en pesos). */
export interface RetBases {
  net: number;
  net_taxed: number;
  total: number;
  vat: number;
}

export interface RetContext {
  regimes: RetRegime[];
  supplier: RetSupplier;
  bases: RetBases;
  /** Concepto de Ganancias elegido (ya resuelto) o null. */
  ganancias: RetConcept | null;
  /** Actividad SUSS del proveedor (ya resuelta) o null. */
  suss: RetConcept | null;
  /** Escala del concepto de Ganancias (si usa escala). */
  scale: ScaleBracket[];
  /** Pagos del mes al proveedor por el concepto de Ganancias, sin este. */
  prior: { base: number; withheld: number };
  /** Alícuota del padrón por régimen (null = no figura). */
  padronRates: Record<string, number | null>;
  /** % de exclusión vigente: clave `tax` (todas las jurisdicciones) o `iibb:902`. */
  exemptions: Record<string, number>;
  /**
   * Proveedor sin condición en Ganancias cargada (ADR-101, parámetro del
   * negocio gan_unknown_as_unregistered): inscripto (plantilla) o no inscripto.
   */
  unknownCondition?: "inscripto" | "no_inscripto";
}

export type RetReason =
  | "applied"
  | "no_base"
  | "condition_not_reached"
  | "no_rate"
  | "exempt"
  | "below_min_base"
  | "below_min_amount"
  | "monotributo"
  | "gan_not_subject"
  | "no_concept"
  | "below_non_taxable"
  | "already_withheld"
  | "below_min_withholding"
  | "suss_not_applicable";

export interface RetLine {
  regime_id: string;
  tax: RetTax;
  jurisdiction: string | null;
  name: string;
  applies: boolean;
  reason: RetReason;
  amount: number;
  /** Base de este pago para el régimen. */
  base: number;
  rate: number | null;
  rate_source: "padron" | "condition" | "default" | "registered" | "unregistered" | "scale" | null;
  exemption_pct: number;
  // Ganancias (acumulado mensual)
  concept_code: string | null;
  condition: GananciasCondition | null;
  prior_base: number;
  accumulated_base: number;
  non_taxable_min: number;
  taxable_base: number;
  month_total: number;
  prior_withheld: number;
  /** Lo que correspondería retener ahora antes del mínimo de retención y la exclusión. */
  computed: number;
  min_withholding: number;
  /** ¿Se registra para acumular aunque no se retenga? (Ganancias con concepto y base). */
  accumulates: boolean;
}

// ---------------------------------------------------------------------------
// Aritmética en centavos (mitad hacia arriba, como `round(x, 2)` de Postgres
// para positivos). Las alícuotas tienen hasta 4 decimales: BigInt para no
// perder precisión en importes grandes.
// ---------------------------------------------------------------------------
export function toCents(n: number): bigint {
  return BigInt(Math.round(n * 100));
}
function rateUnits(rate: number): bigint {
  return BigInt(Math.round(rate * 10000));
}
function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (num < 0n) return -divRoundHalfUp(-num, den);
  return (num * 2n + den) / (den * 2n);
}
export function fromCents(c: bigint): number {
  return Number(c) / 100;
}
/** base × rate % redondeado a centavos. */
export function pct(base: number, rate: number): number {
  return fromCents(divRoundHalfUp(toCents(base) * rateUnits(rate), 1_000_000n));
}
/** round(x, 2) mitad hacia arriba. */
export function round2(x: number): number {
  return fromCents(toCents(x));
}
/** round(x, 4) (alícuota efectiva con exclusión parcial). */
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Escala (Anexo VIII de la RG 830): fijo + (sujeto − desde) × alícuota. */
export function scaleAmount(subject: number, scale: ScaleBracket[]): number {
  if (!(subject > 0) || scale.length === 0) return 0;
  const sorted = [...scale].sort((a, b) => a.from - b.from);
  let b = sorted[0]!;
  for (const x of sorted) if (subject > x.from) b = x;
  return round2(b.fixed + pct(subject - b.from, b.rate));
}

/** Condición en Ganancias efectiva: monotributo y vacío resueltos. */
export function effectiveGananciasCondition(
  s: RetSupplier,
  unknown: "inscripto" | "no_inscripto" = "inscripto",
): GananciasCondition | "monotributo" {
  if (s.iva_condition === "monotributo" || s.iva_condition === "monotributo_social") return "monotributo";
  return s.ganancias_condition ?? unknown;
}

function baseOf(kind: RetBaseKind, b: RetBases): number {
  switch (kind) {
    case "net_taxed":
      return b.net_taxed;
    case "total":
      return b.total;
    case "vat":
      return b.vat;
    default:
      return b.net;
  }
}

function emptyLine(r: RetRegime, base: number): RetLine {
  return {
    regime_id: r.id,
    tax: r.tax,
    jurisdiction: r.jurisdiction,
    name: r.name,
    applies: false,
    reason: "applied",
    amount: 0,
    base,
    rate: null,
    rate_source: null,
    exemption_pct: 0,
    concept_code: null,
    condition: null,
    prior_base: 0,
    accumulated_base: 0,
    non_taxable_min: 0,
    taxable_base: 0,
    month_total: 0,
    prior_withheld: 0,
    computed: 0,
    min_withholding: 0,
    accumulates: false,
  };
}

const TAX_ORDER: Record<RetTax, number> = { ganancias: 1, iva: 2, iibb: 3, suss: 4 };

export function exemptionKey(tax: RetTax, jurisdiction: string | null): string {
  return tax === "iibb" && jurisdiction ? `iibb:${jurisdiction}` : tax;
}

function ganancias(r: RetRegime, ctx: RetContext): RetLine {
  const base = ctx.bases.net;
  const l = emptyLine(r, base);
  const cond = effectiveGananciasCondition(ctx.supplier, ctx.unknownCondition ?? "inscripto");
  l.condition = cond === "monotributo" ? null : cond;
  if (cond === "monotributo") return { ...l, reason: "monotributo" };
  if (cond === "exento" || cond === "no_alcanzado") return { ...l, reason: "gan_not_subject" };
  const c = ctx.ganancias;
  if (!c) return { ...l, reason: "no_concept" };
  l.concept_code = c.code;
  l.min_withholding = c.min_withholding;
  if (!(base > 0)) return { ...l, reason: "no_base" };
  l.accumulates = true;
  l.prior_base = round2(ctx.prior.base);
  l.prior_withheld = round2(ctx.prior.withheld);
  l.accumulated_base = round2(l.prior_base + base);
  const registered = cond === "inscripto";
  l.non_taxable_min = registered || c.unregistered_min_applies ? c.min_non_taxable : 0;
  l.taxable_base = round2(Math.max(l.accumulated_base - l.non_taxable_min, 0));
  if (registered && c.uses_scale) {
    l.rate_source = "scale";
    l.rate = null;
  } else {
    l.rate = registered ? c.rate_registered : c.rate_unregistered;
    l.rate_source = registered ? "registered" : "unregistered";
    if (l.rate == null) return { ...l, reason: "no_rate" };
  }
  l.exemption_pct = ctx.exemptions[exemptionKey("ganancias", null)] ?? 0;
  if (l.exemption_pct >= 100) return { ...l, reason: "exempt" };
  if (!(l.taxable_base > 0)) return { ...l, reason: "below_non_taxable" };
  l.month_total = l.rate_source === "scale" ? scaleAmount(l.taxable_base, ctx.scale) : pct(l.taxable_base, l.rate!);
  l.computed = round2(l.month_total - l.prior_withheld);
  if (!(l.computed > 0)) return { ...l, computed: 0, reason: "already_withheld" };
  const amount = l.exemption_pct > 0 ? pct(l.computed, 100 - l.exemption_pct) : l.computed;
  if (amount < c.min_withholding || !(amount > 0)) return { ...l, reason: "below_min_withholding" };
  return { ...l, applies: true, reason: "applied", amount };
}

function generic(r: RetRegime, ctx: RetContext): RetLine {
  const base = round2(baseOf(r.base_kind, ctx.bases));
  const l = emptyLine(r, base);
  const s = ctx.supplier;
  let minBase = r.min_base;
  let minAmount = r.min_amount;
  let rate: number | null = null;
  let src: RetLine["rate_source"] = "default";

  if (r.tax === "suss") {
    const a = ctx.suss;
    if (!a) return { ...l, reason: "suss_not_applicable" };
    l.concept_code = a.code;
    minBase = Math.max(minBase, a.min_non_taxable);
    minAmount = Math.max(minAmount, a.min_withholding);
    l.min_withholding = minAmount;
    rate = r.default_rate ?? a.rate_registered;
  }
  if (!r.applies_to.includes(s.iva_condition ?? "responsable_inscripto")) {
    return { ...l, reason: "condition_not_reached" };
  }
  if (!(base > 0)) return { ...l, reason: "no_base" };
  if (r.tax !== "suss") {
    const p = ctx.padronRates[r.id];
    if (r.padron_source !== "none" && p != null) {
      rate = p;
      src = "padron";
    } else if (s.iva_condition && Object.prototype.hasOwnProperty.call(r.rates_by_condition, s.iva_condition)) {
      rate = r.rates_by_condition[s.iva_condition]!;
      src = "condition";
    } else {
      rate = r.default_rate;
    }
  }
  l.rate_source = src;
  if (rate == null || !(rate > 0)) return { ...l, rate, reason: "no_rate" };
  // Como _tax_exemption_pct: la de la jurisdicción o la general del impuesto (la mayor).
  l.exemption_pct = Math.max(ctx.exemptions[exemptionKey(r.tax, r.jurisdiction)] ?? 0, ctx.exemptions[r.tax] ?? 0);
  if (l.exemption_pct >= 100) return { ...l, rate, reason: "exempt" };
  const eff = round4(rate * (1 - l.exemption_pct / 100));
  l.rate = eff;
  if (base < minBase) return { ...l, reason: "below_min_base", min_withholding: minAmount };
  const amount = pct(base, eff);
  l.computed = amount;
  if (!(amount > 0) || amount < minAmount) return { ...l, reason: "below_min_amount", min_withholding: minAmount };
  return { ...l, applies: true, reason: "applied", amount, min_withholding: minAmount };
}

/** Calcula todas las retenciones (aplicadas y no aplicadas, con su motivo). */
export function computeRetentions(ctx: RetContext): { lines: RetLine[]; total: number } {
  const lines = [...ctx.regimes]
    .sort(
      (a, b) =>
        TAX_ORDER[a.tax] - TAX_ORDER[b.tax] || (a.jurisdiction ?? "").localeCompare(b.jurisdiction ?? ""),
    )
    .map((r) => (r.tax === "ganancias" ? ganancias(r, ctx) : generic(r, ctx)));
  const total = round2(lines.reduce((t, l) => t + (l.applies ? l.amount : 0), 0));
  return { lines, total };
}

// ---------------------------------------------------------------------------
// Bases de un pago desde la imputación (espejo de `_tax_retention_bases`).
// ---------------------------------------------------------------------------
export interface InvoiceForBase {
  id: string;
  total: number;
  net_total: number;
  vat_total: number;
  exempt_amount: number;
  non_taxed_amount: number;
}

export function basesFromAllocations(
  allocations: { invoice_id: string; amount: number }[],
  invoices: InvoiceForBase[],
  fallbackAmount: number,
): RetBases {
  const valid = allocations.filter((a) => a.amount > 0 && invoices.some((i) => i.id === a.invoice_id));
  if (valid.length === 0) {
    const a = round2(Math.max(fallbackAmount, 0));
    return { net: a, net_taxed: a, total: a, vat: 0 };
  }
  const b: RetBases = { net: 0, net_taxed: 0, total: 0, vat: 0 };
  for (const a of valid) {
    const i = invoices.find((x) => x.id === a.invoice_id)!;
    if (!(i.total > 0)) continue;
    b.net += round2((a.amount * (i.net_total + i.exempt_amount + i.non_taxed_amount)) / i.total);
    b.net_taxed += round2((a.amount * i.net_total) / i.total);
    b.vat += round2((a.amount * i.vat_total) / i.total);
    b.total += round2(a.amount);
  }
  return { net: round2(b.net), net_taxed: round2(b.net_taxed), total: round2(b.total), vat: round2(b.vat) };
}

// ---------------------------------------------------------------------------
// Lenguaje simple para la orden de pago
// ---------------------------------------------------------------------------
export const RET_TAX_LABEL: Record<RetTax, string> = {
  ganancias: "Ganancias",
  iva: "IVA",
  iibb: "Ingresos Brutos",
  suss: "SUSS",
};

export const GANANCIAS_CONDITION_LABEL: Record<GananciasCondition, string> = {
  inscripto: "Inscripto en Ganancias",
  no_inscripto: "No inscripto en Ganancias",
  exento: "Exento en Ganancias",
  no_alcanzado: "No alcanzado por Ganancias",
};

const money = (n: number) =>
  "$ " +
  n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctTxt = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 4 })} %`;

/** Una frase que explica por qué se retiene o no. */
export function explainRetention(l: RetLine): string {
  switch (l.reason) {
    case "applied":
      if (l.tax === "ganancias") {
        const how =
          l.rate_source === "scale"
            ? "con la escala de la RG 830"
            : `al ${pctTxt(l.rate ?? 0)}${l.rate_source === "unregistered" ? " (no inscripto)" : ""}`;
        const prev = l.prior_base > 0 ? ` En el mes ya le pagaste ${money(l.prior_base)} por este concepto.` : "";
        const ret = l.prior_withheld > 0 ? ` Ya le retuviste ${money(l.prior_withheld)}: se descuenta.` : "";
        return (
          `Acumulado del mes ${money(l.accumulated_base)} menos el mínimo no sujeto ${money(l.non_taxable_min)} ` +
          `= ${money(l.taxable_base)} sujetos a retención, ${how}.${prev}${ret}` +
          (l.exemption_pct > 0 ? ` Con exclusión parcial del ${pctTxt(l.exemption_pct)}.` : "")
        );
      }
      return (
        `${pctTxt(l.rate ?? 0)} sobre ${money(l.base)}` +
        (l.rate_source === "padron"
          ? " (alícuota del padrón)."
          : l.rate_source === "condition"
            ? " (alícuota por la condición del proveedor)."
            : ".") +
        (l.exemption_pct > 0 ? ` Con exclusión parcial del ${pctTxt(l.exemption_pct)}.` : "")
      );
    case "no_base":
      return "No hay importe sobre el que retener en este pago.";
    case "condition_not_reached":
      return "El régimen no alcanza a proveedores con esta condición frente al IVA.";
    case "no_rate":
      return "No hay alícuota: el proveedor no figura en el padrón y el régimen no tiene alícuota general.";
    case "exempt":
      return "Tiene un certificado de exclusión vigente: no se retiene.";
    case "below_min_base":
      return `La base (${money(l.base)}) no llega al mínimo del régimen.`;
    case "below_min_amount":
      return `La retención daría ${money(l.computed)}, menos que el mínimo del régimen (${money(l.min_withholding)}).`;
    case "monotributo":
      return "Es monotributista: no se le retiene Ganancias.";
    case "gan_not_subject":
      return "Está exento o no alcanzado en Ganancias (según su ficha): no se retiene.";
    case "no_concept":
      return "Elegí qué le estás pagando (bienes, servicios, honorarios...) para calcular Ganancias.";
    case "below_non_taxable":
      return (
        `Lo pagado en el mes por este concepto (${money(l.accumulated_base)}) no supera el mínimo no sujeto ` +
        `(${money(l.non_taxable_min)}). Si le pagás más este mes, se suma.`
      );
    case "already_withheld":
      return `En el mes ya le retuviste ${money(l.prior_withheld)}, lo que corresponde por lo pagado.`;
    case "below_min_withholding":
      return (
        `Correspondería ${money(l.computed)}, menos que el mínimo de retención (${money(l.min_withholding)}). ` +
        "No se retiene ahora: queda acumulado para el próximo pago del mes."
      );
    case "suss_not_applicable":
      return "El proveedor no tiene cargada una actividad alcanzada por SUSS (construcción, limpieza, seguridad o eventuales).";
  }
}

/** Mensajes de error del servidor para retenciones. */
export function retentionErrorMessage(m: string): string | null {
  if (m.includes("retentions_changed"))
    return "Las retenciones cambiaron desde que las calculaste (otro pago del mes o cambios en el padrón). Volvé a calcular.";
  if (m.includes("invalid_concept")) return "El concepto de Ganancias no existe.";
  if (m.includes("invalid_suss")) return "La actividad de SUSS no existe.";
  if (m.includes("agent_cuit_missing")) return "Cargá el CUIT del negocio en Configuración > Impuestos antes de retener.";
  return null;
}
