// @vitest-environment node
// =============================================================================
// Publicar en Mercado Libre: atributos condicionales (GRADING), modo de envío,
// predictor sin categorías de prueba y errores de ML en español. Fixtures con
// los tags reales de MLA1644 (Aires acondicionados) leídos el 2026-10-15.
// Nunca se llama a Mercado Libre.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  attributeForm,
  attributesToDelete,
  buildItemBodies,
  fieldsForCondition,
  filterCategorySuggestions,
  sanitizeAttributes,
  stripAttributes,
  validatePublish,
  validationCauses,
  type PublishInput,
} from "@/supabase/functions/_shared/mercadolibre/items";
import {
  SHIPPING_REASONS,
  chooseShippingPlan,
  excludedModesFromCauses,
  modesFrom,
  resolveShipping,
  shippingBody,
  validateShipping,
} from "@/supabase/functions/_shared/mercadolibre/shipping";
import { mlCauseInfo } from "@/lib/mercadolibre/labels";
import type { MlCategoryAttribute } from "@/supabase/functions/_shared/mercadolibre/types";

const MLA1644: MlCategoryAttribute[] = [
  { id: "BRAND", name: "Marca", value_type: "string", tags: { catalog_required: true, required: true } },
  { id: "MODEL", name: "Modelo", value_type: "string", tags: { required: true } },
  {
    id: "GRADING",
    name: "Estado del reacondicionado",
    value_type: "list",
    tags: { used_hidden: true, conditional_required: true, new_hidden: true },
    values: [
      { id: "40108830", name: "Excelente" },
      { id: "40108831", name: "Bueno" },
    ],
  },
  { id: "GTIN", name: "Código universal de producto", value_type: "string", tags: { multivalued: true, variation_attribute: true, used_hidden: true, conditional_required: true } },
  { id: "VALUE_ADDED_TAX", name: "IVA", value_type: "list", tags: { conditional_required: true }, values: [{ id: "48405909", name: "21 %" }] },
  { id: "EMPTY_GTIN_REASON", name: "Motivo de GTIN vacío", value_type: "list", tags: { hidden: true, variation_attribute: true, conditional_required: true } },
  { id: "WITH_POSITIVE_IMPACT", name: "Con impacto positivo", value_type: "list", tags: { read_only: true } },
  { id: "ITEM_CONDITION", name: "Condición del ítem", value_type: "list", tags: { hidden: true } },
];

const fields = attributeForm(MLA1644);

const base: PublishInput = {
  model: "user_products",
  title: "Aire acondicionado split 3000 frigorías",
  categoryId: "MLA1644",
  listingTypeId: "gold_special",
  price: 2_500_000,
  quantity: 1,
  condition: "new",
  pictures: ["https://cdn.x/aire.webp"],
  attributes: {
    BRAND: { value_name: "Ninja" },
    MODEL: { value_name: "S30" },
    GRADING: { value_id: "40108830", value_name: "Excelente" },
    WITH_POSITIVE_IMPACT: { value_id: "242085", value_name: "Sí" },
  },
  sku: "AIRE-30",
  gtin: "7790000000999",
  emptyGtinReason: null,
  freeShipping: true,
};

type Attr = { id: string; value_name?: string | null; value_id?: string | null };

describe("atributos condicionales", () => {
  it("attributeForm guarda para qué condición no aplica cada atributo", () => {
    expect(fields.find((f) => f.id === "GRADING")?.hiddenFor).toEqual(["new", "used"]);
    expect(fields.find((f) => f.id === "GTIN")?.hiddenFor).toEqual(["used"]);
    expect(fields.some((f) => f.id === "WITH_POSITIVE_IMPACT")).toBe(false);
  });
  it("GRADING no se muestra ni con Nuevo ni con Usado; GTIN sólo con Nuevo", () => {
    expect(fieldsForCondition(fields, "new").map((f) => f.id)).not.toContain("GRADING");
    expect(fieldsForCondition(fields, "used").map((f) => f.id)).not.toContain("GRADING");
    expect(fieldsForCondition(fields, "new").map((f) => f.id)).toContain("GTIN");
    expect(fieldsForCondition(fields, "used").map((f) => f.id)).not.toContain("GTIN");
    expect(fieldsForCondition(fields, "refurbished").map((f) => f.id)).toContain("GRADING");
  });
  it("sanitizeAttributes saca lo que no aplica, lo de solo lectura, lo desconocido y lo pedido", () => {
    const clean = sanitizeAttributes({ ...base.attributes, OTRO: { value_name: "x" } }, fields, "new");
    expect(Object.keys(clean)).toEqual(["BRAND", "MODEL"]);
    expect(Object.keys(sanitizeAttributes(base.attributes, fields, "new", ["MODEL"]))).toEqual(["BRAND"]);
  });
  it("buildItemBodies con los campos de la categoría no manda GRADING (el caso del bug)", () => {
    const [it0] = buildItemBodies(base, fields);
    const ids = (it0!.body.attributes as Attr[]).map((a) => a.id);
    expect(ids).not.toContain("GRADING");
    expect(ids).not.toContain("WITH_POSITIVE_IMPACT");
    expect(ids).toEqual(["BRAND", "MODEL", "SELLER_SKU", "GTIN", "ITEM_CONDITION"]);
  });
  it("con Usado no manda GTIN si la categoría lo oculta", () => {
    const [it0] = buildItemBodies({ ...base, condition: "used" }, fields);
    expect((it0!.body.attributes as Attr[]).map((a) => a.id)).toEqual(["BRAND", "MODEL", "SELLER_SKU", "ITEM_CONDITION"]);
  });
  it("validatePublish no pide atributos ni GTIN que no aplican a la condición", () => {
    const used = { ...base, condition: "used" as const, gtin: null, emptyGtinReason: null };
    expect(validatePublish(used, fields)).toEqual([]);
    const nuevo = { ...base, gtin: null, emptyGtinReason: null };
    expect(validatePublish(nuevo, fields).join()).toMatch(/GTIN/);
  });
  it("attributesToDelete lee el id entre corchetes de delete.item.attribute.*", () => {
    expect(
      attributesToDelete([
        "delete.item.attribute.business_conditional: Attribute [GRADING] to be deleted",
        "shipping.lost_me1_by_user: User has not mode me1",
        "delete.item.attribute.invalid: Attributes [FOO, BAR_2] to be deleted",
      ]),
    ).toEqual(["GRADING", "FOO", "BAR_2"]);
    expect(attributesToDelete(["delete.item.attribute.x: Attribute [FOO] and [BAR_2]"])).toEqual(["FOO", "BAR_2"]);
  });
  it("stripAttributes saca el atributo del ítem y de las variaciones", () => {
    const bodies = [
      {
        variantKey: null,
        body: {
          attributes: [{ id: "GRADING" }, { id: "BRAND" }],
          variations: [{ attributes: [{ id: "GRADING" }, { id: "SELLER_SKU" }], attribute_combinations: [{ id: "COLOR" }] }],
        },
      },
    ];
    const [out] = stripAttributes(bodies, ["GRADING"]);
    expect(out!.body.attributes).toEqual([{ id: "BRAND" }]);
    expect((out!.body.variations as Array<{ attributes: Attr[] }>)[0]!.attributes).toEqual([{ id: "SELLER_SKU" }]);
    expect(bodies[0]!.body.attributes).toHaveLength(2); // no muta
  });
  it("validationCauses separa errores de avisos", () => {
    const body = {
      cause: [
        { code: "delete.item.attribute.business_conditional", message: "Attribute [GRADING] to be deleted", type: "error" },
        { code: "item.attributes.missing_conditional_required", message: "[VALUE_ADDED_TAX]", type: "warning" },
      ],
    };
    expect(validationCauses(body)).toEqual({
      errors: ["delete.item.attribute.business_conditional: Attribute [GRADING] to be deleted"],
      warnings: ["item.attributes.missing_conditional_required: [VALUE_ADDED_TAX]"],
    });
    // Sólo avisos: /items/validate da 400 igual, pero no frena (ver mlPublicarAntibalas.test.ts).
    expect(validationCauses({ cause: [{ code: "a.b", message: "m", type: "warning" }] })).toEqual({ errors: [], warnings: ["a.b: m"] });
    expect(validationCauses(null, ["fallback"]).errors).toEqual(["fallback"]);
  });
});

describe("predictor de categoría", () => {
  it("saca las categorías de prueba y las repetidas", () => {
    const out = filterCategorySuggestions([
      { domain_id: "MLA-AIR_CONDITIONERS", domain_name: "Aires acondicionados", category_id: "MLA1644", category_name: "Aires Acondicionados" },
      { domain_id: "MLA-ALL_IN_ONE_COMPUTERS_TEST", domain_name: "Computadoras all in one test", category_id: "MLA459576", category_name: "All in One Test" },
      { domain_id: "MLA-VEHICLE_AC_FULL_KITS", domain_name: "Kits", category_id: "MLA60610", category_name: "Equipos Completos" },
      { domain_id: "MLA-VEHICLE_AC_FULL_KITS", domain_name: "Kits", category_id: "MLA60610", category_name: "Equipos Completos" },
      { domain_id: "MLA-TESTERS", domain_name: "Testers eléctricos", category_id: "MLA1", category_name: "Testers" },
    ]);
    expect(out.map((s) => s.category_id)).toEqual(["MLA1644", "MLA60610", "MLA1"]);
  });
  it("respeta el tope", () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ category_id: `MLA${i}`, category_name: `Cat ${i}` }));
    expect(filterCategorySuggestions(list, 3)).toHaveLength(3);
    expect(filterCategorySuggestions(null)).toEqual([]);
  });
});

describe("modo de envío", () => {
  it("modesFrom lee las tres formas de respuesta de ML", () => {
    expect([...modesFrom({ modes: ["custom", "not_specified", "me2"] })!]).toEqual(["custom", "not_specified", "me2"]);
    expect([...modesFrom({ logistics: [{ mode: "me2", types: ["drop_off"] }] })!]).toEqual(["me2"]);
    expect([...modesFrom([{ mode: "me2" }, { mode: "custom" }])!]).toEqual(["me2", "custom"]);
    expect(modesFrom({ logistics: [] })!.size).toBe(0);
    expect(modesFrom({ foo: 1 })).toBeNull();
    expect(modesFrom(undefined)).toBeNull();
  });
  it("me2 si vendedor y categoría lo admiten, con envío gratis", () => {
    const p = chooseShippingPlan({ user: { modes: ["custom", "not_specified", "me2"] }, category: { logistics: [{ mode: "me2" }] } });
    expect(p).toMatchObject({ mode: "me2", freeShippingAllowed: true, known: true, reason: SHIPPING_REASONS.me2 });
  });
  it("categoría sin me2 (el caso del aire): a convenir, sin envío gratis y nunca me1", () => {
    const p = chooseShippingPlan({ user: { modes: ["custom", "not_specified", "me2", "me1"] }, category: { logistics: [] } });
    expect(p.mode).toBe("not_specified");
    expect(p.allowed).toEqual(["not_specified", "custom"]);
    expect(p.freeShippingAllowed).toBe(false);
    expect(p.reason).toBe(SHIPPING_REASONS.noMe2Category);
    expect(p.allowed).not.toContain("me1");
  });
  it("vendedor sin me2: lo explica por la cuenta", () => {
    const p = chooseShippingPlan({ user: { modes: ["custom", "not_specified"] }, category: { logistics: [{ mode: "me2" }] } });
    expect(p.mode).toBe("not_specified");
    expect(p.reason).toBe(SHIPPING_REASONS.noMe2User);
  });
  it("shipping_modes del vendedor para la categoría manda sobre lo demás", () => {
    const p = chooseShippingPlan({ user: { modes: ["me2", "custom"] }, category: { logistics: [{ mode: "me2" }] }, userCategory: [{ mode: "custom" }] });
    expect(p.allowed).toEqual(["custom"]);
    expect(p.mode).toBe("custom");
  });
  it("sin datos se intenta me2 y se avisa; un modo rechazado por ML se excluye", () => {
    const unknown = chooseShippingPlan({});
    expect(unknown).toMatchObject({ mode: "me2", known: false, reason: SHIPPING_REASONS.unknown });
    const after = chooseShippingPlan({ excluded: ["me2"] });
    expect(after.mode).toBe("not_specified");
    expect(after.reason).toBe(SHIPPING_REASONS.noMe2Rejected);
  });
  it("sin ningún modo válido cae en a convenir", () => {
    expect(chooseShippingPlan({ userCategory: [{ mode: "me1" }] }).mode).toBe("not_specified");
  });
  it("resolveShipping: envío gratis sólo con me2 y custom sin costos pasa a convenir", () => {
    const noMe2 = chooseShippingPlan({ category: { logistics: [] } });
    const r = resolveShipping({ mode: "me2", freeShipping: true }, noMe2);
    expect(r.input).toEqual({ mode: "not_specified", freeShipping: false, localPickUp: false });
    expect(r.adjusted).toMatch(/Envío a convenir/);
    const custom = resolveShipping({ mode: "custom", costs: [{ description: "CABA", cost: 5000 }] }, noMe2);
    expect(custom.input).toMatchObject({ mode: "custom", costs: [{ description: "CABA", cost: 5000 }] });
    expect(custom.adjusted).toBeNull();
    expect(resolveShipping({ mode: "custom", costs: [] }, noMe2).input.mode).toBe("not_specified");
    const me2 = chooseShippingPlan({ user: { modes: ["me2"] } });
    expect(resolveShipping({ mode: "me2", freeShipping: true }, me2).input.freeShipping).toBe(true);
  });
  it("shippingBody arma cada modo", () => {
    expect(shippingBody({ mode: "me2", freeShipping: true })).toEqual({ mode: "me2", local_pick_up: false, free_shipping: true });
    expect(shippingBody({ mode: "not_specified", freeShipping: true, localPickUp: true })).toEqual({
      mode: "not_specified",
      local_pick_up: true,
      free_shipping: false,
    });
    expect(shippingBody({ mode: "custom", costs: [{ description: " Todo el país ", cost: 1234.567 }] })).toEqual({
      mode: "custom",
      local_pick_up: false,
      free_shipping: false,
      costs: [{ description: "Todo el país", cost: 1234.57 }],
    });
  });
  it("buildItemBodies usa el envío elegido y validateShipping pide costos en custom", () => {
    const [it0] = buildItemBodies({ ...base, shipping: { mode: "not_specified" } }, fields);
    expect(it0!.body.shipping).toEqual({ mode: "not_specified", local_pick_up: false, free_shipping: false });
    const [legacy] = buildItemBodies({ ...base, shipping: undefined });
    expect(legacy!.body.shipping).toEqual({ mode: "me2", local_pick_up: false, free_shipping: true });
    expect(validateShipping({ mode: "custom", costs: [] })[0]).toMatch(/costo de envío/);
    expect(validateShipping({ mode: "custom", costs: [{ description: "", cost: 10 }] })[0]).toMatch(/descripción/);
    expect(validatePublish({ ...base, shipping: { mode: "custom", costs: [] } }, fields).join()).toMatch(/costo de envío/);
  });
  it("excludedModesFromCauses lee los modos rechazados", () => {
    expect(
      excludedModesFromCauses([
        "shipping.lost_me1_by_user: User has not mode me1",
        "shipping.lost_me2_by_catalog: Catalog has not mode me2",
      ]),
    ).toEqual(["me2"]);
  });
});

describe("errores de ML en español", () => {
  it("traduce los tres errores del caso real con la acción", () => {
    const g = mlCauseInfo("delete.item.attribute.business_conditional: Attribute [GRADING] to be deleted");
    expect(g.code).toBe("delete.item.attribute.business_conditional");
    expect(g.message).toMatch(/GRADING/);
    expect(g.action).toBeTruthy();
    expect(mlCauseInfo("shipping.lost_me2_by_catalog: Catalog has not mode me2").message).toBe("Esta categoría no admite Mercado Envíos.");
    expect(mlCauseInfo("shipping.lost_me1_by_user: User has not mode me1").action).toMatch(/a convenir/);
  });
  it.each([
    ["item.attributes.missing_required: [BRAND]", /Falta "BRAND", obligatorio/],
    ["item.attribute.invalid: [COLOR] value", /no es válido/],
    ["item.price.invalid: price 0", /precio no es válido/],
    ["item.price.minimum: min 1000", /mínimo/],
    ["item.title.length: too long", /largo o muy corto/],
    ["item.title.invalid: words", /reglas/],
    ["item.pictures.download_error: x", /fotos?/],
    ["item.pictures.max: 13", /fotos/],
    ["shipping.mode.invalid: x", /forma de envío/],
  ])("%s", (raw, re) => {
    const i = mlCauseInfo(raw);
    expect(i.message).toMatch(re);
    expect(i.raw).toBe(raw);
  });
  it("errores del POS (ya en español) quedan igual y sin código", () => {
    expect(mlCauseInfo("El título es muy corto.")).toEqual({ message: "El título es muy corto.", action: null, code: null, raw: "El título es muy corto." });
  });
  it("código desconocido: muestra el mensaje de ML y guarda el código", () => {
    expect(mlCauseInfo("foo.bar_baz: algo raro")).toMatchObject({ message: "algo raro", code: "foo.bar_baz" });
  });
});
