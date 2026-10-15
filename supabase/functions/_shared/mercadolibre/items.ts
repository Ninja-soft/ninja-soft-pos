// =============================================================================
// _shared/mercadolibre/items.ts (H87 · ADR-104). PURO.
//
// Publicaciones:
//   • attributeForm: el formulario dinámico desde GET /categories/{id}/attributes
//     (tags required, catalog_required, conditional_required, allow_variations,
//     variation_attribute, read_only, hidden, fixed).
//   • validatePublish: chequeos previos del POS (antes de /items/validate).
//   • buildItemBodies: cuerpos de POST /items para los dos modelos:
//       - User Products (vendedor con tag user_product_seller, el default
//         desde 2025): un ítem POR VARIANTE, con `family_name` (sin title) y
//         los atributos de la variante; ML los agrupa por familia.
//       - Clásico: un ítem con `variations[]` (máx. 100, mismo precio).
//     `condition` está deprecado: va el atributo ITEM_CONDITION. Canal
//     `channels: ["marketplace"]`.
//   • Atributos condicionales: los tags `new_hidden`, `used_hidden` y
//     `refurbished_hidden` dicen para qué condición NO aplica un atributo
//     (GRADING sólo va en reacondicionados). No se muestran ni se mandan.
//     Si igual ML responde `delete.item.attribute.*`, `attributesToDelete`
//     lee cuáles y `stripAttributes` los saca para reintentar.
//   • filterCategorySuggestions: saca las categorías de prueba del predictor.
//   • itemIdentifiers / suggestLinks: vincular publicaciones existentes con
//     productos del POS por SELLER_SKU (el único SKU que ML considera) y, si
//     no, por GTIN (EAN).
// =============================================================================
import type { MlAttributeValue, MlCategoryAttribute, MlItem } from "./types.ts";
import { shippingBody, validateShipping, type ShippingInput } from "./shipping.ts";

export interface AttrField {
  id: string;
  name: string;
  valueType: string;
  required: boolean;
  conditional: boolean;
  catalogRequired: boolean;
  allowVariations: boolean;
  variationAttribute: boolean;
  options: Array<{ id: string; name: string }>;
  units: Array<{ id: string; name: string }>;
  defaultUnit: string | null;
  maxLength: number | null;
  hint: string | null;
  /** Condiciones en las que el atributo no aplica (tags new_hidden, used_hidden, refurbished_hidden). */
  hiddenFor?: ItemCondition[];
}

export type ItemCondition = "new" | "used" | "refurbished";

/** Atributos que completa el POS solo (no se piden en el formulario). */
export const AUTO_ATTRS = new Set(["SELLER_SKU", "GTIN", "ITEM_CONDITION", "EMPTY_GTIN_REASON"]);

export function attributeForm(attrs: MlCategoryAttribute[]): AttrField[] {
  const out: AttrField[] = [];
  for (const a of attrs ?? []) {
    const t = a.tags ?? {};
    if (t.read_only || t.hidden || t.fixed || t.others) continue;
    const hiddenFor: ItemCondition[] = [];
    if (t.new_hidden) hiddenFor.push("new");
    if (t.used_hidden) hiddenFor.push("used");
    if (t.refurbished_hidden) hiddenFor.push("refurbished");
    out.push({
      id: a.id,
      name: a.name,
      valueType: a.value_type,
      required: Boolean(t.required),
      conditional: Boolean(t.conditional_required),
      catalogRequired: Boolean(t.catalog_required),
      allowVariations: Boolean(t.allow_variations),
      variationAttribute: Boolean(t.variation_attribute),
      options: (a.values ?? []).slice(0, 500).map((v) => ({ id: v.id, name: v.name })),
      units: (a.allowed_units ?? []).map((u) => ({ id: u.id, name: u.name })),
      defaultUnit: a.default_unit ?? null,
      maxLength: typeof a.value_max_length === "number" ? a.value_max_length : null,
      hint: a.hint ?? a.tooltip ?? null,
      hiddenFor,
    });
  }
  const rank = (f: AttrField) => (f.required ? 0 : f.catalogRequired ? 1 : f.conditional ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y));
}

/** ¿El atributo aplica a esta condición? (GRADING no aplica a "Nuevo" ni a "Usado"). */
export function appliesToCondition(f: Pick<AttrField, "hiddenFor">, condition: ItemCondition): boolean {
  return !(f.hiddenFor ?? []).includes(condition);
}

/** Campos del formulario que aplican a la condición elegida. */
export function fieldsForCondition(fields: AttrField[], condition: ItemCondition): AttrField[] {
  return fields.filter((f) => appliesToCondition(f, condition));
}

/**
 * Deja sólo los atributos que se pueden mandar: los que la categoría muestra
 * (no hidden ni read_only), que aplican a la condición y que no se pidió
 * borrar. SELLER_SKU, GTIN, etc. los arma el POS aparte.
 */
export function sanitizeAttributes(
  values: Record<string, AttrInput>,
  fields: AttrField[],
  condition: ItemCondition,
  drop: Iterable<string> = [],
): Record<string, AttrInput> {
  const allowed = new Map(fields.map((f) => [f.id, f]));
  const dropped = new Set(drop);
  const out: Record<string, AttrInput> = {};
  for (const [id, v] of Object.entries(values ?? {})) {
    const f = allowed.get(id);
    if (!f || dropped.has(id) || !appliesToCondition(f, condition)) continue;
    out[id] = v;
  }
  return out;
}

/**
 * Atributos que ML pide sacar: causas `delete.item.attribute.*` con el id
 * entre corchetes ("Attribute [GRADING] to be deleted").
 */
export function attributesToDelete(causes: string[]): string[] {
  const out = new Set<string>();
  for (const c of causes ?? []) {
    if (!/delete\.item\.attribute/i.test(c)) continue;
    for (const m of c.matchAll(/\[([A-Z0-9_,\s]+)\]/g)) {
      for (const id of m[1]!.split(",")) if (/^[A-Z0-9_]+$/.test(id.trim())) out.add(id.trim());
    }
  }
  return [...out];
}

/** Saca atributos de los cuerpos ya armados (ítem y variaciones). */
export function stripAttributes(bodies: ItemBody[], ids: string[]): ItemBody[] {
  if (ids.length === 0) return bodies;
  const drop = new Set(ids);
  const clean = (list: unknown) =>
    Array.isArray(list) ? list.filter((a: { id?: string } | null) => !drop.has(String(a?.id ?? ""))) : list;
  return bodies.map((it) => {
    const body: Record<string, unknown> = { ...it.body, attributes: clean(it.body.attributes) };
    if (Array.isArray(it.body.variations)) {
      body.variations = (it.body.variations as Array<Record<string, unknown>>).map((v) => ({
        ...v,
        attributes: clean(v.attributes),
      }));
    }
    return { variantKey: it.variantKey, body };
  });
}

/** Sugerencia del predictor que es una categoría de prueba de ML ("All in One Test"). */
export function isTestCategory(s: { category_name?: string | null; domain_name?: string | null; domain_id?: string | null }): boolean {
  const re = /(^|[\s_-])tests?([\s_-]|$)/i;
  return re.test(s.category_name ?? "") || re.test(s.domain_name ?? "") || re.test(s.domain_id ?? "");
}

/** Predictor sin categorías de prueba, sin repetidas y con un tope. La primera es la sugerida. */
export function filterCategorySuggestions<
  T extends { category_id: string; category_name?: string | null; domain_name?: string | null; domain_id?: string | null },
>(list: T[] | null | undefined, max = 3): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of list ?? []) {
    if (!s?.category_id || seen.has(s.category_id) || isTestCategory(s)) continue;
    seen.add(s.category_id);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export interface AttrInput {
  value_id?: string | null;
  value_name?: string | null;
}

export interface PublishVariant {
  /** id de la variante del POS. */
  key: string;
  /** Atributos de variación (COLOR, SIZE...). */
  combos: Array<{ id: string; value_name: string; value_id?: string | null }>;
  price: number;
  quantity: number;
  sku: string | null;
  gtin: string | null;
  pictures?: string[];
}

export interface PublishInput {
  model: "user_products" | "classic";
  title: string;
  categoryId: string;
  listingTypeId: string;
  price: number;
  quantity: number;
  currency?: string;
  condition: "new" | "used";
  pictures: string[];
  description?: string | null;
  attributes: Record<string, AttrInput>;
  sku: string | null;
  gtin: string | null;
  emptyGtinReason?: string | null;
  freeShipping?: boolean;
  /** Envío elegido (ver shipping.ts). Sin esto se usa Mercado Envíos (me2). */
  shipping?: ShippingInput | null;
  warranty?: { type: string; time: string } | null;
  variants?: PublishVariant[];
  maxTitleLength?: number;
  /**
   * Producto del catálogo de ML que coincide por GTIN. Sólo sirve para
   * precompletar y avisar: el POS publica siempre como publicación propia
   * (nunca manda `catalog_listing`), que no exige Mercado Envíos.
   */
  catalogProductId?: string | null;
}

export interface ItemBody {
  /** Variante del POS (null = producto sin variantes o ítem clásico con variaciones). */
  variantKey: string | null;
  body: Record<string, unknown>;
}

const CONDITION_NAME = { new: "Nuevo", used: "Usado" } as const;
const CONDITION_ID = { new: "2230284", used: "2230581" } as const;

function attrList(values: Record<string, AttrInput>): MlAttributeValue[] {
  const out: MlAttributeValue[] = [];
  for (const [id, v] of Object.entries(values)) {
    if (AUTO_ATTRS.has(id)) continue;
    const name = (v.value_name ?? "").trim();
    const vid = (v.value_id ?? "").trim();
    if (!name && !vid) continue;
    out.push(vid ? { id, value_id: vid, value_name: name || null } : { id, value_name: name });
  }
  return out;
}

function identity(
  sku: string | null,
  gtin: string | null,
  emptyGtinReason: string | null | undefined,
  gtinApplies = true,
): MlAttributeValue[] {
  const out: MlAttributeValue[] = [];
  if (sku) out.push({ id: "SELLER_SKU", value_name: sku });
  if (!gtinApplies) return out;
  if (gtin) out.push({ id: "GTIN", value_name: gtin });
  else if (emptyGtinReason) out.push({ id: "EMPTY_GTIN_REASON", value_id: emptyGtinReason });
  return out;
}

export function validatePublish(input: PublishInput, fields: AttrField[]): string[] {
  const errs: string[] = [];
  const maxTitle = input.maxTitleLength ?? 60;
  const title = input.title.trim();
  if (title.length < 3) errs.push("El título es muy corto.");
  if (title.length > maxTitle) errs.push(`El título supera los ${maxTitle} caracteres de la categoría.`);
  if (/\b(stock|oferta|envio gratis|envío gratis|cuotas)\b/i.test(title)) errs.push("El título no puede mencionar stock, ofertas, envío ni cuotas.");
  if (!input.categoryId) errs.push("Falta la categoría.");
  if (!input.listingTypeId) errs.push("Falta el tipo de publicación.");
  if (input.pictures.length === 0) errs.push("Agregá al menos una foto.");
  const vs = input.variants ?? [];
  if (vs.length === 0 && !(input.price > 0)) errs.push("El precio tiene que ser mayor a cero.");
  if (vs.some((v) => !(v.price > 0))) errs.push("Cada variante necesita precio mayor a cero.");
  if (input.model === "classic" && vs.length > 1 && new Set(vs.map((v) => v.price)).size > 1) {
    errs.push("En el modelo clásico todas las variantes tienen que tener el mismo precio.");
  }
  if (input.model === "classic" && vs.length > 100) errs.push("El modelo clásico admite hasta 100 variantes.");
  if (!input.gtin && !input.emptyGtinReason && vs.every((v) => !v.gtin)) {
    if (fields.some((f) => f.id === "GTIN" && (f.required || f.conditional) && appliesToCondition(f, input.condition))) {
      errs.push("La categoría pide código de barras (GTIN) o el motivo por el que no tiene.");
    }
  }
  for (const f of fields) {
    if (!f.required || AUTO_ATTRS.has(f.id) || !appliesToCondition(f, input.condition)) continue;
    if (f.variationAttribute && vs.length > 0) continue;
    const v = input.attributes[f.id];
    if (!v || (!(v.value_name ?? "").trim() && !(v.value_id ?? "").trim())) errs.push(`Falta el atributo obligatorio "${f.name}".`);
  }
  errs.push(...validateShipping(input.shipping));
  return errs;
}

/**
 * Cuerpos de POST /items. Con `fields` (atributos de la categoría) se sacan
 * los atributos que no aplican a la condición (GRADING en "Nuevo") y el GTIN
 * si la categoría lo oculta para esa condición.
 */
export function buildItemBodies(input: PublishInput, fields?: AttrField[]): ItemBody[] {
  const currency = input.currency ?? "ARS";
  const base: Record<string, unknown> = {
    category_id: input.categoryId,
    currency_id: currency,
    buying_mode: "buy_it_now",
    listing_type_id: input.listingTypeId,
    channels: ["marketplace"],
    shipping: shippingBody(input.shipping ?? { mode: "me2", freeShipping: Boolean(input.freeShipping) }),
  };
  const gtinField = fields?.find((f) => f.id === "GTIN");
  const gtinApplies = !gtinField || appliesToCondition(gtinField, input.condition);
  if (input.warranty) {
    base.sale_terms = [
      { id: "WARRANTY_TYPE", value_name: input.warranty.type },
      { id: "WARRANTY_TIME", value_name: input.warranty.time },
    ];
  }
  const condition: MlAttributeValue = {
    id: "ITEM_CONDITION",
    value_id: CONDITION_ID[input.condition],
    value_name: CONDITION_NAME[input.condition],
  };
  const common = attrList(fields ? sanitizeAttributes(input.attributes, fields, input.condition) : input.attributes);
  const pics = (urls: string[]) => urls.slice(0, 12).map((source) => ({ source }));
  const variants = input.variants ?? [];

  if (input.model === "user_products") {
    // Un ítem por variante (o uno solo), agrupados por family_name.
    const list = variants.length > 0 ? variants : [null];
    return list.map((v) => ({
      variantKey: v?.key ?? null,
      body: {
        ...base,
        family_name: input.title.trim(),
        price: v ? v.price : input.price,
        available_quantity: Math.max(0, Math.floor(v ? v.quantity : input.quantity)),
        pictures: pics(v?.pictures?.length ? v.pictures : input.pictures),
        attributes: [
          ...common,
          ...(v ? v.combos.map((c) => (c.value_id ? { id: c.id, value_id: c.value_id, value_name: c.value_name } : { id: c.id, value_name: c.value_name })) : []),
          ...identity(v ? v.sku : input.sku, v ? v.gtin : input.gtin, input.emptyGtinReason, gtinApplies),
          condition,
        ],
      },
    }));
  }

  const body: Record<string, unknown> = {
    ...base,
    title: input.title.trim(),
    pictures: pics(input.pictures),
    attributes: [...common, ...(variants.length > 0 ? [] : identity(input.sku, input.gtin, input.emptyGtinReason, gtinApplies)), condition],
  };
  if (variants.length > 0) {
    body.price = variants[0]!.price;
    body.variations = variants.map((v) => ({
      attribute_combinations: v.combos.map((c) => (c.value_id ? { id: c.id, value_id: c.value_id } : { id: c.id, value_name: c.value_name })),
      price: v.price,
      available_quantity: Math.max(0, Math.floor(v.quantity)),
      attributes: identity(v.sku, v.gtin, input.emptyGtinReason, gtinApplies),
    }));
  } else {
    body.price = input.price;
    body.available_quantity = Math.max(0, Math.floor(input.quantity));
  }
  return [{ variantKey: null, body }];
}

// -----------------------------------------------------------------------------
// Vincular publicaciones existentes.
// -----------------------------------------------------------------------------
export interface ItemIdentifier {
  variationId: string | null;
  sku: string | null;
  gtin: string | null;
  label: string;
}

const attr = (list: MlAttributeValue[] | undefined, id: string): string | null => {
  const v = (list ?? []).find((a) => a.id === id)?.value_name;
  return v && v.trim() ? v.trim() : null;
};

export function itemIdentifiers(item: Pick<MlItem, "title" | "attributes" | "variations">): ItemIdentifier[] {
  const vars = item.variations ?? [];
  if (vars.length === 0) {
    return [{ variationId: null, sku: attr(item.attributes, "SELLER_SKU"), gtin: attr(item.attributes, "GTIN"), label: item.title }];
  }
  return vars.map((v) => ({
    variationId: String(v.id),
    sku: attr(v.attributes, "SELLER_SKU") ?? (v.seller_custom_field?.trim() || null),
    gtin: attr(v.attributes, "GTIN"),
    label: [item.title, (v.attribute_combinations ?? []).map((c) => c.value_name).filter(Boolean).join(" / ")].filter(Boolean).join(" · "),
  }));
}

/** Datos de la publicación para "Vincular con un producto" (ADR-141). */
export interface LinkContext {
  pictures: string[];
  brand: string | null;
  model: string | null;
  gtins: string[];
  skus: string[];
  variations: Array<{ id: string; label: string; sku: string | null; gtin: string | null; picture: string | null }>;
}

/** El GTIN de ML puede venir con varios códigos separados por coma. */
export function splitGtins(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.replace(/\D/g, ""))
    .filter((s) => s.length >= 8 && s.length <= 14);
}

/** Fotos, marca, GTIN y SKU de una publicación y sus variaciones. PURO. */
export function linkContext(item: Pick<MlItem, "title" | "attributes" | "variations" | "pictures" | "secure_thumbnail" | "thumbnail">): LinkContext {
  const pics = (item.pictures ?? []).map((p) => p.secure_url || p.url || "").filter(Boolean);
  const picById = new Map((item.pictures ?? []).map((p) => [p.id, p.secure_url || p.url || ""]));
  const thumb = item.secure_thumbnail || item.thumbnail || null;
  const ids = itemIdentifiers(item);
  const variations = (item.variations ?? []).map((v, i) => ({
    id: String(v.id),
    label: (v.attribute_combinations ?? []).map((c) => c.value_name).filter(Boolean).join(" / ") || ids[i]?.label || String(v.id),
    sku: ids[i]?.sku ?? null,
    gtin: splitGtins(ids[i]?.gtin)[0] ?? null,
    picture: (v.picture_ids ?? []).map((id) => picById.get(id)).find(Boolean) ?? null,
  }));
  const gtins = [...new Set(ids.flatMap((x) => splitGtins(x.gtin)))];
  const skus = [...new Set(ids.map((x) => x.sku).filter((s): s is string => Boolean(s)))];
  return {
    pictures: (pics.length > 0 ? pics : thumb ? [thumb] : []).slice(0, 6),
    brand: attr(item.attributes, "BRAND"),
    model: attr(item.attributes, "MODEL"),
    gtins,
    skus,
    variations,
  };
}

export interface PosCandidate {
  product_id: string;
  variant_id: string | null;
  sku: string | null;
  barcode: string | null;
}

export interface LinkSuggestion {
  variationId: string | null;
  product_id: string;
  variant_id: string | null;
  by: "sku" | "gtin";
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** Sugerencias de vínculo: SKU exacto primero, después GTIN. Nunca dos a la misma variante. */
export function suggestLinks(ids: ItemIdentifier[], candidates: PosCandidate[]): LinkSuggestion[] {
  const out: LinkSuggestion[] = [];
  const used = new Set<string>();
  const key = (c: PosCandidate) => `${c.product_id}:${c.variant_id ?? ""}`;
  for (const id of ids) {
    let hit: PosCandidate | undefined;
    let by: "sku" | "gtin" = "sku";
    if (id.sku) hit = candidates.find((c) => norm(c.sku) === norm(id.sku) && !used.has(key(c)));
    if (!hit && id.gtin) {
      hit = candidates.find((c) => norm(c.barcode) === norm(id.gtin) && !used.has(key(c)));
      by = "gtin";
    }
    if (hit) {
      used.add(key(hit));
      out.push({ variationId: id.variationId, product_id: hit.product_id, variant_id: hit.variant_id, by });
    }
  }
  return out;
}

/**
 * Causas de un 400 de /items/validate separadas en errores y avisos (ML
 * mezcla `type: "warning"` con los errores). Formato "codigo: mensaje".
 */
export function validationCauses(body: unknown, fallback: string[] = []): { errors: string[]; warnings: string[] } {
  const list = (body as { cause?: unknown } | null)?.cause;
  if (!Array.isArray(list) || list.length === 0) return { errors: fallback, warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const c of list) {
    if (typeof c === "string") {
      errors.push(c);
      continue;
    }
    const o = (c ?? {}) as { code?: string; message?: string; type?: string };
    const text = [o.code, o.message].filter(Boolean).join(": ");
    if (!text) continue;
    if (String(o.type ?? "").toLowerCase() === "warning") warnings.push(text);
    else errors.push(text);
  }
  // /items/validate responde 400 aunque sólo haya avisos (leído el 15/10/2026
  // con la cuenta real: un vino con todo bien da 400 con un único
  // `shipping.lost_me1_by_user` de tipo warning). Los avisos no frenan la
  // publicación; sólo un 400 sin ninguna causa usa el fallback como error.
  if (errors.length === 0 && warnings.length === 0) return { errors: fallback, warnings: [] };
  return { errors, warnings };
}

const FORBIDDEN_TITLE = /\b(stock|oferta|ofertas|envio gratis|envío gratis|cuotas)\b/gi;

/**
 * Título que ML acepta: sin palabras prohibidas y cortado en una palabra al
 * largo de la categoría. `changed` dice si hubo que tocarlo.
 */
export function fitTitle(title: string, max = 60): { title: string; changed: boolean } {
  const orig = (title ?? "").replace(/\s+/g, " ").trim();
  let t = orig.replace(FORBIDDEN_TITLE, "").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    // Si el corte cae justo al final de una palabra, la palabra entra entera.
    const sp = t[max] === " " ? max : cut.lastIndexOf(" ");
    t = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:\-/]+$/, "").trim();
  }
  return { title: t, changed: t !== orig };
}

/** ¿Tiene la automatización de precios de ML activa? (tag del ítem). */
export function hasPriceAutomation(item: Pick<MlItem, "tags">): boolean {
  return (item.tags ?? []).some((t) => t === "price_automation" || t === "automatic_relist_price" || t.startsWith("price_automation"));
}
