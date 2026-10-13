// Retenciones y percepciones SUFRIDAS (el negocio como sujeto) · F18 · H106,
// ADR-095. PURO.
//
// - classifyTaxText: clasifica el texto de un impuesto descontado en una
//   liquidación de procesador (Mercado Pago `charges_details`, columnas de un
//   archivo de Payway, Getnet, Fiserv o Nave) o en un extracto bancario.
//   ESPEJO EXACTO de _tax_suffered_classify y _tax_jurisdiction_code
//   (migración 20261109300000): mismas expresiones y mismo orden. Paridad con
//   tests/fixtures/sufferedMatrix.ts.
// - parseSufferedFile: lee el CSV de "Mis Retenciones" (ARCA), la consulta
//   de SIRCREB o SIRTAC (COMARB) o una planilla propia con encabezado.
//   Diseños orientativos: se detectan las columnas por el nombre.
// - groupSuffered: totales para la declaración jurada por impuesto,
//   jurisdicción, tipo y régimen.
// - classifyWithRules: reglas propias del negocio (ADR-105) antes de la
//   clasificación de NinjaSoft. ESPEJO de _tax_suffered_classify_for
//   (migración 20261110100100).

import { isValidCuit, jurisdictionName, normalizeDigits } from "./catalog";
import { parsePadronDate } from "./padron";
import { round2 } from "./retentions";

export type SufferedTax = "iibb" | "iva" | "ganancias" | "suss" | "debitos_creditos" | "otro";
export type SufferedKind = "retencion" | "percepcion" | "pago_a_cuenta";
export type SufferedRegime = "general" | "sircreb" | "sirtac" | "procesador" | "otro";
export type SufferedOrigin = "cliente" | "procesador" | "banco" | "manual" | "importado" | "compra";

export const SUFFERED_TAX_LABEL: Record<SufferedTax, string> = {
  iibb: "Ingresos Brutos",
  iva: "IVA",
  ganancias: "Ganancias",
  suss: "SUSS",
  debitos_creditos: "Débitos y créditos",
  otro: "Otro",
};

export const SUFFERED_KIND_LABEL: Record<SufferedKind, string> = {
  retencion: "Retención",
  percepcion: "Percepción",
  pago_a_cuenta: "Pago a cuenta",
};

export const SUFFERED_REGIME_LABEL: Record<SufferedRegime, string> = {
  general: "General",
  sircreb: "SIRCREB (bancos)",
  sirtac: "SIRTAC (tarjetas)",
  procesador: "Procesador de pagos",
  otro: "Otro",
};

export const SUFFERED_ORIGIN_LABEL: Record<SufferedOrigin, string> = {
  cliente: "Cobro de un cliente",
  procesador: "Liquidación de procesador",
  banco: "Banco",
  manual: "Carga manual",
  importado: "Importado",
  compra: "Factura de proveedor",
};

// ---------------------------------------------------------------------------
// Texto normalizado: minúsculas, sin tildes, "_", "-", "." y "/" como espacio.
// (SQL: translate(lower(x), 'áéíóúüñ_-./', 'aeiouun    '))
// ---------------------------------------------------------------------------
export function normalizeTaxText(s: string | null | undefined): string {
  const map: Record<string, string> = { á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", ñ: "n", _: " ", "-": " ", ".": " ", "/": " " };
  return (s ?? "")
    .toLowerCase()
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
}

// Jurisdicción (código de Convenio Multilateral) mencionada en un texto. El
// orden importa: CABA antes que Buenos Aires; Santiago del Estero, Santa Fe y
// Santa Cruz por nombre completo. Espejo de _tax_jurisdiction_code.
const JURISDICTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b9(0[1-9]|1[0-9]|2[0-4])\b/, "$"],
  [/(\bcaba\b|ciudad autonoma|ciudad de buenos aires|capital federal|\bagip\b|\barciba\b)/, "901"],
  [/(\barba\b|provincia de buenos aires|\bpba\b|\bbs as\b|buenos aires)/, "902"],
  [/catamarca/, "903"],
  [/cordoba/, "904"],
  [/corrientes/, "905"],
  [/chaco/, "906"],
  [/chubut/, "907"],
  [/entre rios/, "908"],
  [/formosa/, "909"],
  [/jujuy/, "910"],
  [/la pampa/, "911"],
  [/la rioja/, "912"],
  [/mendoza/, "913"],
  [/misiones/, "914"],
  [/neuquen/, "915"],
  [/rio negro/, "916"],
  [/salta/, "917"],
  [/san juan/, "918"],
  [/san luis/, "919"],
  [/santa cruz/, "920"],
  [/santa fe/, "921"],
  [/santiago del estero/, "922"],
  [/tierra del fuego/, "923"],
  [/tucuman/, "924"],
];

export function jurisdictionFromText(s: string | null | undefined): string | null {
  const t = normalizeTaxText(s);
  if (!t.trim()) return null;
  for (const [re, code] of JURISDICTION_PATTERNS) {
    const m = t.match(re);
    if (m) return code === "$" ? m[0] : code;
  }
  return null;
}

export interface TaxClassification {
  /** No es una retención ni una percepción (IVA sobre la comisión: crédito fiscal). */
  skip: boolean;
  tax: SufferedTax;
  kind: SufferedKind;
  regime: SufferedRegime;
  jurisdiction: string | null;
  /** Hay que revisarlo a mano (impuesto o jurisdicción sin identificar). */
  needs_review: boolean;
}

/**
 * Clasifica un impuesto descontado por un procesador o un banco.
 * `defaultRegime` es el régimen cuando el texto no dice SIRCREB ni SIRTAC
 * ("procesador" en las liquidaciones, "general" en las cargas).
 * `defaultJurisdiction` es la del negocio: se usa para IIBB sin jurisdicción
 * en el texto y la línea queda para revisar.
 */
export function classifyTaxText(
  text: string | null | undefined,
  defaultJurisdiction: string | null = null,
  defaultRegime: SufferedRegime = "procesador",
): TaxClassification {
  const t = normalizeTaxText(text);
  const skip =
    /\biva\b/.test(t) && /(comision|\bfee\b|arancel|servicio)/.test(t) && !/(reten|percep|withholding|perception)/.test(t);
  const regime: SufferedRegime = /sirtac/.test(t) ? "sirtac" : /sircreb/.test(t) ? "sircreb" : defaultRegime;
  let tax: SufferedTax;
  if (/(debitos? y creditos?|debitos creditos|25413|25 413|impuesto al cheque|imp cheque|\bidc\b)/.test(t)) {
    tax = "debitos_creditos";
  } else if (/(iibb|ingresos brutos|sirtac|sircreb|\barba\b|\bagip\b|\biibb\b)/.test(t)) {
    tax = "iibb";
  } else if (/ganancias/.test(t)) {
    tax = "ganancias";
  } else if (/\biva\b/.test(t)) {
    tax = "iva";
  } else if (/(\bsuss\b|seguridad social)/.test(t)) {
    tax = "suss";
  } else {
    tax = "otro";
  }
  const kind: SufferedKind =
    tax === "debitos_creditos" ? "pago_a_cuenta" : /(percep|perception)/.test(t) ? "percepcion" : "retencion";
  let jurisdiction: string | null = null;
  let review = tax === "otro";
  if (tax === "iibb") {
    jurisdiction = jurisdictionFromText(t);
    if (!jurisdiction) {
      jurisdiction = defaultJurisdiction;
      review = true;
    }
  }
  return { skip, tax, kind, regime, jurisdiction, needs_review: review };
}

// ---------------------------------------------------------------------------
// Reglas del negocio (ADR-105)
// ---------------------------------------------------------------------------
export interface SufferedRule {
  /** Texto normalizado que tiene que aparecer (normalizeRulePattern). */
  pattern: string;
  /** Ignorar la línea (no es una retención). */
  skip?: boolean;
  tax?: SufferedTax;
  kind?: SufferedKind;
  regime?: SufferedRegime | null;
  jurisdiction?: string | null;
}

export type RuleClassification = TaxClassification & { rule?: string };

/** Mismo normalizado que la base: minúsculas, sin tildes y espacios simples. */
export function normalizeRulePattern(s: string | null | undefined): string {
  return normalizeTaxText(s).replace(/\s+/g, " ").trim();
}

/** La regla que aplica a un texto: la de patrón más largo (empate: la primera). */
export function matchSufferedRule(text: string | null | undefined, rules: readonly SufferedRule[]): SufferedRule | null {
  const t = normalizeRulePattern(text);
  if (!t) return null;
  let best: SufferedRule | null = null;
  for (const r of rules) {
    const p = normalizeRulePattern(r.pattern);
    if (!p || !t.includes(p)) continue;
    if (!best || p.length > normalizeRulePattern(best.pattern).length) best = r;
  }
  return best;
}

/**
 * Clasificación con las reglas del negocio: si una regla coincide, manda
 * (ignorar la línea o impuesto, tipo, régimen y jurisdicción); si no, la de
 * NinjaSoft. Sin jurisdicción en la regla ni en el texto, IIBB toma la del
 * negocio y queda para revisar.
 */
export function classifyWithRules(
  text: string | null | undefined,
  defaultJurisdiction: string | null = null,
  defaultRegime: SufferedRegime = "procesador",
  rules: readonly SufferedRule[] = [],
): RuleClassification {
  const base = classifyTaxText(text, defaultJurisdiction, defaultRegime);
  const r = matchSufferedRule(text, rules);
  if (!r) return base;
  const pattern = normalizeRulePattern(r.pattern);
  if (r.skip) return { ...base, skip: true, rule: pattern };
  const tax: SufferedTax = r.tax ?? "otro";
  let found: string | null = null;
  let jurisdiction: string | null = null;
  if (tax === "iibb") {
    found = r.jurisdiction || jurisdictionFromText(normalizeRulePattern(text));
    jurisdiction = found ?? defaultJurisdiction;
  }
  return {
    skip: false,
    tax,
    kind: r.kind ?? (tax === "debitos_creditos" ? "pago_a_cuenta" : "retencion"),
    regime: r.regime || base.regime,
    jurisdiction,
    needs_review: tax === "otro" || (tax === "iibb" && !found),
    rule: pattern,
  };
}

// ---------------------------------------------------------------------------
// Importación (Mis Retenciones, SIRCREB, SIRTAC o planilla propia)
// ---------------------------------------------------------------------------
export interface SufferedImportRow {
  tax: SufferedTax;
  kind: SufferedKind;
  regime: SufferedRegime;
  jurisdiction: string | null;
  operation_date: string;
  amount: number;
  base_amount: number | null;
  rate: number | null;
  agent_cuit: string | null;
  agent_name: string | null;
  certificate: string | null;
  needs_review: boolean;
}

export interface SufferedParseError {
  line: number;
  message: string;
}

export interface SufferedParseResult {
  rows: SufferedImportRow[];
  errors: SufferedParseError[];
  /** Columnas reconocidas (para mostrar qué se leyó). */
  columns: Partial<Record<ColumnKey, string>>;
  skipped: number;
}

type ColumnKey =
  | "date"
  | "amount"
  | "base"
  | "cuit"
  | "agent"
  | "tax"
  | "regime"
  | "jurisdiction"
  | "certificate"
  | "rate"
  | "kind";

// El orden importa: cada encabezado se asigna a la primera clave que lo
// reconoce y cada clave toma una sola columna.
const HEADER_RULES: Array<[ColumnKey, RegExp, RegExp?]> = [
  ["base", /(base|monto sujeto|importe sujeto|sujeto a)/],
  ["rate", /(alicuota|\btasa\b|porcentaje)/],
  ["date", /fecha/, /(comprobante|emision|vto|vencimiento)/],
  ["amount", /(importe|monto|retenido|percibido|retencion|percepcion|\btotal\b)/, /(base|sujeto|comprobante)/],
  ["cuit", /cuit/],
  ["agent", /(denominacion|razon social|nombre|agente)/],
  ["tax", /(impuesto|tributo)/, /descripcion/],
  ["regime", /regimen/, /descripcion/],
  ["jurisdiction", /(jurisdiccion|provincia)/],
  ["certificate", /(certificado|constancia|nro comprobante|numero de comprobante|comprobante)/],
  ["kind", /(\btipo\b|operacion)/],
];

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === sep && !q) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** "1.234,56", "1234,56", "1234.56" o "$ -1.234" → número (null si no se puede). */
export function parseArAmount(v: string | null | undefined): number | null {
  let s = String(v ?? "").replace(/[$\s]/g, "");
  if (!s) return null;
  const neg = /^-|^\(.*\)$/.test(s);
  s = s.replace(/[()-]/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Código numérico de impuesto de ARCA (Mis Retenciones / SICORE) → impuesto. */
const ARCA_TAX_CODES: Record<string, SufferedTax> = {
  "10": "ganancias",
  "11": "ganancias",
  "217": "ganancias",
  "218": "ganancias",
  "30": "iva",
  "767": "iva",
  "353": "suss",
  "103": "debitos_creditos",
};

function sepOf(line: string): string {
  const counts = [";", "\t", ",", "|"].map((s) => [s, line.split(s).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ";";
}

/**
 * Lee el archivo. `defaultJurisdiction` se usa para IIBB sin jurisdicción
 * (la fila queda para revisar). `hint` fuerza el régimen cuando se sabe de
 * dónde viene el archivo (consulta de SIRCREB o de SIRTAC).
 */
export function parseSufferedFile(
  text: string,
  defaultJurisdiction: string | null = null,
  hint: "sircreb" | "sirtac" | null = null,
  rules: readonly SufferedRule[] = [],
): SufferedParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const errors: SufferedParseError[] = [];
  const rows: SufferedImportRow[] = [];
  let skipped = 0;
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx < 0) return { rows, errors: [{ line: 0, message: "El archivo está vacío." }], columns: {}, skipped };
  const sep = sepOf(lines[headerIdx]!);
  const header = splitLine(lines[headerIdx]!, sep).map(normalizeTaxText);
  const col: Partial<Record<ColumnKey, number>> = {};
  const columns: Partial<Record<ColumnKey, string>> = {};
  header.forEach((h, i) => {
    for (const [key, re, not] of HEADER_RULES) {
      if (col[key] !== undefined) continue;
      if (re.test(h) && !(not && not.test(h))) {
        col[key] = i;
        columns[key] = h;
        break;
      }
    }
  });
  if (col.date === undefined || col.amount === undefined) {
    return {
      rows,
      errors: [{ line: headerIdx + 1, message: "No se encontraron las columnas de fecha e importe en el encabezado." }],
      columns,
      skipped,
    };
  }
  const get = (cells: string[], k: ColumnKey) => (col[k] === undefined ? "" : (cells[col[k]!] ?? "").trim());

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const cells = splitLine(raw, sep);
    const lineNo = i + 1;
    const date = parsePadronDate(get(cells, "date").slice(0, 10).replace(/\s.*$/, ""));
    const amount = parseArAmount(get(cells, "amount"));
    if (!date) {
      errors.push({ line: lineNo, message: "Fecha ilegible." });
      continue;
    }
    if (amount === null) {
      errors.push({ line: lineNo, message: "Importe ilegible." });
      continue;
    }
    if (amount <= 0) {
      skipped++;
      continue;
    }
    const taxRaw = get(cells, "tax");
    const regimeRaw = get(cells, "regime");
    const kindRaw = get(cells, "kind");
    const jurRaw = get(cells, "jurisdiction");
    const textAll = [taxRaw, regimeRaw, kindRaw, hint ?? ""].join(" ");
    const rule = matchSufferedRule(textAll, rules);
    const c = classifyWithRules(textAll, null, "general", rules);
    if (c.skip && rule) {
      skipped++;
      continue;
    }
    let tax = c.tax;
    const code = normalizeDigits(taxRaw);
    if (!rule && tax === "otro" && code && ARCA_TAX_CODES[code]) tax = ARCA_TAX_CODES[code]!;
    if (hint && !rule) tax = "iibb";
    let jurisdiction =
      tax !== "iibb"
        ? null
        : rule?.jurisdiction
          ? rule.jurisdiction
          : (jurisdictionFromText(jurRaw) ?? (c.tax === "iibb" ? c.jurisdiction : null));
    let review = tax === "otro";
    if (tax === "iibb" && !jurisdiction) {
      jurisdiction = defaultJurisdiction;
      review = true;
    }
    const cuit = normalizeDigits(get(cells, "cuit"));
    const rate = parseArAmount(get(cells, "rate"));
    const base = parseArAmount(get(cells, "base"));
    rows.push({
      tax,
      kind: tax === "debitos_creditos" ? "pago_a_cuenta" : c.kind,
      regime: hint ?? (c.regime === "procesador" ? "general" : c.regime),
      jurisdiction,
      operation_date: date,
      amount: round2(amount),
      base_amount: base !== null && base >= 0 ? round2(base) : null,
      rate: rate !== null && rate >= 0 && rate <= 100 ? rate : null,
      agent_cuit: cuit.length === 11 && isValidCuit(cuit) ? cuit : null,
      agent_name: get(cells, "agent").slice(0, 120) || null,
      certificate: get(cells, "certificate").slice(0, 40) || null,
      needs_review: review,
    });
  }
  return { rows, errors, columns, skipped };
}

// ---------------------------------------------------------------------------
// Totales para la declaración jurada
// ---------------------------------------------------------------------------
export interface SufferedRow {
  id: string;
  source: "entry" | "purchase";
  tax: SufferedTax;
  kind: SufferedKind;
  regime: SufferedRegime;
  jurisdiction: string | null;
  origin: SufferedOrigin;
  operation_date: string;
  period: string;
  amount: number;
  base_amount: number | null;
  rate: number | null;
  agent_cuit: string | null;
  agent_name: string | null;
  certificate: string | null;
  status: "active" | "voided";
  needs_review: boolean;
  notes?: string | null;
  customer_name?: string | null;
  provider_key?: string | null;
  linked?: "payment" | "cc_movement" | "settlement_line" | "treasury_movement" | null;
  liquidated?: boolean;
}

export interface SufferedGroup {
  key: string;
  tax: SufferedTax;
  jurisdiction: string | null;
  kind: SufferedKind;
  regime: SufferedRegime;
  label: string;
  count: number;
  amount: number;
}

export function groupLabel(g: Pick<SufferedGroup, "tax" | "jurisdiction" | "kind" | "regime">): string {
  const parts = [SUFFERED_KIND_LABEL[g.kind], SUFFERED_TAX_LABEL[g.tax]];
  if (g.jurisdiction) parts.push(jurisdictionName(g.jurisdiction));
  if (g.regime === "sircreb" || g.regime === "sirtac") parts.push(g.regime.toUpperCase());
  return parts.join(" · ");
}

/** Vigentes agrupadas por impuesto, jurisdicción, tipo y régimen (sin las anuladas). */
export function groupSuffered(rows: SufferedRow[]): { groups: SufferedGroup[]; byTax: Record<SufferedTax, number>; total: number } {
  const map = new Map<string, SufferedGroup>();
  const byTax: Record<SufferedTax, number> = { iibb: 0, iva: 0, ganancias: 0, suss: 0, debitos_creditos: 0, otro: 0 };
  let totalCents = 0;
  for (const r of rows) {
    if (r.status !== "active") continue;
    const regime: SufferedRegime = r.regime === "sircreb" || r.regime === "sirtac" ? r.regime : "general";
    const key = [r.tax, r.jurisdiction ?? "-", r.kind, regime].join("|");
    const g =
      map.get(key) ??
      ({ key, tax: r.tax, jurisdiction: r.jurisdiction, kind: r.kind, regime, label: "", count: 0, amount: 0 } as SufferedGroup);
    g.count++;
    g.amount = round2(g.amount + r.amount);
    map.set(key, g);
    byTax[r.tax] = round2(byTax[r.tax] + r.amount);
    totalCents += Math.round(r.amount * 100);
  }
  const order: SufferedTax[] = ["iibb", "iva", "ganancias", "suss", "debitos_creditos", "otro"];
  const groups = [...map.values()]
    .map((g) => ({ ...g, label: groupLabel(g) }))
    .sort(
      (a, b) =>
        order.indexOf(a.tax) - order.indexOf(b.tax) ||
        (a.jurisdiction ?? "").localeCompare(b.jurisdiction ?? "") ||
        a.kind.localeCompare(b.kind) ||
        a.regime.localeCompare(b.regime),
    );
  return { groups, byTax, total: totalCents / 100 };
}

/** Mensaje en castellano para los errores de las RPC de sufridas e IIBB. */
export function sufferedErrorMessage(m: string): string | null {
  const map: Array<[RegExp, string]> = [
    [/feature_not_in_plan: percepciones_retenciones/, "Percepciones y retenciones vienen desde el plan Business."],
    [/feature_not_in_plan: tesoreria/, "Para registrar el débito en el banco hace falta Tesorería."],
    [/iibb_period_liquidated/, "Ese mes de Ingresos Brutos ya está liquidado: anulá la liquidación para cambiarlo."],
    [/suffered_invalid_tax/, "Elegí el impuesto."],
    [/suffered_invalid_kind/, "Elegí si es retención, percepción o pago a cuenta."],
    [/suffered_jurisdiction_required|tax_suffered_entries_jurisdiction/, "Ingresos Brutos necesita la jurisdicción; los otros impuestos no llevan."],
    [/suffered_invalid_amount/, "El importe tiene que ser mayor que cero."],
    [/suffered_invalid_date/, "Revisá la fecha."],
    [/tax_suffered_entries_agent_cuit/, "El CUIT del agente no es válido (revisá el dígito verificador)."],
    [/suffered_link_not_found/, "No se encontró el documento vinculado."],
    [/suffered_link_mismatch/, "Vinculá un solo documento."],
    [/suffered_voided/, "La retención está anulada."],
    [/suffered_immutable/, "El importe, la fecha y el origen no se cambian: anulala y cargala de nuevo."],
    [/treasury_account_not_found/, "No se encontró la cuenta de tesorería."],
    [/too_many_rows/, "Importá hasta 2000 filas por vez."],
    [/iibb_no_activity/, "Cargá al menos una actividad con su alícuota para esa jurisdicción."],
    [/iibb_period_not_ended/, "Sólo se confirman meses terminados."],
    [/iibb_already_confirmed/, "Ese mes ya tiene una liquidación confirmada para la jurisdicción."],
    [/iibb_changed/, "Los datos cambiaron desde la vista previa (ventas, retenciones o saldo a favor). Revisá y confirmá de nuevo."],
    [/iibb_later_confirmed/, "Primero anulá las liquidaciones de los meses siguientes de esa jurisdicción."],
    [/iibb_invalid_jurisdiction/, "Elegí la jurisdicción."],
    [/iibb_activities_default|iibb_activities_one_default/, "Sólo puede haber una actividad principal por jurisdicción."],
    [/iibb_cm_coefficients_key/, "Ya hay un coeficiente para esa jurisdicción y fecha: editalo."],
    [/iibb_cm_sum/, "La suma de los coeficientes vigentes no puede superar 1."],
    [/reason_required/, "Escribí el motivo."],
  ];
  for (const [re, text] of map) if (re.test(m)) return text;
  return null;
}
