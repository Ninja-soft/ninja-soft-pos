// Reglas del cupón del posnet offline (ADR-054).
//
// Por cada dato del cupón (lote, cupón, autorización, últimos 4, n° de
// comercio, cuotas) el negocio decide si se pide, si es obligatorio, si es
// numérico o alfanumérico y su largo (exacto o mínimo y máximo), con
// excepciones por adquirente (Payway: lote de 3 dígitos). Viven en
// pos_settings.card_voucher_rules (jsonb) y se heredan por sucursal y caja
// con config_overrides (campo map_any: se pisa por clave de primer nivel).
//
// Espejo exacto de la validación del servidor (`_card_voucher_field_rule` y
// el trigger `payments_card_voucher` de la migración 20261018300000): lo que
// el POS deja pasar, el servidor también, y viceversa.
//
// Compatibilidad con pos_settings.require_card_voucher (H27): si está
// prendido, cupón, lote y autorización se piden y son obligatorios siempre.
//
// Puro y testeable: sin React ni Supabase.

import { ACQUIRER_KEYS, isAcquirerKey, type AcquirerKey } from "@/lib/payments/acquirers";

export const VOUCHER_FIELDS = ["lote", "cupon", "autorizacion", "ultimos4", "comercio", "cuotas"] as const;
export type VoucherFieldKey = (typeof VOUCHER_FIELDS)[number];

export type VoucherValueType = "numeric" | "alnum";

export interface VoucherFieldRule {
  /** Se pide en el POS. */
  ask: boolean;
  /** Obligatorio (sólo si se pide). */
  required: boolean;
  type: VoucherValueType;
  /** Largo mínimo y máximo (iguales = largo exacto). 1 a 20. */
  min: number;
  max: number;
}

export type FieldRulesPatch = Partial<Record<VoucherFieldKey, Partial<VoucherFieldRule>>>;

export interface CardVoucherRules {
  /** Adquirentes que se ofrecen en el POS (vacío o ausente: los del negocio). */
  acquirers?: string[];
  /** Reglas generales por dato. */
  fields?: FieldRulesPatch;
  /** Excepciones por adquirente (pisan dato por dato a las generales). */
  by_acquirer?: Partial<Record<AcquirerKey, FieldRulesPatch>>;
}

export const FIELD_LABEL: Record<VoucherFieldKey, string> = {
  lote: "N° de lote",
  cupon: "N° de cupón",
  autorizacion: "Autorización",
  ultimos4: "Últimos 4",
  comercio: "N° de comercio",
  cuotas: "Cuotas",
};

/** Etiqueta corta (resumen tipo cupón). */
export const FIELD_SHORT: Record<VoucherFieldKey, string> = {
  lote: "Lote",
  cupon: "Cupón",
  autorizacion: "Autorización",
  ultimos4: "Últimos 4",
  comercio: "Comercio",
  cuotas: "Cuotas",
};

export const MAX_LEN = 20;
const CORE: VoucherFieldKey[] = ["cupon", "lote", "autorizacion"];

/** Lo que el POS pedía antes de las reglas (H27 + ADR-042). */
export const LEGACY_RULES: Record<VoucherFieldKey, VoucherFieldRule> = {
  cupon: { ask: true, required: false, type: "alnum", min: 1, max: MAX_LEN },
  lote: { ask: true, required: false, type: "alnum", min: 1, max: MAX_LEN },
  autorizacion: { ask: true, required: false, type: "alnum", min: 1, max: MAX_LEN },
  ultimos4: { ask: true, required: false, type: "numeric", min: 4, max: 4 },
  // El n° de comercio sale de Medios de pago y las cuotas del plan elegido:
  // por defecto no se tipean.
  comercio: { ask: false, required: false, type: "alnum", min: 1, max: MAX_LEN },
  cuotas: { ask: false, required: false, type: "numeric", min: 1, max: 2 },
};

/**
 * Valores sugeridos por adquirente (lo que imprime cada terminal). Son un
 * punto de partida editable: el dueño los aplica con "Usar sugeridos".
 */
export const ACQUIRER_PRESETS: Record<Exclude<AcquirerKey, "other">, FieldRulesPatch> = {
  payway: {
    lote: { ask: true, required: true, type: "numeric", min: 3, max: 3 },
    cupon: { ask: true, required: true, type: "numeric", min: 1, max: 4 },
    autorizacion: { ask: true, required: true, type: "alnum", min: 6, max: 6 },
    ultimos4: { ask: true, required: true, type: "numeric", min: 4, max: 4 },
  },
  getnet: {
    lote: { ask: true, required: true, type: "numeric", min: 1, max: 6 },
    cupon: { ask: true, required: true, type: "numeric", min: 1, max: 6 },
    autorizacion: { ask: true, required: true, type: "alnum", min: 6, max: 6 },
    ultimos4: { ask: true, required: true, type: "numeric", min: 4, max: 4 },
  },
  mercadopago: {
    // El Point imprime el n° de operación (va en cupón) y no tiene lote.
    lote: { ask: false, required: false },
    cupon: { ask: true, required: true, type: "numeric", min: 6, max: 14 },
    autorizacion: { ask: true, required: false, type: "alnum", min: 6, max: 6 },
    ultimos4: { ask: true, required: true, type: "numeric", min: 4, max: 4 },
  },
  fiserv: {
    lote: { ask: true, required: true, type: "numeric", min: 3, max: 3 },
    cupon: { ask: true, required: true, type: "numeric", min: 1, max: 4 },
    autorizacion: { ask: true, required: true, type: "alnum", min: 6, max: 6 },
    ultimos4: { ask: true, required: true, type: "numeric", min: 4, max: 4 },
  },
  nave: {
    lote: { ask: true, required: true, type: "numeric", min: 1, max: 6 },
    cupon: { ask: true, required: true, type: "numeric", min: 1, max: 8 },
    autorizacion: { ask: true, required: true, type: "alnum", min: 6, max: 6 },
    ultimos4: { ask: true, required: true, type: "numeric", min: 4, max: 4 },
  },
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function clampLen(n: unknown, fallback: number): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_LEN, Math.max(1, v)) : fallback;
}

/** Aplica un parche parcial sobre una regla completa, normalizando largos. */
export function applyRulePatch(base: VoucherFieldRule, patch: unknown): VoucherFieldRule {
  const p = obj(patch);
  const out: VoucherFieldRule = { ...base };
  if (typeof p.ask === "boolean") out.ask = p.ask;
  if (typeof p.required === "boolean") out.required = p.required;
  if (p.type === "numeric" || p.type === "alnum") out.type = p.type;
  if (p.min !== undefined) out.min = clampLen(p.min, out.min);
  if (p.max !== undefined) out.max = clampLen(p.max, out.max);
  if (out.min > out.max) out.max = out.min;
  return out;
}

/**
 * Regla efectiva de un dato para un adquirente: base de siempre ← generales
 * del negocio ← excepción del adquirente; con require_card_voucher, cupón,
 * lote y autorización quedan pedidos y obligatorios.
 */
export function fieldRule(
  rules: CardVoucherRules | null | undefined,
  requireFlag: boolean,
  acquirer: string | null | undefined,
  field: VoucherFieldKey,
): VoucherFieldRule {
  let r = applyRulePatch(LEGACY_RULES[field], obj(rules?.fields)[field]);
  if (acquirer && isAcquirerKey(acquirer)) {
    r = applyRulePatch(r, obj(obj(rules?.by_acquirer)[acquirer])[field]);
  }
  if (requireFlag && CORE.includes(field)) r = { ...r, ask: true, required: true };
  if (!r.ask) r = { ...r, required: false };
  return r;
}

export type EffectiveRules = Record<VoucherFieldKey, VoucherFieldRule>;

export function effectiveRules(
  rules: CardVoucherRules | null | undefined,
  requireFlag: boolean,
  acquirer: string | null | undefined,
): EffectiveRules {
  const out = {} as EffectiveRules;
  for (const f of VOUCHER_FIELDS) out[f] = fieldRule(rules, requireFlag, acquirer, f);
  return out;
}

/** Datos que se piden, en el orden del cupón. */
export function askedFields(eff: EffectiveRules): VoucherFieldKey[] {
  return VOUCHER_FIELDS.filter((f) => eff[f].ask);
}

/** Limpia lo tipeado según el tipo y el máximo (numérico: sólo dígitos). */
export function sanitizeValue(rule: VoucherFieldRule, raw: string): string {
  const clean = rule.type === "numeric" ? raw.replace(/\D/g, "") : raw.replace(/[^0-9a-z]/gi, "").toUpperCase();
  return clean.slice(0, rule.max);
}

export type FieldError = "required" | "format" | "length" | null;

/** Error de un valor (vacío y opcional = sin error). */
export function valueError(rule: VoucherFieldRule, value: string | number | null | undefined): FieldError {
  const v = value == null ? "" : String(value).trim();
  if (!rule.ask) return null;
  if (v === "") return rule.required ? "required" : null;
  const re = rule.type === "numeric" ? /^[0-9]+$/ : /^[0-9A-Za-z]+$/;
  if (!re.test(v)) return "format";
  if (v.length < rule.min || v.length > rule.max) return "length";
  return null;
}

export function lengthHint(rule: VoucherFieldRule): string {
  const unit = rule.type === "numeric" ? "dígito" : "caracter";
  const units = rule.type === "numeric" ? "dígitos" : "caracteres";
  if (rule.min === rule.max) return `${rule.min} ${rule.min === 1 ? unit : units}`;
  if (rule.min <= 1) return `Hasta ${rule.max} ${units}`;
  return `${rule.min} a ${rule.max} ${units}`;
}

export function errorText(field: VoucherFieldKey, rule: VoucherFieldRule, err: FieldError): string | null {
  if (!err) return null;
  const label = FIELD_LABEL[field];
  if (err === "required") return `Falta ${label.toLowerCase()}.`;
  if (err === "format") return `${label}: ${rule.type === "numeric" ? "sólo números" : "sólo letras y números"}.`;
  return `${label}: ${lengthHint(rule).toLowerCase()}.`;
}

export type VoucherValues = Partial<Record<VoucherFieldKey, string>>;

/** Errores de todos los datos pedidos (vacío = se puede registrar). */
export function voucherErrors(eff: EffectiveRules, values: VoucherValues): Partial<Record<VoucherFieldKey, FieldError>> {
  const out: Partial<Record<VoucherFieldKey, FieldError>> = {};
  for (const f of VOUCHER_FIELDS) {
    const e = valueError(eff[f], values[f]);
    if (e) out[f] = e;
  }
  return out;
}

/**
 * ¿Pasar solo al dato siguiente? Cuando el largo es exacto y se completó, o
 * cuando se llegó al máximo. Con largo variable no se salta (el cajero sigue
 * tipeando o pasa con Enter).
 */
export function shouldAutoAdvance(rule: VoucherFieldRule, value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length >= rule.max && valueError(rule, v) === null;
}

/** Siguiente dato pedido (null = era el último). */
export function nextField(asked: VoucherFieldKey[], current: VoucherFieldKey): VoucherFieldKey | null {
  const i = asked.indexOf(current);
  return i >= 0 && i < asked.length - 1 ? asked[i + 1]! : null;
}

// ── Configuración: lectura y validación de la forma ──────────────────────────

/** Normaliza lo que venga de la base (descarta claves desconocidas). */
export function parseRules(raw: unknown): CardVoucherRules {
  const r = obj(raw);
  const out: CardVoucherRules = {};
  if (Array.isArray(r.acquirers)) out.acquirers = r.acquirers.filter(isAcquirerKey);
  const fields = parsePatch(r.fields);
  if (Object.keys(fields).length > 0) out.fields = fields;
  const by: Partial<Record<AcquirerKey, FieldRulesPatch>> = {};
  for (const [k, v] of Object.entries(obj(r.by_acquirer))) {
    if (!isAcquirerKey(k)) continue;
    const p = parsePatch(v);
    if (Object.keys(p).length > 0) by[k] = p;
  }
  if (Object.keys(by).length > 0) out.by_acquirer = by;
  return out;
}

function parsePatch(raw: unknown): FieldRulesPatch {
  const out: FieldRulesPatch = {};
  for (const [k, v] of Object.entries(obj(raw))) {
    if (!(VOUCHER_FIELDS as readonly string[]).includes(k)) continue;
    const p = obj(v);
    const rule: Partial<VoucherFieldRule> = {};
    if (typeof p.ask === "boolean") rule.ask = p.ask;
    if (typeof p.required === "boolean") rule.required = p.required;
    if (p.type === "numeric" || p.type === "alnum") rule.type = p.type;
    if (p.min !== undefined) rule.min = clampLen(p.min, 1);
    if (p.max !== undefined) rule.max = clampLen(p.max, MAX_LEN);
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) rule.max = rule.min;
    if (Object.keys(rule).length > 0) out[k as VoucherFieldKey] = rule;
  }
  return out;
}

/**
 * Código de error de la forma (espejo de `card_voucher_rules_error` en SQL).
 * null = válida.
 */
export function rulesShapeError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid_type";
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["acquirers", "fields", "by_acquirer"].includes(k)) return "invalid_key";
  if (r.acquirers !== undefined) {
    if (!Array.isArray(r.acquirers)) return "invalid_type";
    if (!r.acquirers.every((a) => typeof a === "string" && (ACQUIRER_KEYS as string[]).includes(a))) {
      return "invalid_acquirer";
    }
  }
  const patchErr = (p: unknown): string | null => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return "invalid_type";
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (!(VOUCHER_FIELDS as readonly string[]).includes(k)) return "invalid_key";
      if (!v || typeof v !== "object" || Array.isArray(v)) return "invalid_type";
      for (const [rk, rv] of Object.entries(v as Record<string, unknown>)) {
        if (rk === "ask" || rk === "required") {
          if (typeof rv !== "boolean") return "invalid_type";
        } else if (rk === "type") {
          if (rv !== "numeric" && rv !== "alnum") return "invalid_type";
        } else if (rk === "min" || rk === "max") {
          if (typeof rv !== "number" || !Number.isInteger(rv) || rv < 1 || rv > MAX_LEN) return "out_of_range";
        } else return "invalid_key";
      }
      const rule = v as { min?: number; max?: number };
      if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) return "out_of_range";
    }
    return null;
  };
  if (r.fields !== undefined) {
    const e = patchErr(r.fields);
    if (e) return e;
  }
  if (r.by_acquirer !== undefined) {
    if (!r.by_acquirer || typeof r.by_acquirer !== "object" || Array.isArray(r.by_acquirer)) return "invalid_type";
    for (const [k, v] of Object.entries(r.by_acquirer as Record<string, unknown>)) {
      if (!isAcquirerKey(k)) return "invalid_acquirer";
      const e = patchErr(v);
      if (e) return e;
    }
  }
  return null;
}

/** Regla completa -> parche mínimo (sólo lo que difiere de `base`). */
export function diffRule(base: VoucherFieldRule, rule: VoucherFieldRule): Partial<VoucherFieldRule> {
  const out: Partial<VoucherFieldRule> = {};
  (Object.keys(rule) as (keyof VoucherFieldRule)[]).forEach((k) => {
    if (rule[k] !== base[k]) (out as Record<string, unknown>)[k] = rule[k];
  });
  return out;
}

// ── Edición (pantalla de configuración) ──────────────────────────────────────

/** Regla de un dato tal como la configuró el negocio (sin require_card_voucher). */
export function configuredRule(rules: CardVoucherRules, acquirer: AcquirerKey | null, field: VoucherFieldKey): VoucherFieldRule {
  return fieldRule(rules, false, acquirer, field);
}

/** ¿El adquirente pisa este dato? */
export function hasAcquirerOverride(rules: CardVoucherRules, acquirer: AcquirerKey, field: VoucherFieldKey): boolean {
  return Boolean(rules.by_acquirer?.[acquirer]?.[field]);
}

/**
 * Guarda la regla de un dato: en las generales (parche contra la base de
 * siempre) o como excepción del adquirente (parche contra la general). Lo que
 * queda igual a su base no se guarda.
 */
export function setFieldRule(
  rules: CardVoucherRules,
  acquirer: AcquirerKey | null,
  field: VoucherFieldKey,
  rule: VoucherFieldRule,
): CardVoucherRules {
  const next: CardVoucherRules = {
    ...rules,
    fields: { ...(rules.fields ?? {}) },
    by_acquirer: { ...(rules.by_acquirer ?? {}) },
  };
  if (!acquirer) {
    const patch = diffRule(LEGACY_RULES[field], rule);
    if (Object.keys(patch).length > 0) next.fields![field] = patch;
    else delete next.fields![field];
  } else {
    const general = configuredRule(rules, null, field);
    const own = { ...(next.by_acquirer![acquirer] ?? {}) };
    const patch = diffRule(general, rule);
    if (Object.keys(patch).length > 0) own[field] = patch;
    else delete own[field];
    if (Object.keys(own).length > 0) next.by_acquirer![acquirer] = own;
    else delete next.by_acquirer![acquirer];
  }
  return compactRules(next);
}

/** El adquirente vuelve a usar la regla general del dato. */
export function clearAcquirerField(rules: CardVoucherRules, acquirer: AcquirerKey, field: VoucherFieldKey): CardVoucherRules {
  const own = { ...(rules.by_acquirer?.[acquirer] ?? {}) };
  delete own[field];
  const by = { ...(rules.by_acquirer ?? {}) };
  if (Object.keys(own).length > 0) by[acquirer] = own;
  else delete by[acquirer];
  return compactRules({ ...rules, by_acquirer: by });
}

/** Aplica los valores sugeridos del adquirente (reemplaza sus excepciones). */
export function applyPreset(rules: CardVoucherRules, acquirer: Exclude<AcquirerKey, "other">): CardVoucherRules {
  return compactRules({
    ...rules,
    by_acquirer: { ...(rules.by_acquirer ?? {}), [acquirer]: structuredClone(ACQUIRER_PRESETS[acquirer]) },
  });
}

/** Saca las claves vacías (así se guarda lo mínimo). */
export function compactRules(rules: CardVoucherRules): CardVoucherRules {
  const out: CardVoucherRules = {};
  if (rules.acquirers && rules.acquirers.length > 0) out.acquirers = [...rules.acquirers];
  if (rules.fields && Object.keys(rules.fields).length > 0) out.fields = rules.fields;
  if (rules.by_acquirer && Object.keys(rules.by_acquirer).length > 0) out.by_acquirer = rules.by_acquirer;
  return out;
}

/** Resumen corto de una regla para la tabla de configuración. */
export function ruleSummary(rule: VoucherFieldRule): string {
  if (!rule.ask) return "No se pide";
  const kind = rule.type === "numeric" ? "Numérico" : "Alfanumérico";
  return `${rule.required ? "Obligatorio" : "Opcional"} · ${kind} · ${lengthHint(rule)}`;
}

/** Mensaje para el error del servidor (card_voucher_required: lote, ...). */
export function cardVoucherErrorTitle(msg: string): string {
  const m = /card_voucher_(required|invalid): (\w+)/.exec(msg);
  if (!m) return "Revisá los datos del cupón";
  if (m[2] === "adquirente") return "La terminal elegida no es válida";
  const label = (FIELD_LABEL as Record<string, string>)[m[2]!]?.toLowerCase() ?? "un dato";
  return m[1] === "required" ? `Falta cargar ${label} del cupón` : `${label} del cupón no tiene el formato pedido`.replace(/^\w/, (c) => c.toUpperCase());
}
