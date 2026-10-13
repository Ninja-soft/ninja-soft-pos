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
//   • itemIdentifiers / suggestLinks: vincular publicaciones existentes con
//     productos del POS por SELLER_SKU (el único SKU que ML considera) y, si
//     no, por GTIN (EAN).
// =============================================================================
import type { MlAttributeValue, MlCategoryAttribute, MlItem } from "./types.ts";

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
}

/** Atributos que completa el POS solo (no se piden en el formulario). */
export const AUTO_ATTRS = new Set(["SELLER_SKU", "GTIN", "ITEM_CONDITION", "EMPTY_GTIN_REASON"]);

export function attributeForm(attrs: MlCategoryAttribute[]): AttrField[] {
  const out: AttrField[] = [];
  for (const a of attrs ?? []) {
    const t = a.tags ?? {};
    if (t.read_only || t.hidden || t.fixed || t.others) continue;
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
    });
  }
  const rank = (f: AttrField) => (f.required ? 0 : f.catalogRequired ? 1 : f.conditional ? 2 : 3);
  return out.sort((x, y) => rank(x) - rank(y));
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
  warranty?: { type: string; time: string } | null;
  variants?: PublishVariant[];
  maxTitleLength?: number;
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

function identity(sku: string | null, gtin: string | null, emptyGtinReason: string | null | undefined): MlAttributeValue[] {
  const out: MlAttributeValue[] = [];
  if (sku) out.push({ id: "SELLER_SKU", value_name: sku });
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
    if (fields.some((f) => f.id === "GTIN" && (f.required || f.conditional))) {
      errs.push("La categoría pide código de barras (GTIN) o el motivo por el que no tiene.");
    }
  }
  for (const f of fields) {
    if (!f.required || AUTO_ATTRS.has(f.id)) continue;
    if (f.variationAttribute && vs.length > 0) continue;
    const v = input.attributes[f.id];
    if (!v || (!(v.value_name ?? "").trim() && !(v.value_id ?? "").trim())) errs.push(`Falta el atributo obligatorio "${f.name}".`);
  }
  return errs;
}

export function buildItemBodies(input: PublishInput): ItemBody[] {
  const currency = input.currency ?? "ARS";
  const base: Record<string, unknown> = {
    category_id: input.categoryId,
    currency_id: currency,
    buying_mode: "buy_it_now",
    listing_type_id: input.listingTypeId,
    channels: ["marketplace"],
    shipping: { mode: "me2", local_pick_up: false, free_shipping: Boolean(input.freeShipping) },
  };
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
  const common = attrList(input.attributes);
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
          ...identity(v ? v.sku : input.sku, v ? v.gtin : input.gtin, input.emptyGtinReason),
          condition,
        ],
      },
    }));
  }

  const body: Record<string, unknown> = {
    ...base,
    title: input.title.trim(),
    pictures: pics(input.pictures),
    attributes: [...common, ...(variants.length > 0 ? [] : identity(input.sku, input.gtin, input.emptyGtinReason)), condition],
  };
  if (variants.length > 0) {
    body.price = variants[0]!.price;
    body.variations = variants.map((v) => ({
      attribute_combinations: v.combos.map((c) => (c.value_id ? { id: c.id, value_id: c.value_id } : { id: c.id, value_name: c.value_name })),
      price: v.price,
      available_quantity: Math.max(0, Math.floor(v.quantity)),
      attributes: identity(v.sku, v.gtin, input.emptyGtinReason),
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

/** ¿Tiene la automatización de precios de ML activa? (tag del ítem). */
export function hasPriceAutomation(item: Pick<MlItem, "tags">): boolean {
  return (item.tags ?? []).some((t) => t === "price_automation" || t === "automatic_relist_price" || t.startsWith("price_automation"));
}
