// Valores impositivos del negocio sobre las plantillas de NinjaSoft (F18,
// ADR-105). PURO.
//
// Cada valor normativo que NinjaSoft siembra (alícuotas de IVA, tope del
// consumidor final, conceptos de Ganancias y SUSS, escalas, criterios y
// códigos de los archivos) es una PLANTILLA. El negocio la usa tal cual o la
// pisa con una versión con vigencia (desde / hasta) en `tax_custom_values`;
// también puede crear conceptos y reglas propias, desactivar un valor en un
// período o volver a la plantilla (baja lógica de sus versiones).
//
// Resolución (ESPEJO de _tax_custom_at en la migración 20261110100000):
// a una fecha rige la versión que la cubre (valid_from <= fecha y valid_to
// vacío o >= fecha) con la valid_from más nueva (empate: la más nueva);
// sin versión, la plantilla. Una versión con is_active = false desactiva el
// valor en su vigencia. Los campos vacíos de una versión usan la plantilla.

import { pct, round2 } from "./retentions";

export type CustomCatalog =
  | "iva_rate"
  | "parameter"
  | "ret_concept"
  | "ret_scale"
  | "regime_values"
  | "iibb_activity"
  | "suffered_rule";

export interface CustomValue {
  id: string;
  catalog: CustomCatalog;
  item_key: string;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  is_custom: boolean;
  data: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at?: string;
}

export type CustomState = "template" | "custom" | "own" | "disabled";

/** Versión que rige a la fecha (aaaa-mm-dd) o null (rige la plantilla). */
export function versionAt<T extends Pick<CustomValue, "valid_from" | "valid_to" | "created_at">>(
  versions: readonly T[],
  at: string,
): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.valid_from > at) continue;
    if (v.valid_to != null && v.valid_to < at) continue;
    if (
      !best ||
      v.valid_from > best.valid_from ||
      (v.valid_from === best.valid_from && v.created_at > best.created_at)
    ) {
      best = v;
    }
  }
  return best;
}

export interface Resolved<T extends Record<string, unknown>> {
  /** Valores que rigen (plantilla pisada por la versión). */
  values: T;
  /** Versión que rige o null. */
  version: CustomValue | null;
  state: CustomState;
  /** Activo en la fecha (una versión con is_active = false lo apaga). */
  active: boolean;
}

/**
 * Valor efectivo: la plantilla con los campos de la versión vigente encima.
 * `template` null = valor propio (sin plantilla): todo sale de la versión.
 */
export function resolveCustom<T extends Record<string, unknown>>(
  template: T | null,
  versions: readonly CustomValue[],
  at: string,
): Resolved<T> {
  const v = versionAt(versions, at);
  const base = (template ?? {}) as T;
  if (!v) return { values: base, version: null, state: template ? "template" : "own", active: template != null };
  const values = { ...base } as Record<string, unknown>;
  for (const [k, x] of Object.entries(v.data ?? {})) {
    if (x !== undefined) values[k] = x;
  }
  return {
    values: values as T,
    version: v,
    state: !v.is_active ? "disabled" : v.is_custom || !template ? "own" : "custom",
    active: v.is_active,
  };
}

/** ¿El negocio cambió algo (alguna versión vigente o futura)? */
export function isCustomized(versions: readonly CustomValue[]): boolean {
  return versions.length > 0;
}

/** Versiones ordenadas para mostrar (la más nueva arriba). */
export function sortVersions<T extends Pick<CustomValue, "valid_from" | "created_at">>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) =>
    a.valid_from === b.valid_from ? a.created_at.localeCompare(b.created_at) : b.valid_from.localeCompare(a.valid_from),
  );
}

export const CUSTOM_STATE_LABEL: Record<CustomState, string> = {
  template: "Plantilla NinjaSoft",
  custom: "Personalizado",
  own: "Propio",
  disabled: "Desactivado",
};

// ---------------------------------------------------------------------------
// Campos editables por catálogo (la pantalla y la validación usan lo mismo)
// ---------------------------------------------------------------------------
export type FieldKind = "percent" | "money" | "number" | "integer" | "code" | "text" | "bool";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  help: string;
  min?: number;
  max?: number;
  /** Largo máximo (texto) o dígitos (código). */
  maxLength?: number;
}

export const RET_CONCEPT_FIELDS: FieldDef[] = [
  { key: "name", label: "Nombre", kind: "text", maxLength: 120, help: "Cómo aparece en la orden de pago y en el certificado." },
  {
    key: "min_non_taxable",
    label: "Mínimo no sujeto mensual",
    kind: "money",
    min: 0,
    help: "Lo que se le puede pagar al proveedor en el mes sin retener. Se descuenta del acumulado del mes (no a los no inscriptos).",
  },
  {
    key: "rate_registered",
    label: "Alícuota inscripto",
    kind: "percent",
    min: 0,
    max: 100,
    help: "Porcentaje para proveedores inscriptos en Ganancias. Vacío si se calcula por escala.",
  },
  {
    key: "rate_unregistered",
    label: "Alícuota no inscripto",
    kind: "percent",
    min: 0,
    max: 100,
    help: "Porcentaje para proveedores no inscriptos (sin mínimo no sujeto).",
  },
  {
    key: "min_withholding",
    label: "Retención mínima",
    kind: "money",
    min: 0,
    help: "Si lo que hay que retener da menos, no se retiene y queda acumulado para el próximo pago del mes.",
  },
  {
    key: "uses_scale",
    label: "Calcular inscriptos por escala",
    kind: "bool",
    help: "Para honorarios y similares: a los inscriptos se les aplica la escala (fijo + porcentaje del excedente) en vez de la alícuota.",
  },
  {
    key: "scale_code",
    label: "Escala",
    kind: "text",
    maxLength: 30,
    help: "Código de la escala que se usa (rg830_anexo8 es la de la RG 830). Podés crear una propia en Escalas.",
  },
  {
    key: "sicore_regime_code",
    label: "Código de régimen SICORE",
    kind: "code",
    maxLength: 3,
    help: "Tres dígitos que pide SICORE para este concepto. Lo confirma tu contador.",
  },
  {
    key: "sicore_tax_code",
    label: "Código de impuesto SICORE",
    kind: "integer",
    min: 1,
    max: 999,
    help: "217 Ganancias, 353 SUSS. Cambialo sólo si tu contador lo indica.",
  },
];

export const IVA_RATE_FIELDS: FieldDef[] = [
  {
    key: "rate",
    label: "Alícuota",
    kind: "percent",
    min: 0,
    max: 100,
    help: "Porcentaje de IVA que se usa para desglosar las ventas y llevar las listas netas a precio final.",
  },
  { key: "label", label: "Nombre", kind: "text", maxLength: 40, help: "Cómo se ve en la ficha del producto y en los reportes." },
];

export const IIBB_ACTIVITY_FIELDS: FieldDef[] = [
  { key: "rate", label: "Alícuota", kind: "percent", min: 0, max: 100, help: "Porcentaje de IIBB de la actividad desde la fecha." },
  {
    key: "min_tax",
    label: "Impuesto mínimo mensual",
    kind: "money",
    min: 0,
    help: "Si el impuesto del mes da menos, se paga el mínimo.",
  },
];

export const REGIME_VALUE_FIELDS: FieldDef[] = [
  {
    key: "default_rate",
    label: "Alícuota general",
    kind: "percent",
    min: 0,
    max: 100,
    help: "La que se usa si el CUIT no figura en el padrón ni hay una alícuota para su condición.",
  },
  { key: "min_base", label: "Base mínima", kind: "money", min: 0, help: "Debajo de esta base no se percibe ni se retiene." },
  { key: "min_amount", label: "Monto mínimo", kind: "money", min: 0, help: "Si el importe da menos, no se aplica." },
];

/** Parámetros: clave → cómo se edita y qué significa. */
export const PARAMETER_DEFS: Record<
  string,
  { label: string; help: string; kind: FieldKind; section: "iva" | "retenciones" | "exportaciones"; options?: { value: number; label: string }[] }
> = {
  cf_id_threshold: {
    label: "Tope para vender a consumidor final sin identificarlo",
    help: "Por encima de este total el POS avisa que hay que pedir el documento del comprador. Vacío o desactivado: sin aviso.",
    kind: "money",
    section: "iva",
  },
  gan_unknown_as_unregistered: {
    label: "Proveedor sin constancia de Ganancias",
    help: "Cómo se lo trata en la orden de pago si no cargaste su condición en Ganancias.",
    kind: "integer",
    section: "retenciones",
    options: [
      { value: 0, label: "Como inscripto (con aviso)" },
      { value: 1, label: "Como no inscripto" },
    ],
  },
  sicore_iva_tax_code: {
    label: "Código de impuesto de IVA en SICORE",
    help: "El que va en cada retención de IVA del archivo de SICORE (767 en la plantilla).",
    kind: "integer",
    section: "exportaciones",
  },
  sicore_cbte_code: {
    label: "Código de comprobante en SICORE",
    help: "Tipo de comprobante de la orden de pago en el archivo de SICORE (06 en la plantilla).",
    kind: "integer",
    section: "exportaciones",
  },
  arba_branch: {
    label: "Sucursal en el archivo de ARBA",
    help: "Número de sucursal que va en cada retención del archivo de ARBA (0001 en la plantilla).",
    kind: "integer",
    section: "exportaciones",
  },
  arba_activity: {
    label: "Actividad en el nombre del archivo de ARBA",
    help: "Número de actividad del lote de ARBA (6 = retenciones en la plantilla).",
    kind: "integer",
    section: "exportaciones",
  },
};

// ---------------------------------------------------------------------------
// Formularios: texto ↔ datos de la versión
// ---------------------------------------------------------------------------
/** "1.234,5" | "1234.5" → 1234.5; vacío → null; ilegible → NaN. */
export function parseDecimal(v: string | null | undefined): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : NaN;
}

export function formatDecimal(n: unknown): string {
  if (n == null || n === "") return "";
  const x = Number(n);
  return Number.isFinite(x) ? String(x).replace(".", ",") : "";
}

/**
 * Arma `data` desde los textos del formulario: vacío = usa la plantilla (no
 * va). Devuelve los errores por campo (mismo criterio que la base).
 */
export function buildData(
  fields: readonly FieldDef[],
  form: Record<string, string | boolean | undefined>,
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = form[f.key];
    if (raw === undefined || raw === "") continue;
    if (f.kind === "bool") {
      data[f.key] = raw === true || raw === "true";
      continue;
    }
    if (f.kind === "text") {
      const t = String(raw).trim();
      if (!t) continue;
      if (f.maxLength && t.length > f.maxLength) errors[f.key] = `Hasta ${f.maxLength} caracteres.`;
      else data[f.key] = t;
      continue;
    }
    if (f.kind === "code") {
      const t = String(raw).trim();
      if (!t) continue;
      if (!/^\d+$/.test(t) || (f.maxLength && t.length > f.maxLength)) {
        errors[f.key] = `Sólo números, hasta ${f.maxLength ?? 3} dígitos.`;
      } else data[f.key] = t;
      continue;
    }
    const n = parseDecimal(String(raw));
    if (n == null) continue;
    if (Number.isNaN(n)) {
      errors[f.key] = "Número inválido.";
      continue;
    }
    if (f.kind === "integer" && !Number.isInteger(n)) {
      errors[f.key] = "Tiene que ser un número entero.";
      continue;
    }
    if (f.min != null && n < f.min) {
      errors[f.key] = `No puede ser menor que ${f.min}.`;
      continue;
    }
    if (f.max != null && n > f.max) {
      errors[f.key] = `No puede ser mayor que ${f.max}.`;
      continue;
    }
    data[f.key] = n;
  }
  return { data, errors };
}

/** Valida la vigencia de una versión. */
export function validateValidity(from: string, to: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return "Elegí desde cuándo rige.";
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "La fecha de fin es inválida.";
  if (to && to < from) return "La fecha de fin no puede ser anterior al inicio.";
  return null;
}

// ---------------------------------------------------------------------------
// Escalas
// ---------------------------------------------------------------------------
export interface ScaleRow {
  from_amount: number;
  to_amount: number | null;
  fixed: number;
  rate: number;
}

/** Misma regla que la base: arranca en 0, desde creciente, hasta > desde, alícuota 0 a 100. */
export function validateScale(rows: readonly ScaleRow[]): string | null {
  if (rows.length === 0) return "Agregá al menos un tramo.";
  if (rows.length > 30) return "Hasta 30 tramos.";
  const s = [...rows].sort((a, b) => a.from_amount - b.from_amount);
  if (s[0]!.from_amount !== 0) return "El primer tramo tiene que empezar en 0.";
  for (let i = 0; i < s.length; i++) {
    const r = s[i]!;
    if (!(r.from_amount >= 0) || !(r.fixed >= 0) || !(r.rate >= 0 && r.rate <= 100)) return `Tramo ${i + 1}: valores inválidos.`;
    if (r.to_amount != null && !(r.to_amount > r.from_amount)) return `Tramo ${i + 1}: el "hasta" tiene que ser mayor que el "desde".`;
    if (i > 0 && r.from_amount === s[i - 1]!.from_amount) return `Tramo ${i + 1}: dos tramos empiezan en el mismo monto.`;
  }
  return null;
}

/** Fijo + (sujeto − desde) × alícuota del tramo (espejo de _tax_ret_scale_amount_for). */
export function scaleAmountOf(subject: number, rows: readonly ScaleRow[]): number {
  if (!(subject > 0) || rows.length === 0) return 0;
  const s = [...rows].sort((a, b) => b.from_amount - a.from_amount);
  const b = s.find((r) => subject > r.from_amount || r.from_amount === 0);
  if (!b) return 0;
  return round2(b.fixed + pct(subject - b.from_amount, b.rate));
}

// ---------------------------------------------------------------------------
// Historial (audit_logs)
// ---------------------------------------------------------------------------
export interface HistoryEntry {
  at: string;
  action: string;
  actor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const ACTION_LABEL: Record<string, string> = {
  INSERT: "Creó",
  UPDATE: "Cambió",
  DELETE: "Borró",
  tax_custom_reset: "Volvió a la plantilla",
};

export interface HistoryLine {
  at: string;
  actor: string;
  what: string;
  changes: { field: string; before: string; after: string }[];
}

const HIDDEN = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "catalog",
  "item_key",
]);

function show(v: unknown): string {
  if (v == null || v === "") return "vacío";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Lo que cambió en cada entrada del historial, en palabras. */
export function describeHistory(entries: readonly HistoryEntry[]): HistoryLine[] {
  return entries.map((e) => {
    const before = flatten(e.before);
    const after = flatten(e.after);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !HIDDEN.has(k));
    const changes = keys
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => ({ field: k, before: show(before[k]), after: show(after[k]) }));
    let what = ACTION_LABEL[e.action] ?? e.action;
    if (e.action === "UPDATE" && before.deleted_at == null && after.deleted_at != null) what = "Quitó una versión";
    return { at: e.at, actor: e.actor ?? "Sistema", what, changes: e.action === "tax_custom_reset" ? [] : changes };
  });
}

function flatten(o: Record<string, unknown> | null): Record<string, unknown> {
  if (!o) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "data" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) out[dk] = dv;
    } else out[k] = v;
  }
  return out;
}

/** Mensajes de los errores de la base (tax_custom_*). */
export function customErrorMessage(m: string): string | null {
  if (m.includes("tax_custom_duplicate_from")) return "Ya hay una versión que empieza ese día: editala o elegí otra fecha.";
  if (m.includes("tax_custom_not_found")) return "Ese valor ya no existe. Actualizá la pantalla.";
  if (m.includes("tax_custom_invalid: brackets")) return "La escala no es válida: tiene que empezar en 0 y los tramos no pueden repetirse.";
  if (m.includes("tax_custom_invalid: key")) return "Ese valor no existe en la plantilla (para uno propio, crealo como propio).";
  if (m.includes("tax_custom_invalid: name")) return "Poné un nombre.";
  if (m.includes("tax_custom_invalid: valid_to")) return "La fecha de fin no puede ser anterior al inicio.";
  if (m.includes("tax_custom_invalid: rate") && m.includes("rate_")) return "Cargá al menos una alícuota.";
  if (m.includes("tax_custom_invalid")) return "Algún valor no es válido. Revisá los campos.";
  if (m.includes("padron_profile_invalid")) return "El perfil del padrón está incompleto: falta el CUIT, la alícuota o alguna posición.";
  if (m.includes("padron_profile_not_found")) return "El perfil del padrón no existe.";
  return null;
}
