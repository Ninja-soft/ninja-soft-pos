// @vitest-environment node
// =============================================================================
// Publicar en Mercado Libre "antibalas": envío según el estado real de la
// cuenta, avisos que no frenan, reintento único ante shipping.lost_*, título
// al largo de la categoría, tipo de publicación disponible y errores en
// español. Fixtures = respuestas reales de la cuenta conectada (Punto Express)
// leídas el 2026-10-15 con GET y POST /items/validate (nunca se publicó).
// Nunca se llama a Mercado Libre: el cliente es falso.
// =============================================================================
import { describe, expect, it } from "vitest";
import { MlApiError, classifyMlError } from "@/supabase/functions/_shared/mercadolibre/client";
import { attributeForm, fitTitle, validationCauses, type PublishInput } from "@/supabase/functions/_shared/mercadolibre/items";
import {
  SHIPPING_REASONS,
  chooseShippingPlan,
  me2Logistics,
  needsMeActivation,
  sellerMercadoEnvios,
} from "@/supabase/functions/_shared/mercadolibre/shipping";
import {
  CATALOG_NOTICE,
  TtlCache,
  newPublishCaches,
  postItemWithFixes,
  promoteBlockingWarnings,
  validateForPublish,
  type PublishClient,
} from "@/supabase/functions/_shared/mercadolibre/publish";
import { localRowState, type QuickRow } from "@/supabase/functions/_shared/mercadolibre/quick";
import { mlCauseInfo, visibleWarnings } from "@/lib/mercadolibre/labels";
import { configStatus } from "@/lib/mercadolibre/configSections";
import type { MlCategoryAttribute } from "@/supabase/functions/_shared/mercadolibre/types";

// --- Respuestas reales ------------------------------------------------------
const USER_ME = {
  tags: ["normal", "messages_as_seller", "user_product_seller"],
  status: { mercadoenvios: "not_accepted", list: { allow: true }, sell: { allow: true } },
};
const USER_PREFS = {
  local_pick_up: false,
  modes: ["custom", "not_specified", "me2"],
  option: "trial",
  me2_enablers: [],
  logistics: [
    { mode: "me2", types: [{ type: "drop_off", default: true, status: "active" }] },
    { mode: "custom", types: [{ type: "custom", default: true, status: "active" }] },
    { mode: "not_specified", types: [{ type: "not_specified", default: true, status: "active" }] },
  ],
  mandatory_settings: { mode: "me2" },
};
/** MLA10063 Hornos: me2 sólo con Flex (self_service). */
const CAT_HORNOS = {
  logistics: [
    { types: ["custom"], mode: "custom" },
    { types: ["not_specified"], mode: "not_specified" },
    { types: ["default"], mode: "me1" },
    { types: ["self_service"], mode: "me2" },
  ],
  category_id: "MLA10063",
};
/** MLA1002 Televisores: me2 con todas las logísticas. */
const CAT_TV = {
  logistics: [
    { types: ["custom"], mode: "custom" },
    { types: ["not_specified"], mode: "not_specified" },
    { types: ["default"], mode: "me1" },
    { types: ["drop_off", "xd_drop_off", "self_service", "cross_docking", "fulfillment"], mode: "me2" },
  ],
};
/** MLA455565 Papas congeladas: sin Mercado Envíos. */
const CAT_PAPAS = { logistics: [{ types: ["not_specified"], mode: "not_specified" }, { types: ["custom"], mode: "custom" }] };
/** 400 de /items/validate del horno (sólo avisos: el caso del bug). */
const VALIDATE_HORNO = {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [
    { department: "shipping", cause_id: 4053, type: "warning", code: "shipping.lost_me1_by_user", message: "User has not mode me1" },
    { department: "shipping", cause_id: 4057, type: "warning", code: "shipping.lost_me2_by_intersected_logistics", message: "User/Catalog has not intersected me2 logistics" },
  ],
};
const VALIDATE_VINO = {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [{ type: "warning", code: "shipping.lost_me1_by_user", message: "User has not mode me1" }],
};
const VALIDATE_LICOR = {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [
    { type: "warning", code: "shipping.lost_me1_by_user", message: "User has not mode me1" },
    { type: "warning", code: "moderations.seller.not_authorized", message: "Seller is not authorized for this category" },
  ],
};
const VALIDATE_PRECIO = {
  message: "Validation error",
  error: "validation_error",
  status: 400,
  cause: [{ type: "error", code: "item.price.invalid", message: "The category MLA40992 requires a minimum of price 3500" }],
};
const LISTING_TYPES = {
  category_id: "MLA10063",
  available: [
    { id: "gold_pro", name: "Premium", remaining_listings: null },
    { id: "gold_special", name: "Clásica", remaining_listings: null },
    { id: "free", name: "Gratuita", remaining_listings: 0 },
  ],
};
const ATTRS: MlCategoryAttribute[] = [
  { id: "BRAND", name: "Marca", value_type: "string", tags: { required: true } },
  { id: "MODEL", name: "Modelo", value_type: "string", tags: { required: true } },
  { id: "POWER_SUPPLY_TYPE", name: "Tipo de alimentación", value_type: "string", tags: {} },
];
const fields = attributeForm(ATTRS);

const horno: PublishInput = {
  model: "user_products",
  title: "Horno Empotrable Eléctrico Whirlpool WOB71AS 71 Litros",
  categoryId: "MLA10063",
  listingTypeId: "gold_special",
  price: 1_322_400,
  quantity: 1,
  condition: "new",
  pictures: ["https://cdn.x/horno.webp"],
  attributes: { BRAND: { value_name: "Whirlpool" }, MODEL: { value_name: "WOB71AS" } },
  sku: null,
  gtin: "8003437939792",
  emptyGtinReason: null,
};

// --- Cliente falso ------------------------------------------------------------
interface FakeOpts {
  me?: unknown;
  prefs?: unknown;
  category?: unknown;
  /** Respuesta de /items/validate según el modo de envío del cuerpo (null = 204). */
  validate?: (body: Record<string, unknown>) => unknown | null;
  listingTypes?: unknown;
}
function fakeClient(o: FakeOpts) {
  const calls: string[] = [];
  const validated: Array<Record<string, unknown>> = [];
  const client: PublishClient = {
    get: async <T,>(path: string) => {
      calls.push(`GET ${path}`);
      const map: Record<string, unknown> = {
        "/users/me": o.me,
        "/users/115224864/shipping_preferences": o.prefs,
        "/categories/MLA10063/shipping_preferences": o.category,
        "/users/115224864/available_listing_types": o.listingTypes ?? LISTING_TYPES,
      };
      const v = map[path];
      if (v === undefined) throw classifyMlError(404, { message: "resource not found", error: "not_found", cause: [] });
      return v as T;
    },
    request: async <T,>(method: string, path: string, opts?: { body?: unknown }) => {
      calls.push(`${method} ${path}`);
      const body = (opts?.body ?? {}) as Record<string, unknown>;
      validated.push(body);
      const res = o.validate ? o.validate(body) : null;
      if (res) throw classifyMlError(400, res as never);
      return { status: 204, data: null as T, headers: new Headers() };
    },
    post: async () => {
      throw new Error("no se publica en los tests de validación");
    },
  };
  return { client, calls, validated };
}
const modeOf = (b: Record<string, unknown>) => (b.shipping as { mode: string }).mode;

// =============================================================================
describe("envío según el estado real de la cuenta", () => {
  it("lee users/me y las logísticas de me2 (vendedor con status, categoría con strings)", () => {
    expect(sellerMercadoEnvios(USER_ME)).toBe("not_accepted");
    expect(sellerMercadoEnvios({})).toBeNull();
    expect([...me2Logistics(USER_PREFS)!]).toEqual(["drop_off"]);
    expect([...me2Logistics(CAT_HORNOS)!]).toEqual(["self_service"]);
    expect(me2Logistics(CAT_PAPAS)!.size).toBe(0);
    expect(me2Logistics({ modes: ["me2"] })).toBeNull();
    expect(me2Logistics({ logistics: [{ mode: "me2", types: [{ type: "drop_off", status: "inactive" }] }] })!.size).toBe(0);
  });

  it("el caso del bug: lista me2 pero no aceptó Mercado Envíos → a convenir y nunca me2", () => {
    const p = chooseShippingPlan({ me: USER_ME, user: USER_PREFS, category: CAT_HORNOS });
    expect(p.mode).toBe("not_specified");
    expect(p.allowed).toEqual(["not_specified", "custom"]);
    expect(p.freeShippingAllowed).toBe(false);
    expect(p.me2Blocker).toBe("not_accepted");
    expect(p.reason).toBe(SHIPPING_REASONS.noMe2NotAccepted);
    expect(needsMeActivation(p)).toBe(true);
  });

  it("con Mercado Envíos aceptado pero sin la logística de la categoría (horno pide Flex): a convenir", () => {
    const p = chooseShippingPlan({ me: { status: { mercadoenvios: "accepted" } }, user: USER_PREFS, category: CAT_HORNOS });
    expect(p.mode).toBe("not_specified");
    expect(p.me2Blocker).toBe("logistics");
    expect(p.reason).toMatch(/Flex/);
    expect(needsMeActivation(p)).toBe(false);
  });

  it("aceptado y con logística en común: Mercado Envíos con envío gratis", () => {
    const p = chooseShippingPlan({ me: { status: { mercadoenvios: "accepted" } }, user: USER_PREFS, category: CAT_TV });
    expect(p).toMatchObject({ mode: "me2", me2Blocker: null, freeShippingAllowed: true });
  });

  it("categoría sin Mercado Envíos y vendedor con me2 sin logística activa", () => {
    expect(chooseShippingPlan({ me: { status: { mercadoenvios: "accepted" } }, user: USER_PREFS, category: CAT_PAPAS }).me2Blocker).toBe("category");
    const inactive = { ...USER_PREFS, logistics: [{ mode: "me2", types: [{ type: "drop_off", status: "inactive" }] }] };
    expect(chooseShippingPlan({ me: { status: { mercadoenvios: "accepted" } }, user: inactive, category: CAT_TV }).me2Blocker).toBe("user");
  });

  it("sin users/me (no se pudo leer) se decide con las preferencias, como antes", () => {
    expect(chooseShippingPlan({ user: USER_PREFS, category: CAT_TV }).mode).toBe("me2");
  });
});

describe("avisos de ML: no frenan", () => {
  it("/items/validate da 400 con sólo avisos: no hay errores", () => {
    expect(validationCauses(VALIDATE_HORNO)).toEqual({
      errors: [],
      warnings: ["shipping.lost_me1_by_user: User has not mode me1", "shipping.lost_me2_by_intersected_logistics: User/Catalog has not intersected me2 logistics"],
    });
    expect(validationCauses(VALIDATE_VINO).errors).toEqual([]);
    expect(validationCauses({ cause: [] }, ["fallback"]).errors).toEqual(["fallback"]);
  });
  it("un aviso de moderación sí frena (Licores: no autorizado)", () => {
    const r = promoteBlockingWarnings(validationCauses(VALIDATE_LICOR));
    expect(r.errors).toEqual(["moderations.seller.not_authorized: Seller is not authorized for this category"]);
    expect(r.warnings).toEqual(["shipping.lost_me1_by_user: User has not mode me1"]);
  });
  it("visibleWarnings saca me1 y la pérdida de me2 cuando ya no se usa me2", () => {
    const w = [...validationCauses(VALIDATE_HORNO).warnings, "item.shipping.mandatory_free_shipping: Mandatory free shipping added"];
    expect(visibleWarnings(w, "not_specified")).toEqual(["item.shipping.mandatory_free_shipping: Mandatory free shipping added"]);
    expect(visibleWarnings(w, "me2")).toHaveLength(2);
  });
});

describe("validateForPublish (una sola función para el modal y la publicación rápida)", () => {
  it("el horno del bug valida: a convenir, aviso de catálogo y los avisos no cortan", async () => {
    const { client, validated } = fakeClient({ me: USER_ME, prefs: USER_PREFS, category: CAT_HORNOS, validate: () => VALIDATE_HORNO });
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, horno, fields, {
      maxTitleLength: 60,
      catalogProductId: "MLA44368982",
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.input.shipping?.mode).toBe("not_specified");
    expect(validated.map(modeOf)).toEqual(["not_specified"]);
    expect(v.notices).toContain(SHIPPING_REASONS.noMe2NotAccepted);
    expect(v.notices).toContain(CATALOG_NOTICE);
    expect(v.meActivation).toBe(true);
    // Nunca se manda catalog_listing: publicación propia.
    expect(JSON.stringify(validated[0])).not.toMatch(/catalog_listing|catalog_product_id/);
  });

  it("reintenta una vez si ML pierde el modo pedido (como error) y avisa", async () => {
    // Sin users/me ni preferencias: se intenta me2.
    const { client, validated } = fakeClient({
      validate: (b) =>
        modeOf(b) === "me2"
          ? { error: "validation_error", cause: [{ type: "error", code: "shipping.lost_me2_by_user", message: "User has not mode me2" }] }
          : null,
    });
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, horno, fields);
    expect(validated.map(modeOf)).toEqual(["me2", "not_specified"]);
    expect(v.ok).toBe(true);
    expect(v.notices.join(" ")).toMatch(/no aceptó ese envío/);
  });

  it("también reintenta si la pérdida del modo pedido llega como aviso", async () => {
    const { client, validated } = fakeClient({ prefs: USER_PREFS, validate: (b) => (modeOf(b) === "me2" ? VALIDATE_HORNO : null) });
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, horno, fields);
    expect(validated.map(modeOf)).toEqual(["me2", "not_specified"]);
    expect(v.ok).toBe(true);
  });

  it("acorta el título al largo de la categoría y lo avisa", async () => {
    const { client, validated } = fakeClient({ me: USER_ME, prefs: USER_PREFS, category: CAT_HORNOS });
    const long = { ...horno, title: "Desodorante antitranspirante Nivea Men Black White invisible original en aerosol 150 ml" };
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, long, fields, { maxTitleLength: 60 });
    expect(v.input.title).toBe("Desodorante antitranspirante Nivea Men Black White invisible");
    expect(v.input.title.length).toBeLessThanOrEqual(60);
    expect(v.notices[0]).toMatch(/lo acortamos/);
    expect(validated[0]!.family_name).toBe(v.input.title);
  });

  it("tipo de publicación no disponible: error claro sin llamar a /items/validate", async () => {
    const { client, validated } = fakeClient({ me: USER_ME, prefs: USER_PREFS, category: CAT_HORNOS });
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, { ...horno, listingTypeId: "free" }, fields);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("pos.listing_type_unavailable: [free]");
    expect(validated).toHaveLength(0);
    expect(mlCauseInfo(v.errors.at(-1)!).message).toMatch(/Gratuita no está disponible/);
  });

  it("precio mínimo de la categoría: error en español con el monto y la acción", async () => {
    const { client } = fakeClient({ me: USER_ME, prefs: USER_PREFS, category: CAT_HORNOS, validate: () => VALIDATE_PRECIO });
    const v = await validateForPublish({ client, mlUserId: 115224864, caches: newPublishCaches() }, { ...horno, price: 2380 }, fields);
    expect(v.ok).toBe(false);
    const i = mlCauseInfo(v.errors[0]!);
    expect(i.message).toBe("El precio mínimo de esta categoría es $ 3.500.");
    expect(i.action).toMatch(/Publicaciones y precios/);
  });

  it("memoriza lo de la cuenta: la segunda validación no vuelve a pedir users/me", async () => {
    const caches = newPublishCaches();
    const { client, calls } = fakeClient({ me: USER_ME, prefs: USER_PREFS, category: CAT_HORNOS });
    await validateForPublish({ client, mlUserId: 115224864, caches }, horno, fields);
    await validateForPublish({ client, mlUserId: 115224864, caches }, horno, fields);
    expect(calls.filter((c) => c === "GET /users/me")).toHaveLength(1);
    expect(calls.filter((c) => c === "POST /items/validate")).toHaveLength(2);
  });
});

describe("POST /items con un reintento", () => {
  const lost = new MlApiError("validation_error", "Validation error", 400, false, null, ["shipping.lost_me2_by_user: User has not mode me2"], {
    cause: [{ type: "error", code: "shipping.lost_me2_by_user", message: "User has not mode me2" }],
  });
  it("si pierde el envío, reintenta con el alternativo una sola vez", async () => {
    const sent: string[] = [];
    const client: PublishClient = {
      get: async () => ({}) as never,
      request: async () => ({}) as never,
      post: async <T,>(_p: string, body?: unknown) => {
        const m = ((body as { shipping: { mode: string } }).shipping).mode;
        sent.push(m);
        if (m === "me2") throw lost;
        return { id: "MLA1" } as T;
      },
    };
    const r = await postItemWithFixes(client, { shipping: { mode: "me2" } }, () => ({ mode: "not_specified" }));
    expect(sent).toEqual(["me2", "not_specified"]);
    expect(r.ok && r.notices[0]).toMatch(/envío a convenir/);
  });
  it("si sigue fallando, devuelve los errores y pide activar Mercado Envíos", async () => {
    let n = 0;
    const client: PublishClient = {
      get: async () => ({}) as never,
      request: async () => ({}) as never,
      post: async () => {
        n++;
        throw lost;
      },
    };
    const r = await postItemWithFixes(client, { shipping: { mode: "me2" } }, () => null);
    expect(n).toBe(1);
    expect(r).toMatchObject({ ok: false, meActivation: true });
  });
  it("un error que no es de datos (red, 429) no se traga", async () => {
    const client: PublishClient = {
      get: async () => ({}) as never,
      request: async () => ({}) as never,
      post: async () => {
        throw new MlApiError("rate_limited", "x", 429, true, 1000);
      },
    };
    await expect(postItemWithFixes(client, { shipping: { mode: "me2" } }, () => null)).rejects.toThrow();
  });
});

describe("piezas", () => {
  it("TtlCache vence y no memoriza errores", async () => {
    let t = 0;
    let n = 0;
    const c = new TtlCache(1000, () => t);
    const load = async () => ++n;
    expect(await c.get("a", load)).toBe(1);
    expect(await c.get("a", load)).toBe(1);
    t = 1500;
    expect(await c.get("a", load)).toBe(2);
    await expect(c.get("b", () => Promise.reject(new Error("x")))).rejects.toThrow();
    await Promise.resolve();
    expect(await c.get("b", load)).toBe(3);
  });
  it("fitTitle corta en una palabra y saca palabras prohibidas", () => {
    expect(fitTitle("Parrilla Brasero De Mesa Portatil Acero Inoxidable Tagwood BBQ07SS", 60)).toEqual({
      title: "Parrilla Brasero De Mesa Portatil Acero Inoxidable Tagwood",
      changed: true,
    });
    expect(fitTitle("Mate de calabaza OFERTA envío gratis", 60).title).toBe("Mate de calabaza");
    expect(fitTitle("Vino tinto Rutini", 60)).toEqual({ title: "Vino tinto Rutini", changed: false });
  });
  it("la fila rápida marca un código de barras con dígito verificador inválido", () => {
    const row: QuickRow = { title: "Producto de prueba", categoryId: "MLA1", maxTitleLength: 60, attrs: {}, condition: "new", gtin: "1234567890123", emptyGtinReason: null, freeShipping: false };
    const p = { product_id: "p", name: "x", description: null, sku: null, barcode: null, pictures: ["a"], qty: 1, warranty_months: null };
    expect(localRowState(p, row, []).problems.join()).toMatch(/código de barras no es válido/);
    expect(localRowState(p, { ...row, gtin: "8003437939792" }, []).state).toBe("ready");
  });
});

describe("errores frecuentes en español", () => {
  it.each([
    ["shipping.lost_me2_by_intersected_logistics: User/Catalog has not intersected me2 logistics", /logística de Mercado Envíos/],
    ["item.shipping.mandatory_free_shipping: Mandatory free shipping added", /envío gratis obligatorio/],
    ["shipping.free_shipping.cost_exceeded: Free shipping costs exceeds sale", /supera el precio/],
    ["item.listing_type_id.requiresPictures: Item pictures are mandatory for listing type gold_special", /al menos una foto/],
    ["item.attribute.product_identifier.invalid_format: Product Identifier [GTIN] contains values with invalid format: [1234567890123]", /1234567890123 no es válido/],
    ["moderations.seller.not_authorized: Seller is not authorized for this category", /no está autorizada/],
    ['item.attribute.missing_catalog_required: El campo "Modelo" es obligatorio y no está cargado.', /Conviene completar "Modelo"/],
  ])("%s", (raw, re) => {
    expect(mlCauseInfo(raw).message).toMatch(re);
  });
  it("faltantes con el nombre del atributo", () => {
    const raw =
      "item.attributes.missing_required: The attributes [POWER_SUPPLY_TYPE] are required for category MLA431202 and channel marketplace.";
    expect(mlCauseInfo(raw, { POWER_SUPPLY_TYPE: "Tipo de alimentación" }).message).toBe('Falta "Tipo de alimentación", obligatorio en esta categoría.');
  });
});

describe("configuración por secciones", () => {
  const base = {
    status: "active",
    storeId: "s1",
    rulesCount: 2,
    invoiceMode: "on_paid",
    invoiceConfirmed: false,
    mercadoEnvios: "not_accepted" as string | null | undefined,
    gestor: true as boolean | undefined,
    gestorConfigured: false,
    questionTemplates: 0,
  };
  it("marca lo que falta y lo informativo", () => {
    const s = configStatus(base);
    expect(s.cuenta.state).toBe("ok");
    expect(s.publicaciones.state).toBe("ok");
    expect(s.envios).toEqual({ state: "info", label: "Sin Mercado Envíos" });
    expect(s.facturacion).toEqual({ state: "ok", label: "Al pagarse" });
    expect(s.posventa.state).toBe("info");
    expect(configStatus({ ...base, storeId: null }).publicaciones).toEqual({ state: "missing", label: "Falta la sucursal" });
    expect(configStatus({ ...base, invoiceMode: "manual" }).facturacion.state).toBe("missing");
    expect(configStatus({ ...base, invoiceMode: "manual", invoiceConfirmed: true }).facturacion.state).toBe("ok");
    expect(configStatus({ ...base, mercadoEnvios: "accepted" }).envios.state).toBe("ok");
    expect(configStatus({ ...base, mercadoEnvios: undefined }).envios.state).toBe("loading");
    expect(configStatus({ ...base, gestor: false }).posventa.label).toBe("No incluido en tu plan");
    expect(configStatus({ ...base, questionTemplates: 3 }).preguntas.label).toBe("3 respuestas rápidas");
  });
});
