// @vitest-environment node
// =============================================================================
// Gestor de Mercado Libre, parte A (H141 · ADR-132): reglas de precio por
// tipo de publicación (espejo de _ml_listing_price), stock publicable,
// recargo sugerido por comisión, publicación rápida (GTIN, precompletado,
// faltantes, memoria) y publicar en varios tipos con precios del servidor.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  listingPrice,
  publishableQty,
  roundUp,
  suggestedMarkup,
  type ListingOverride,
  type ListingRule,
} from "@/lib/mercadolibre/pricing";
import {
  buildQuickInput,
  fitValue,
  isValidGtin,
  localRowState,
  memoryAttrs,
  missingRequired,
  prefillAttributes,
  quickTitle,
  type QuickRow,
} from "@/supabase/functions/_shared/mercadolibre/quick";
import { catalogMatch, feesByType, inputForListing, pickListingTypes, type ListingPriceRow } from "@/supabase/functions/_shared/mercadolibre/listing";
import type { AttrField, PublishInput } from "@/supabase/functions/_shared/mercadolibre/items";
import { GESTOR_SECTIONS, setupSteps, showSetup } from "@/lib/mercadolibre/gestor";

const rule = (p: Partial<ListingRule> = {}): ListingRule => ({
  listing_type_id: "gold_pro",
  enabled: true,
  mode: "markup",
  markup_pct: 0,
  price_list_id: null,
  rounding: 0,
  min_price: 0,
  default_on: false,
  ...p,
});
const ov = (p: Partial<ListingOverride>): ListingOverride => ({
  listing_type_id: "gold_pro",
  mode: "inherit",
  markup_pct: null,
  price_list_id: null,
  fixed_price: null,
  min_price: null,
  ...p,
});
const lists: Record<string, number> = { L1: 8000, L2: 12345 };
const price = (base: number | null, r: ListingRule | null, o: ListingOverride | null = null, accountRounding = 0) =>
  listingPrice({ basePrice: base, listPrice: (id) => lists[id] ?? null, accountRounding, rule: r, override: o });

describe("listingPrice (espejo de _ml_listing_price)", () => {
  it("sin regla ni override es el precio base de la cuenta", () => {
    expect(price(10000, null)).toBe(10000);
  });
  it("recargo de la regla y redondeo hacia arriba", () => {
    expect(price(10000, rule({ markup_pct: 15 }))).toBe(11500);
    expect(price(10000, rule({ markup_pct: 13, rounding: 100 }))).toBe(11300);
    expect(price(9990, rule({ markup_pct: 13, rounding: 100 }))).toBe(11300); // 11288,7 -> 11300
    expect(price(9990, rule({ markup_pct: 13 }), null, 50)).toBe(11300); // usa el redondeo de la cuenta
  });
  it("sin recargo no vuelve a redondear (la base ya viene redondeada)", () => {
    expect(price(10001, rule({ rounding: 100 }))).toBe(10001);
  });
  it("lista de precios de la regla (con recargo opcional) y redondeo", () => {
    expect(price(10000, rule({ mode: "price_list", price_list_id: "L1" }))).toBe(8000);
    expect(price(10000, rule({ mode: "price_list", price_list_id: "L2", rounding: 100 }))).toBe(12400);
    expect(price(10000, rule({ mode: "price_list", price_list_id: "L1", markup_pct: 10 }))).toBe(8800);
    expect(price(10000, rule({ mode: "price_list", price_list_id: "X" }))).toBeNull();
  });
  it("precio mínimo de la regla y del override", () => {
    expect(price(1000, rule({ markup_pct: 10, min_price: 5000 }))).toBe(5000);
    expect(price(1000, rule({ markup_pct: 10, min_price: 5000 }), ov({ mode: "inherit", min_price: 2000 }))).toBe(2000);
  });
  it("regla apagada = precio base", () => {
    expect(price(10000, rule({ markup_pct: 50, enabled: false }))).toBe(10000);
  });
  it("override: no publicar, fijo, recargo propio y lista propia", () => {
    expect(price(10000, rule({ markup_pct: 15 }), ov({ mode: "skip" }))).toBeNull();
    expect(price(10000, rule({ markup_pct: 15 }), ov({ mode: "fixed", fixed_price: 9999.5 }))).toBe(9999.5);
    expect(price(10000, rule({ markup_pct: 15, min_price: 20000 }), ov({ mode: "fixed", fixed_price: 9999 }))).toBe(20000);
    expect(price(10000, rule({ markup_pct: 15 }), ov({ mode: "markup", markup_pct: 5 }))).toBe(10500);
    expect(price(10000, rule({ markup_pct: 15 }), ov({ mode: "price_list", price_list_id: "L1" }))).toBe(8000);
    expect(price(10000, rule({ markup_pct: 15 }), ov({ mode: "price_list", price_list_id: "L1", markup_pct: 25 }))).toBe(10000);
  });
  it("sin precio base no hay precio", () => {
    expect(price(null, rule({ markup_pct: 10 }))).toBeNull();
  });
  it("recargo negativo y dos decimales", () => {
    expect(price(1000, rule({ markup_pct: -10 }))).toBe(900);
    expect(price(999.99, rule({ markup_pct: 3.33 }))).toBe(1033.29);
    // round(66499.335, 2) en Postgres es 66499.34 (en coma flotante da ...334999).
    expect(price(73888.15, rule({ markup_pct: -10 }))).toBe(66499.34);
  });
  it("roundUp tolera la coma flotante", () => {
    expect(roundUp(1000.0000000001, 100)).toBe(1000);
    expect(roundUp(1000.01, 100)).toBe(1100);
    expect(roundUp(55, 0)).toBe(55);
  });
  it("las reglas por defecto tildan Clásica y suman 15 % en Premium", () => {
    expect(DEFAULT_RULES.map((r) => [r.listing_type_id, r.default_on, r.markup_pct])).toEqual([
      ["gold_special", true, 0],
      ["gold_pro", false, 15],
    ]);
  });
});

describe("publishableQty (espejo de _ml_available_qty)", () => {
  it("reserva fija, porcentaje y tope", () => {
    expect(publishableQty(40, { reserve_qty: 2, reserve_pct: 10, max_qty: 20 })).toBe(20);
    expect(publishableQty(40, { reserve_qty: 2, reserve_pct: 10, max_qty: null })).toBe(34);
    expect(publishableQty(1, { reserve_qty: 2, reserve_pct: 0, max_qty: null })).toBe(0);
    expect(publishableQty(7.9, { reserve_qty: 0, reserve_pct: 50, max_qty: null })).toBe(3);
    expect(publishableQty(null, { reserve_qty: 0, reserve_pct: 0, max_qty: 5 })).toBeNull();
    expect(publishableQty(10, { reserve_qty: 0, reserve_pct: 0, max_qty: 0 })).toBe(0);
  });
});

describe("suggestedMarkup", () => {
  const classic = { listing_type_id: "gold_special", name: "Clásica", sale_fee_amount: 0, percentage_fee: 13.28, fixed_fee: 1330 };
  const premium = { listing_type_id: "gold_pro", name: "Premium", sale_fee_amount: 0, percentage_fee: 26.68, fixed_fee: 1330 };
  it("recargo para que Premium deje el mismo neto que Clásica", () => {
    const pct = suggestedMarkup(10000, classic, premium)!;
    const p = 10000 * (1 + pct / 100);
    const netPremium = p - (p * premium.percentage_fee) / 100 - premium.fixed_fee;
    const netClassic = 10000 - 1328 - 1330;
    expect(Math.abs(netPremium - netClassic)).toBeLessThan(60);
    expect(pct).toBeGreaterThan(15);
  });
  it("sin precio o con comisión imposible devuelve null", () => {
    expect(suggestedMarkup(0, classic, premium)).toBeNull();
    expect(suggestedMarkup(1000, classic, { ...premium, percentage_fee: 100 })).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Publicación rápida.
// -----------------------------------------------------------------------------
const f = (p: Partial<AttrField> & { id: string }): AttrField => ({
  name: p.id,
  valueType: "string",
  required: false,
  conditional: false,
  catalogRequired: false,
  allowVariations: false,
  variationAttribute: false,
  options: [],
  units: [],
  defaultUnit: null,
  maxLength: null,
  hint: null,
  ...p,
});
const FIELDS: AttrField[] = [
  f({ id: "BRAND", name: "Marca", required: true }),
  f({ id: "MODEL", name: "Modelo", required: true }),
  f({ id: "NET_WEIGHT", name: "Peso neto", valueType: "number_unit", required: true }),
  f({ id: "UNITS_PER_PACK", name: "Unidades", valueType: "number" }),
  f({ id: "FLAVOR", name: "Sabor", valueType: "list", options: [{ id: "1", name: "Original" }, { id: "2", name: "Limón" }], required: true }),
  f({ id: "GTIN", name: "Código", required: true }),
  f({ id: "COLOR", name: "Color", required: true, variationAttribute: true }),
];

describe("isValidGtin", () => {
  it("valida el dígito verificador de EAN-13, UPC-12, EAN-8 y GTIN-14", () => {
    expect(isValidGtin("7790895000997")).toBe(true);
    expect(isValidGtin("7790895000998")).toBe(false);
    expect(isValidGtin("036000291452")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("17790895000994")).toBe(true);
    expect(isValidGtin("123")).toBe(false);
    expect(isValidGtin("77908950009AB")).toBe(false);
    expect(isValidGtin(null)).toBe(false);
  });
});

describe("prefillAttributes", () => {
  it("prioridad usuario > ficha > catálogo > dominio > memoria, sólo atributos de la categoría", () => {
    const { values, sources } = prefillAttributes({
      fields: FIELDS,
      product: { brand: "Coca-Cola", model: null },
      catalogAttrs: [
        { id: "BRAND", value_id: "39", value_name: "Coca Cola Co" },
        { id: "MODEL", value_name: "Original 2,25" },
        { id: "FLAVOR", value_id: "1", value_name: "Original" },
        { id: "NO_EXISTE", value_name: "x" },
      ],
      domainAttrs: [{ id: "NET_WEIGHT", value_name: "2.25 L" }, { id: "MODEL", value_name: "otro" }],
      memory: { UNITS_PER_PACK: { value_name: "1" }, FLAVOR: { value_id: "2", value_name: "Limón" } },
      current: { NET_WEIGHT: { value_name: "2,25 L" } },
    });
    expect(values.BRAND).toEqual({ value_name: "Coca-Cola" });
    expect(sources.BRAND).toBe("product");
    expect(values.MODEL).toEqual({ value_name: "Original 2,25" });
    expect(sources.MODEL).toBe("catalog");
    expect(values.FLAVOR).toEqual({ value_id: "1", value_name: "Original" });
    expect(values.NET_WEIGHT).toEqual({ value_name: "2,25 L" });
    expect(sources.NET_WEIGHT).toBe("user");
    expect(values.UNITS_PER_PACK).toEqual({ value_name: "1" });
    expect(sources.UNITS_PER_PACK).toBe("memory");
    expect(values.NO_EXISTE).toBeUndefined();
    expect(values.GTIN).toBeUndefined(); // lo completa el POS
  });
  it("fitValue busca la opción por nombre sin tildes y descarta lo que no está en una lista cerrada", () => {
    const flavor = FIELDS.find((x) => x.id === "FLAVOR")!;
    expect(fitValue(flavor, { value_name: "LIMON" })).toEqual({ value_id: "2", value_name: "Limón" });
    expect(fitValue(flavor, { value_name: "Uva" })).toBeNull();
    expect(fitValue(f({ id: "X", maxLength: 3 }), { value_name: "abcdef" })).toEqual({ value_name: "abc" });
  });
  it("missingRequired ignora los automáticos y los de variación con variantes", () => {
    const miss = missingRequired(FIELDS, { BRAND: { value_name: "A" } });
    expect(miss.map((x) => x.id)).toEqual(["MODEL", "NET_WEIGHT", "FLAVOR", "COLOR"]);
    expect(missingRequired(FIELDS, { BRAND: { value_name: "A" } }, { hasVariants: true }).map((x) => x.id)).not.toContain("COLOR");
  });
  it("memoryAttrs no guarda lo propio del producto", () => {
    expect(
      memoryAttrs({ BRAND: { value_name: "A" }, MODEL: { value_name: "M" }, GTIN: { value_name: "1" }, FLAVOR: { value_id: "1", value_name: "Original" }, EMPTY: {} }),
    ).toEqual({ BRAND: { value_id: null, value_name: "A" }, FLAVOR: { value_id: "1", value_name: "Original" } });
  });
});

describe("quickTitle", () => {
  it("saca palabras prohibidas, suma la marca y corta en una palabra", () => {
    expect(quickTitle("Yerba Mate 1kg OFERTA", "Playadito")).toBe("Yerba Mate 1kg Playadito");
    expect(quickTitle("Coca-Cola Original 2,25 L", "coca-cola")).toBe("Coca-Cola Original 2,25 L");
    const t = quickTitle("Auriculares inalámbricos bluetooth con cancelación de ruido y estuche de carga rápida", null, 60);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith(" ")).toBe(false);
  });
});

describe("filas de la publicación rápida", () => {
  const product = { product_id: "p1", name: "Yerba", description: "desc", sku: "Y1", barcode: "7790895000997", pictures: ["https://x/1.jpg"], qty: 7.6, warranty_months: 6 };
  const row: QuickRow = {
    title: "Yerba Mate Playadito 1 kg",
    categoryId: "MLA409408",
    maxTitleLength: 60,
    attrs: { BRAND: { value_name: "Playadito" }, MODEL: { value_name: "Suave" }, NET_WEIGHT: { value_name: "1 kg" }, FLAVOR: { value_id: "1" }, COLOR: { value_name: "-" } },
    condition: "new",
    gtin: "7790895000997",
    emptyGtinReason: null,
    freeShipping: false,
  };
  it("lista cuando no falta nada; si no, dice qué falta", () => {
    expect(localRowState(product, row, FIELDS)).toEqual({ state: "ready", problems: [] });
    const r2 = localRowState({ ...product, pictures: [] }, { ...row, gtin: "", attrs: {} }, FIELDS);
    expect(r2.state).toBe("needs_input");
    expect(r2.problems).toEqual(
      expect.arrayContaining(["Falta una foto en la ficha del producto.", "Falta el código de barras o el motivo.", "Falta Marca."]),
    );
    expect(localRowState(product, null, null).state).toBe("loading");
  });
  it("buildQuickInput arma el PublishInput con garantía y sin motivo si hay GTIN", () => {
    const input = buildQuickInput(product, { ...row, emptyGtinReason: "17055160" }, "gold_special", 12000, "user_products");
    expect(input).toMatchObject({
      model: "user_products",
      listingTypeId: "gold_special",
      price: 12000,
      quantity: 7,
      gtin: "7790895000997",
      emptyGtinReason: null,
      warranty: { type: "Garantía del vendedor", time: "6 meses" },
      sku: "Y1",
    });
  });
});

// -----------------------------------------------------------------------------
// Varios tipos de publicación.
// -----------------------------------------------------------------------------
describe("publicar en varios tipos", () => {
  const prices: ListingPriceRow[] = [
    { listing_type_id: "gold_special", price: 10000, variants: { v1: 10000, v2: 11000 }, rule: { enabled: true, default_on: true }, override: null },
    { listing_type_id: "gold_pro", price: 11500, variants: { v1: 11500, v2: 12650 }, rule: { enabled: true, default_on: false }, override: null },
    { listing_type_id: "gold_premium", price: null, variants: {}, rule: null, override: { mode: "skip" } },
  ];
  const base: PublishInput = {
    model: "user_products",
    title: "Remera",
    categoryId: "MLA1",
    listingTypeId: "gold_special",
    price: 1,
    quantity: 3,
    condition: "new",
    pictures: ["a"],
    attributes: {},
    sku: null,
    gtin: null,
  };
  it("pickListingTypes filtra, saca repetidos y limita a 4", () => {
    expect(pickListingTypes(["gold_pro", "gold_pro", "MAL!", "gold_special"], "gold_special")).toEqual(["gold_pro", "gold_special"]);
    expect(pickListingTypes([], "gold_special")).toEqual(["gold_special"]);
    expect(pickListingTypes(["a1", "b2", "c3", "d4", "e5"].map((x) => `t_${x.replace(/\d/, "")}`), "x")).toHaveLength(4);
  });
  it("cada tipo lleva el precio del servidor, no el del formulario", () => {
    expect(inputForListing(base, "gold_pro", prices)).toMatchObject({ listingTypeId: "gold_pro", price: 11500 });
    expect(inputForListing(base, "gold_premium", prices)).toBeNull();
    expect(inputForListing(base, "free", prices)).toBeNull();
  });
  it("variantes: UP con precio por variante y clásico al mayor", () => {
    const withVariants: PublishInput = {
      ...base,
      variants: [
        { key: "v1", combos: [], price: 1, quantity: 1, sku: null, gtin: null },
        { key: "v2", combos: [], price: 1, quantity: 1, sku: null, gtin: null },
      ],
    };
    expect(inputForListing(withVariants, "gold_pro", prices)!.variants!.map((v) => v.price)).toEqual([11500, 12650]);
    expect(inputForListing({ ...withVariants, model: "classic" }, "gold_pro", prices)!.variants!.map((v) => v.price)).toEqual([12650, 12650]);
    const missing = { ...prices[0]!, variants: { v1: 10000 } };
    expect(inputForListing(withVariants, "gold_special", [missing])).toBeNull();
  });
  it("catalogMatch toma el producto del catálogo por GTIN y saca los atributos internos", () => {
    const m = catalogMatch(
      {
        query_type: "GTIN",
        results: [
          {
            id: "MLA19956264",
            name: "Coca Cola Original 2,25 Litros",
            domain_id: "MLA-SOFT_DRINKS",
            attributes: [
              { id: "BRAND", name: "Marca", value_id: "3981997", value_name: "Coca-Cola" },
              { id: "GTIN", value_name: "7790895000997" },
              { id: "MANUAL_TITLE", value_name: "x" },
            ],
          },
        ],
      },
      "7790895000997",
    );
    expect(m).toEqual({
      catalog_product_id: "MLA19956264",
      name: "Coca Cola Original 2,25 Litros",
      domain_id: "MLA-SOFT_DRINKS",
      attributes: [{ id: "BRAND", name: "Marca", value_id: "3981997", value_name: "Coca-Cola" }],
    });
    expect(catalogMatch({ query_type: "KEYWORDS", results: [{ id: "X" }] }, "1")).toBeNull();
    expect(catalogMatch({ query_type: "GTIN", results: [] }, "1")).toBeNull();
  });
  it("feesByType resume la comisión de Clásica y Premium", () => {
    expect(
      feesByType([
        { listing_type_id: "gold_pro", listing_type_name: "Premium", sale_fee_amount: 3997.81, sale_fee_details: { percentage_fee: 26.67807, fixed_fee: 1330 } },
        { listing_type_id: "free", sale_fee_amount: 0 },
      ]),
    ).toEqual([{ listing_type_id: "gold_pro", name: "Premium", sale_fee_amount: 3997.81, percentage_fee: 26.67807, fixed_fee: 1330 }]);
  });
});

describe("secciones y puesta en marcha", () => {
  it("cada sección tiene una explicación corta", () => {
    expect(GESTOR_SECTIONS.map((s) => s.key)).toEqual(["items", "orders", "billing", "questions", "shipments", "full", "postsale", "boards", "metrics", "config"]);
    for (const s of GESTOR_SECTIONS) {
      expect(s.summary.length).toBeGreaterThan(20);
      expect(s.summary).not.toMatch(/—/);
    }
  });
  it("checklist: qué falta y cuándo se muestra", () => {
    const steps = setupSteps({ status: "active", storeId: null, rulesCount: 0, invoiceMode: "manual", invoiceConfirmed: false, webhookSeen: false });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["stock", "prices", "invoice", "topics"]);
    const all = setupSteps({ status: "active", storeId: "s", rulesCount: 2, invoiceMode: "on_paid", invoiceConfirmed: false, webhookSeen: true });
    expect(all.every((s) => s.done)).toBe(true);
    const now = Date.parse("2026-10-15T12:00:00-03:00");
    expect(showSetup(steps, "2026-10-14T12:00:00-03:00", now)).toBe(true);
    expect(showSetup(steps, "2026-09-01T12:00:00-03:00", now)).toBe(false);
    expect(showSetup(all, "2026-10-14T12:00:00-03:00", now)).toBe(false);
    expect(setupSteps({ status: "active", storeId: "s", rulesCount: 1, invoiceMode: "manual", invoiceConfirmed: true, webhookSeen: true }).every((s) => s.done)).toBe(true);
  });
});
