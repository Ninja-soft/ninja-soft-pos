// =============================================================================
// _shared/mercadolibre/quick.ts (H141 · ADR-132). PURO.
//
// Publicación rápida en lote: precompletar atributos desde la ficha del
// producto, el producto de catálogo de ML (por GTIN), la sugerencia de
// dominio y lo recordado por categoría; detectar sólo los obligatorios que
// faltan; armar el PublishInput de cada fila. Lo importan la Edge ml_api
// (memoria por categoría) y la UI (grilla), y lo cubren los tests.
// =============================================================================
import { AUTO_ATTRS, type AttrField, type AttrInput, type PublishInput } from "./items.ts";

export type AttrValues = Record<string, AttrInput>;
export type AttrSource = "user" | "product" | "catalog" | "domain" | "memory";

export interface ExternalAttr {
  id: string;
  name?: string | null;
  value_id?: string | null;
  value_name?: string | null;
}

/** GTIN-8/12/13/14 con dígito verificador válido. */
export function isValidGtin(code: string | null | undefined): boolean {
  const s = (code ?? "").trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const digits = s.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i]! * w;
  return (10 - (sum % 10)) % 10 === check;
}

const hasValue = (v: AttrInput | undefined) => Boolean(v && ((v.value_id ?? "").trim() || (v.value_name ?? "").trim()));
const norm = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

/** Ajusta un valor al campo: con opciones, busca el value_id por id o por nombre. */
export function fitValue(field: AttrField, v: ExternalAttr | AttrInput): AttrInput | null {
  const id = (v.value_id ?? "").trim();
  const name = (v.value_name ?? "").trim();
  if (!id && !name) return null;
  if (field.options.length > 0 && field.valueType !== "number_unit") {
    const byId = id ? field.options.find((o) => o.id === id) : undefined;
    const opt = byId ?? field.options.find((o) => norm(o.name) === norm(name));
    if (opt) return { value_id: opt.id, value_name: opt.name };
    // Lista cerrada sin coincidencia: ML lo rechazaría (salvo que admita texto libre).
    return field.valueType === "list" ? null : name ? { value_name: name } : null;
  }
  if (field.maxLength && name.length > field.maxLength) return { value_name: name.slice(0, field.maxLength) };
  return name ? { value_name: name } : null;
}

export interface PrefillInput {
  fields: AttrField[];
  product: { brand: string | null; model: string | null };
  catalogAttrs?: ExternalAttr[];
  domainAttrs?: ExternalAttr[];
  memory?: AttrValues | null;
  /** Lo que ya cargó el usuario: siempre gana. */
  current?: AttrValues;
}

/**
 * Valores precompletados por atributo y de dónde salió cada uno. Prioridad:
 * usuario > ficha del producto (marca y modelo) > catálogo de ML > dominio
 * sugerido > memoria de la categoría. Sólo atributos de la categoría y nunca
 * los que completa el POS solo (SKU, GTIN, condición).
 */
export function prefillAttributes(input: PrefillInput): { values: AttrValues; sources: Record<string, AttrSource> } {
  const values: AttrValues = {};
  const sources: Record<string, AttrSource> = {};
  const byId = new Map(input.fields.map((f) => [f.id, f]));
  const put = (id: string, v: ExternalAttr | AttrInput | null | undefined, src: AttrSource) => {
    if (!v || AUTO_ATTRS.has(id) || hasValue(values[id])) return;
    const f = byId.get(id);
    if (!f) return;
    const fitted = fitValue(f, v);
    if (fitted) {
      values[id] = fitted;
      sources[id] = src;
    }
  };
  for (const [id, v] of Object.entries(input.current ?? {})) put(id, v, "user");
  if (input.product.brand) put("BRAND", { value_name: input.product.brand }, "product");
  if (input.product.model) put("MODEL", { value_name: input.product.model }, "product");
  for (const a of input.catalogAttrs ?? []) put(a.id, a, "catalog");
  for (const a of input.domainAttrs ?? []) put(a.id, a, "domain");
  for (const [id, v] of Object.entries(input.memory ?? {})) put(id, v, "memory");
  return { values, sources };
}

/** Obligatorios que faltan (los de variación no cuentan si hay variantes). */
export function missingRequired(fields: AttrField[], values: AttrValues, opts: { hasVariants?: boolean } = {}): AttrField[] {
  return fields.filter(
    (f) => f.required && !AUTO_ATTRS.has(f.id) && !(opts.hasVariants && f.variationAttribute) && !hasValue(values[f.id]),
  );
}

/** Atributos que conviene recordar por categoría (no los propios del producto). */
const NOT_REMEMBERED = new Set(["MODEL", "MANUAL_TITLE", "LINE", "ALPHANUMERIC_MODEL", "PART_NUMBER"]);
export function memoryAttrs(values: AttrValues): AttrValues {
  const out: AttrValues = {};
  for (const [id, v] of Object.entries(values ?? {})) {
    if (AUTO_ATTRS.has(id) || NOT_REMEMBERED.has(id) || !hasValue(v)) continue;
    if (!/^[A-Z0-9_]{2,60}$/.test(id)) continue;
    out[id] = { value_id: v.value_id ?? null, value_name: (v.value_name ?? "").slice(0, 255) || null };
  }
  return out;
}

const FORBIDDEN = /\b(stock|oferta|envio gratis|envío gratis|cuotas)\b/gi;

/** Título sugerido: nombre (+ marca si no la tiene), sin palabras prohibidas, al largo de la categoría. */
export function quickTitle(name: string, brand: string | null, max = 60): string {
  let t = (name ?? "").replace(FORBIDDEN, "").replace(/\s{2,}/g, " ").trim();
  if (brand && !norm(t).includes(norm(brand))) t = `${t} ${brand}`.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

export interface QuickRow {
  title: string;
  categoryId: string;
  maxTitleLength: number;
  attrs: AttrValues;
  condition: "new" | "used";
  gtin: string | null;
  emptyGtinReason: string | null;
  freeShipping: boolean;
}

export interface QuickProduct {
  product_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  pictures: string[];
  qty: number | null;
  warranty_months: number | null;
}

/**
 * PublishInput de una fila. El precio va como referencia (el del primer tipo):
 * al publicar en varios tipos, la Edge calcula cada precio en el servidor.
 */
export function buildQuickInput(p: QuickProduct, row: QuickRow, listingTypeId: string, price: number, model: PublishInput["model"]): PublishInput {
  const gtin = (row.gtin ?? "").trim() || null;
  return {
    model,
    title: row.title.trim(),
    categoryId: row.categoryId,
    listingTypeId,
    price,
    quantity: Math.max(0, Math.floor(p.qty ?? 0)),
    currency: "ARS",
    condition: row.condition,
    pictures: p.pictures,
    description: p.description,
    attributes: row.attrs,
    sku: p.sku,
    gtin,
    emptyGtinReason: gtin ? null : row.emptyGtinReason,
    freeShipping: row.freeShipping,
    warranty: p.warranty_months && p.warranty_months > 0 ? { type: "Garantía del vendedor", time: `${p.warranty_months} meses` } : null,
    maxTitleLength: row.maxTitleLength,
  };
}

export type QuickRowState = "loading" | "needs_input" | "ready" | "validating" | "valid" | "publishing" | "published" | "partial" | "error";

/** Estado local de la fila antes de ir a ML. */
export function localRowState(p: QuickProduct, row: QuickRow | null, fields: AttrField[] | null): { state: QuickRowState; problems: string[] } {
  if (!row || !fields) return { state: "loading", problems: [] };
  const problems: string[] = [];
  if (!row.categoryId) problems.push("Elegí la categoría.");
  if (row.title.trim().length < 3) problems.push("El título es muy corto.");
  if (row.title.trim().length > row.maxTitleLength) problems.push(`El título supera ${row.maxTitleLength} caracteres.`);
  if (p.pictures.length === 0) problems.push("Falta una foto en la ficha del producto.");
  if (!(row.gtin ?? "").trim() && !row.emptyGtinReason) problems.push("Falta el código de barras o el motivo.");
  for (const f of missingRequired(fields, row.attrs)) problems.push(`Falta ${f.name}.`);
  return { state: problems.length ? "needs_input" : "ready", problems };
}
