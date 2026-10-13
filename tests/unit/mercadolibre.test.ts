// @vitest-environment node
// =============================================================================
// Mercado Libre MVP (H87 · ADR-104): módulos puros de
// supabase/functions/_shared/mercadolibre con fixtures fieles a la doc oficial.
// Nunca se llama a Mercado Libre: el fetch es falso.
// =============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ML_NOT_CONFIGURED, appIdOf, readMlConfig } from "@/supabase/functions/_shared/mercadolibre/config";
import { MlApiError, classifyMlError, createMlClient, familyOf, jobBackoffMs, parseRetryAfter } from "@/supabase/functions/_shared/mercadolibre/client";
import {
  authorizationUrl,
  codeChallengeS256,
  exchangeCode,
  getAccessToken,
  newCodeVerifier,
  type TokenDeps,
  type TokenRow,
} from "@/supabase/functions/_shared/mercadolibre/oauth";
import { isMvpTopic, parseNotification, resourceId, syntheticOrderNotification } from "@/supabase/functions/_shared/mercadolibre/notifications";
import {
  buildPackPayload,
  expectedLetter,
  labelBatches,
  labelBlocker,
  normalizeBilling,
  normalizeShipment,
  packDecision,
  receptorIva,
} from "@/supabase/functions/_shared/mercadolibre/orders";
import { attributeForm, buildItemBodies, itemIdentifiers, suggestLinks, validatePublish, type PublishInput } from "@/supabase/functions/_shared/mercadolibre/items";
import { publishableQty, pushSellingAddress, pushVariationQuantities, stockModeFrom } from "@/supabase/functions/_shared/mercadolibre/stock";
import { extractZpl, labelPath } from "@/supabase/functions/_shared/mercadolibre/labels";
import { buildInvoicePdf } from "@/supabase/functions/_shared/mercadolibre/invoicePdf";
import { outcomeOf, processJob, processNotification, type JobDeps } from "@/supabase/functions/_shared/mercadolibre/worker";
import { PUBLIC_FUNCTIONS } from "@/scripts/deploy-check.mjs";
import * as F from "../fixtures/mercadolibre";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** fetch falso: cada handler recibe la llamada y devuelve [status, body, headers?]. */
function fakeFetch(handler: (c: Call) => [number, unknown, Record<string, string>?]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const c: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(c);
    const [status, body, headers] = handler(c);
    const payload = body instanceof Uint8Array ? body : body === null ? null : JSON.stringify(body);
    return new Response(payload as BodyInit | null, { status, headers: headers ?? {} });
  };
  return { fn, calls };
}

describe("configuración de la app", () => {
  it("sin ML_CLIENT_ID / ML_CLIENT_SECRET falla con el mensaje claro", () => {
    const r = readMlConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(ML_NOT_CONFIGURED);
      expect(r.message).toMatch(/Falta configurar la app de Mercado Libre/);
    }
    expect(appIdOf({})).toBeNull();
  });
  it("con los secrets arma el redirect fijo desde APP_URL", () => {
    const r = readMlConfig({ ML_CLIENT_ID: F.APP_ID, ML_CLIENT_SECRET: "secreto-largo", APP_URL: "https://pos.ninjasoft.com.ar/" });
    expect(r.ok && r.config.redirectUri).toBe("https://pos.ninjasoft.com.ar/api/ml/oauth/callback");
    expect(readMlConfig({ ML_CLIENT_ID: F.APP_ID, ML_CLIENT_SECRET: "secreto-largo", ML_REDIRECT_URI: "http://x" }).ok).toBe(false);
  });
});

describe("OAuth con PKCE", () => {
  it("code_challenge S256 = base64url(sha256(verifier))", async () => {
    const verifier = "dBjftJeZ4CVP-mA2DcqQq1yGXjgfzlZ69VS2oLNrB5u";
    expect(await codeChallengeS256(verifier)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const v = newCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("URL de autorización con state y challenge, sin secretos", () => {
    const u = new URL(authorizationUrl({ clientId: F.APP_ID, redirectUri: "https://pos.x/api/ml/oauth/callback", state: "a".repeat(64), codeChallenge: "chal" }));
    expect(u.origin).toBe("https://auth.mercadolibre.com.ar");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("a".repeat(64));
    expect(u.toString()).not.toMatch(/secret/);
  });

  it("el canje manda los parámetros en el body form-urlencoded (nunca en la query)", async () => {
    const f = fakeFetch(() => [200, F.tokenResponse]);
    const tok = await exchangeCode(f.fn, { clientId: F.APP_ID, clientSecret: "s3cr3t", redirectUri: "https://x/cb", code: "TG-code", codeVerifier: "ver" });
    expect(tok.user_id).toBe(F.SELLER_ID);
    const c = f.calls[0]!;
    expect(c.url).toBe("https://api.mercadolibre.com/oauth/token");
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(c.body!);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("ver");
    expect(body.get("client_secret")).toBe("s3cr3t");
  });

  it("invalid_grant y operador colaborador se clasifican", () => {
    expect(classifyMlError(400, { error: "invalid_grant", message: "invalid_grant" }).code).toBe("invalid_grant");
    expect(classifyMlError(403, { message: "invalid_operator_user_id" }).code).toBe("operator_user");
    expect(classifyMlError(403, { message: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES" }).code).toBe("missing_permission");
  });
});

// Base falsa con lock atómico y un ML falso cuyo refresh es de UN SOLO USO.
function tokenWorld(expiresInMs: number) {
  let now = Date.parse("2026-10-13T12:00:00Z");
  const row: TokenRow & { lock: string | null; lockUntil: number } = {
    access_token: "AT-0",
    refresh_token: "RT-0",
    expires_at: new Date(now + expiresInMs).toISOString(),
    lock: null,
    lockUntil: 0,
  };
  let valid = "RT-0";
  let refreshCalls = 0;
  let n = 0;
  const failures: string[] = [];
  const deps: TokenDeps = {
    read: async () => ({ access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at }),
    tryLock: async (_a, lock) => {
      if (row.lock && row.lockUntil > now) return null;
      row.lock = lock;
      row.lockUntil = now + 30_000;
      return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at };
    },
    release: async (_a, lock) => {
      if (row.lock === lock) row.lock = null;
    },
    save: async (_a, lock, tok) => {
      if (row.lock !== lock) throw new Error("lock perdido");
      row.access_token = tok.access_token;
      row.refresh_token = tok.refresh_token ?? row.refresh_token;
      row.expires_at = new Date(now + tok.expires_in * 1000).toISOString();
      row.lock = null;
    },
    fail: async (_a, _l, code) => {
      failures.push(code);
      row.lock = null;
    },
    refresh: async (rt) => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 5));
      if (rt !== valid) throw new MlApiError("invalid_grant", "invalid_grant", 400, false);
      n++;
      valid = `RT-${n}`;
      return { ...F.tokenResponse, access_token: `AT-${n}`, refresh_token: valid };
    },
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 2));
    },
    now: () => now,
    newLockId: () => Math.random().toString(36).slice(2),
  };
  return { deps, row, failures, refreshCalls: () => refreshCalls, advance: (ms: number) => (now += ms) };
}

describe("renovación del token con lock por cuenta", () => {
  it("token vigente: no renueva", async () => {
    const w = tokenWorld(3 * 3600_000);
    expect(await getAccessToken(w.deps, "acc")).toBe("AT-0");
    expect(w.refreshCalls()).toBe(0);
  });

  it("10 renovaciones simultáneas dejan UNA sola renovación válida", async () => {
    const w = tokenWorld(60_000);
    const tokens = await Promise.all(Array.from({ length: 10 }, () => getAccessToken(w.deps, "acc")));
    expect(w.refreshCalls()).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["AT-1"]));
    expect(w.row.refresh_token).toBe("RT-1");
    expect(w.failures).toEqual([]);
  });

  it("401: renueva aunque no venza y reutiliza el refresh nuevo", async () => {
    const w = tokenWorld(3 * 3600_000);
    expect(await getAccessToken(w.deps, "acc", { rejected: "AT-0" })).toBe("AT-1");
    w.advance(10 * 3600_000);
    expect(await getAccessToken(w.deps, "acc")).toBe("AT-2");
    expect(w.refreshCalls()).toBe(2);
  });

  it("invalid_grant: la cuenta queda para reconectar", async () => {
    const w = tokenWorld(0);
    w.row.refresh_token = "RT-viejo";
    await expect(getAccessToken(w.deps, "acc")).rejects.toMatchObject({ code: "invalid_grant" });
    expect(w.failures).toEqual(["invalid_grant"]);
  });
});

describe("cliente HTTP", () => {
  it("401 renueva el token una vez y reintenta", async () => {
    let tokens = 0;
    const f = fakeFetch((c) => (c.headers.Authorization === "Bearer T1" ? [401, { message: "invalid_token" }] : [200, { id: 1 }]));
    const client = createMlClient({ fetch: f.fn, getToken: async () => `T${++tokens}` });
    expect(await client.get("/users/me")).toEqual({ id: 1 });
    expect(f.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer T1", "Bearer T2"]);
  });

  it("429 con Retry-After queda reintentable", async () => {
    const f = fakeFetch(() => [429, { error: "local_rate_limited" }, { "retry-after": "7" }]);
    const client = createMlClient({ fetch: f.fn, getToken: async () => "T" });
    await expect(client.get("/items/MLA1")).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 7000 });
    expect(parseRetryAfter("3")).toBe(3000);
  });

  it("el gate de límite de llamadas recibe la familia del recurso", async () => {
    const fams: string[] = [];
    const f = fakeFetch(() => [200, {}]);
    const client = createMlClient({ fetch: f.fn, getToken: async () => "T", gate: async (fam) => void fams.push(fam) });
    await client.get("/user-products/MLAU1/stock");
    await client.get("/orders/1");
    expect(fams).toEqual(["stock", "orders"]);
    expect(familyOf("/packs/1/fiscal_documents")).toBe("invoices");
  });

  it("backoff exponencial con jitter y tope", () => {
    expect(jobBackoffMs(1, () => 0.5)).toBe(30_000);
    expect(jobBackoffMs(3, () => 0.5)).toBe(120_000);
    expect(jobBackoffMs(20, () => 0.5)).toBe(30 * 60_000);
    expect(jobBackoffMs(1, () => 0)).toBe(24_000);
  });
});

describe("notificaciones", () => {
  it("la notificación de la doc es válida y dedupe por _id", () => {
    const r = parseNotification(F.notificationOrder, F.APP_ID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.n.dedupeKey).toBe(F.notificationOrder._id);
      expect(r.n.userId).toBe(String(F.SELLER_ID));
      expect(resourceId(r.n.resource)).toBe("2000003508419013");
    }
  });
  it("otra app, recurso inválido o tópico desconocido se rechazan", () => {
    expect(parseNotification({ ...F.notificationOrder, application_id: 1234 }, F.APP_ID)).toEqual({ ok: false, reason: "wrong_application" });
    expect(parseNotification({ ...F.notificationOrder, resource: "/orders/../users/1" }, F.APP_ID)).toEqual({ ok: false, reason: "invalid_resource" });
    expect(parseNotification({ ...F.notificationOrder, topic: "hackeo" }, F.APP_ID)).toEqual({ ok: false, reason: "unknown_topic" });
    expect(parseNotification({ ...F.notificationOrder }, null)).toEqual({ ok: false, reason: "wrong_application" });
    expect(parseNotification("x", F.APP_ID)).toEqual({ ok: false, reason: "invalid_payload" });
  });
  it("sin _id la clave es tópico|recurso|sent; los tópicos v2 se guardan pero no se procesan", () => {
    const r = parseNotification({ ...F.notificationOrder, _id: undefined }, F.APP_ID);
    expect(r.ok && r.n.dedupeKey).toBe("orders_v2|/orders/2000003508419013|2026-10-13T16:19:20.129Z");
    expect(isMvpTopic("questions")).toBe(true);
    expect(isMvpTopic("fbm_stock_operations")).toBe(false);
    const s = syntheticOrderNotification(1, 2, "2026-10-13T10:00:00Z");
    expect(s.dedupe_key).toBe("poll|orders_v2|/orders/1|2026-10-13T10:00:00.000Z");
  });
});

describe("billing-info -> tipo de comprobante", () => {
  it("formato nuevo con CUIT RI: Factura A para un emisor RI", () => {
    const b = normalizeBilling(F.billingNewCuit)!;
    expect(b).toMatchObject({ docType: "cuit", docNumber: "20123456786", name: "Pérez SRL", ivaCondition: "responsable_inscripto" });
    expect(expectedLetter("responsable_inscripto", b.ivaCondition)).toBe("A");
  });
  it("DNI consumidor final: Factura B; emisor monotributista: C siempre", () => {
    const b = normalizeBilling(F.billingNewDni)!;
    expect(b.ivaCondition).toBe("consumidor_final");
    expect(expectedLetter("responsable_inscripto", b.ivaCondition)).toBe("B");
    expect(expectedLetter("monotributo", "responsable_inscripto")).toBe("C");
    expect(expectedLetter(null, "consumidor_final")).toBeNull();
  });
  it("formato anterior (additional_info) y CUIT sin condición: regla de ML CUIT -> A", () => {
    const b = normalizeBilling(F.billingLegacy)!;
    expect(b).toMatchObject({ docType: "cuit", name: "Comercial Sur SA", ivaCondition: "monotributo" });
    expect(expectedLetter("responsable_inscripto", b.ivaCondition)).toBe("A");
    expect(receptorIva(null, "cuit")).toBe("responsable_inscripto");
    expect(receptorIva("", "dni")).toBe("consumidor_final");
    expect(receptorIva("IVA Exento", "cuit")).toBe("exento");
  });
});

describe("orden -> venta (pack)", () => {
  it("un carrito de dos órdenes es UNA venta con todas las líneas y la comisión por unidad", () => {
    const p = buildPackPayload(
      [order2(2000003508419014), order2(2000003508419013)],
      normalizeShipment(F.shipmentNew),
      normalizeBilling(F.billingNewDni),
    );
    expect(p.pack_key).toBe("2000000099999");
    expect(p.orders.map((o) => o.ml_order_id)).toEqual(["2000003508419013", "2000003508419014"]);
    expect(p.orders[0]!.lines[0]).toMatchObject({ ml_item_id: "MLA1500000001", quantity: 2, unit_price: 1500, seller_sku: "REM-01" });
    expect(p.orders[0]!.sale_fee_total).toBe(391);
    expect(p.shipment?.cost).toBe(450.5);
  });
  it("sin carrito, la clave es el order_id", () => {
    expect(buildPackPayload([F.order(77777)], null, null).pack_key).toBe("77777");
  });
  it("decisión: pagado crea, fraude bloquea, cancelado revierte, parcial a revisar", () => {
    const o = (status: string, fraud = false) => ({ status, fraud_risk: fraud }) as never;
    expect(packDecision({ orders: [o("paid"), o("paid")] }, false)).toBe("create_sale");
    expect(packDecision({ orders: [o("paid"), o("payment_required")] }, false)).toBe("wait_payment");
    expect(packDecision({ orders: [o("paid", true)] }, false)).toBe("fraud");
    expect(packDecision({ orders: [o("cancelled")] }, true)).toBe("cancel");
    expect(packDecision({ orders: [o("cancelled"), o("paid")] }, true)).toBe("partial_cancel");
    expect(packDecision({ orders: [o("paid")] }, true)).toBe("noop");
  });
  it("envío: formato nuevo y viejo; etiqueta sólo ME2 lista y nunca con fraude ni Full", () => {
    const a = normalizeShipment(F.shipmentNew);
    expect(a).toMatchObject({ mode: "me2", logistic_type: "cross_docking", status: "ready_to_ship", substatus: "ready_to_print", city: "Córdoba" });
    expect(labelBlocker(a, false)).toBeNull();
    expect(labelBlocker(a, true)).toBe("fraud");
    const b = normalizeShipment(F.shipmentOld);
    expect(b).toMatchObject({ logistic_type: "fulfillment", order_id: "2000003508419014" });
    expect(labelBlocker({ ...b, status: "ready_to_ship", substatus: "ready_to_print" }, false)).toBe("fulfillment");
    expect(labelBlocker({ ...a, mode: "me1" }, false)).toBe("not_me2");
    expect(labelBatches(Array.from({ length: 120 }, (_, i) => i)).map((x) => x.length)).toEqual([50, 50, 20]);
    expect(labelPath(["40123456789", "x"], "zpl2")).toBe("/shipment_labels?shipment_ids=40123456789&response_type=zpl2&savePdf=Y");
  });
});

function order2(id: number) {
  return F.order(id, { pack_id: 2000000099999 });
}

describe("publicaciones", () => {
  const fields = attributeForm(F.categoryAttributes);
  it("formulario: obligatorios primero, sin read_only ni hidden", () => {
    expect(fields.map((f) => f.id)).toEqual(["BRAND", "MODEL", "COLOR", "GTIN", "SIZE", "SELLER_SKU", "MATERIAL"]);
    expect(fields.find((f) => f.id === "COLOR")).toMatchObject({ variationAttribute: true, options: [{ id: "52049", name: "Negro" }] });
  });
  const base: PublishInput = {
    model: "user_products",
    title: "Remera algodón peinado",
    categoryId: "MLA109276",
    listingTypeId: "gold_special",
    price: 1500,
    quantity: 5,
    condition: "new",
    pictures: ["https://cdn.x/a.webp"],
    attributes: { BRAND: { value_name: "Ninja" }, MODEL: { value_name: "Básica" } },
    sku: "REM-01",
    gtin: null,
    emptyGtinReason: "17055161",
    variants: [
      { key: "v-negro", combos: [{ id: "COLOR", value_name: "Negro", value_id: "52049" }], price: 1500, quantity: 3, sku: "REM-01-N", gtin: null },
      { key: "v-blanco", combos: [{ id: "COLOR", value_name: "Blanco" }], price: 1600, quantity: 2.7, sku: "REM-01-B", gtin: "7790000000001" },
    ],
  };
  it("valida obligatorios y título", () => {
    expect(validatePublish(base, fields)).toEqual([]);
    const errs = validatePublish({ ...base, title: "Remera con envío gratis", attributes: {}, pictures: [] }, fields);
    expect(errs.join(" | ")).toMatch(/Marca/);
    expect(errs.join(" | ")).toMatch(/foto/);
    expect(errs.join(" | ")).toMatch(/no puede mencionar/);
  });
  it("User Products: un ítem por variante con family_name, sin title y con ITEM_CONDITION", () => {
    const bodies = buildItemBodies(base);
    expect(bodies).toHaveLength(2);
    const b = bodies[1]!.body as Record<string, unknown> & { attributes: Array<{ id: string; value_name?: string | null }> };
    expect(bodies[1]!.variantKey).toBe("v-blanco");
    expect(b.family_name).toBe("Remera algodón peinado");
    expect(b.title).toBeUndefined();
    expect(b.price).toBe(1600);
    expect(b.available_quantity).toBe(2);
    expect(b.channels).toEqual(["marketplace"]);
    expect(b.attributes.map((a) => a.id)).toEqual(["BRAND", "MODEL", "COLOR", "SELLER_SKU", "GTIN", "ITEM_CONDITION"]);
  });
  it("clásico: un ítem con variations[] y mismo precio", () => {
    const classic = { ...base, model: "classic" as const, variants: base.variants!.map((v) => ({ ...v, price: 1500 })) };
    expect(validatePublish(classic, fields)).toEqual([]);
    const [one] = buildItemBodies(classic);
    const body = one!.body as { title: string; variations: Array<{ attribute_combinations: unknown[]; available_quantity: number }> };
    expect(body.title).toBe("Remera algodón peinado");
    expect(body.variations).toHaveLength(2);
    expect(body.variations[0]!.attribute_combinations).toEqual([{ id: "COLOR", value_id: "52049" }]);
    expect(validatePublish({ ...base, model: "classic" }, fields).join()).toMatch(/mismo precio/);
  });
  it("vincular existentes: SKU primero, después GTIN, sin repetir variante", () => {
    const ids = itemIdentifiers(F.itemClassicWithVariations);
    expect(ids.map((i) => [i.variationId, i.sku, i.gtin])).toEqual([
      ["174997747229", "ZAP-40", null],
      ["174997747230", null, "7790000000411"],
    ]);
    const s = suggestLinks(ids, [
      { product_id: "p1", variant_id: "v40", sku: "zap-40", barcode: null },
      { product_id: "p1", variant_id: "v41", sku: null, barcode: "7790000000411" },
    ]);
    expect(s).toEqual([
      { variationId: "174997747229", product_id: "p1", variant_id: "v40", by: "sku" },
      { variationId: "174997747230", product_id: "p1", variant_id: "v41", by: "gtin" },
    ]);
  });
});

describe("stock POS -> ML", () => {
  it("modo según ubicaciones del User Product y logística", () => {
    expect(stockModeFrom(F.itemUp, { locations: [{ type: "meli_facility", quantity: 3 }] })).toBe("full_only");
    expect(stockModeFrom(F.itemUp, { locations: [{ type: "meli_facility", quantity: 3 }, { type: "selling_address", quantity: 2 }] })).toBe("selling_address");
    expect(stockModeFrom(F.itemUp, { locations: [{ type: "seller_warehouse", quantity: 1 }] })).toBe("seller_warehouse");
    expect(stockModeFrom(F.itemClassicWithVariations, null)).toBe("item_variations");
    expect(publishableQty(-2)).toBe(0);
    expect(publishableQty(3.9)).toBe(3);
  });

  it("selling_address manda x-version y ante 409 relee y reintenta", async () => {
    let version = 7;
    let puts = 0;
    const f = fakeFetch((c) => {
      if (c.method === "GET") return [200, { locations: [{ type: "selling_address", quantity: 1 }] }, { "x-version": String(version) }];
      puts++;
      if (puts === 1) {
        version = 8; // otro cambio entre medio
        return [409, { message: "version mismatch" }];
      }
      return [204, null];
    });
    const client = createMlClient({ fetch: f.fn, getToken: async () => "T" });
    const r = await pushSellingAddress(client, "MLAU123456789", 9.6);
    expect(r).toEqual({ mode: "selling_address", attempts: 2, version: "8" });
    const putsCalls = f.calls.filter((c) => c.method === "PUT");
    expect(putsCalls.map((c) => c.headers["x-version"])).toEqual(["7", "8"]);
    expect(JSON.parse(putsCalls[1]!.body!)).toEqual({ quantity: 9 });
    expect(putsCalls[0]!.url).toBe("https://api.mercadolibre.com/user-products/MLAU123456789/stock/type/selling_address");
  });

  it("409 repetido se rinde como reintentable", async () => {
    const f = fakeFetch((c) => (c.method === "GET" ? [200, { locations: [] }, { "x-version": "1" }] : [409, {}]));
    const client = createMlClient({ fetch: f.fn, getToken: async () => "T" });
    await expect(pushSellingAddress(client, "MLAU1", 1, 3)).rejects.toMatchObject({ code: "conflict", retryable: true });
  });

  it("clásico con variaciones manda TODAS (las que faltan se borrarían)", async () => {
    const f = fakeFetch((c) => (c.method === "GET" ? [200, F.itemClassicWithVariations] : [200, {}]));
    const client = createMlClient({ fetch: f.fn, getToken: async () => "T" });
    await pushVariationQuantities(client, "MLA1500000002", new Map([["174997747230", 9]]));
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({
      variations: [
        { id: 174997747229, available_quantity: 3 },
        { id: 174997747230, available_quantity: 9 },
      ],
    });
  });
});

describe("worker", () => {
  function deps(handler: (c: Call) => [number, unknown, Record<string, string>?]) {
    const f = fakeFetch(handler);
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const answers: Record<string, unknown> = {};
    const d: JobDeps = {
      rpc: async (fn, args) => {
        rpcCalls.push({ fn, args });
        return answers[fn] ?? { ok: true, decision: "create_sale" };
      },
      client: () => createMlClient({ fetch: f.fn, getToken: async () => "T" }),
      postForm: async () => ({ ids: ["FD-1"] }),
      rand: () => 0.5,
    };
    return { d, f, rpcCalls, answers };
  }

  it("orders_v2 de un carrito: lee el pack, sus órdenes, facturación y envío y llama UNA vez a ml_ingest_pack", async () => {
    const { d, f, rpcCalls } = deps((c) => {
      if (c.url.includes("/orders/2000003508419013/billing_info")) return [404, {}];
      if (c.url.includes("/orders/billing-info/MLA/BI-777")) return [200, F.billingNewCuit];
      if (c.url.endsWith("/orders/2000003508419013")) return [200, order2(2000003508419013)];
      if (c.url.endsWith("/orders/2000003508419014")) return [200, order2(2000003508419014)];
      if (c.url.endsWith("/packs/2000000099999")) return [200, { id: 2000000099999, orders: [{ id: 2000003508419013 }, { id: 2000003508419014 }] }];
      if (c.url.includes("/shipments/40123456789")) return [200, F.shipmentNew];
      return [404, {}];
    });
    const out = await processNotification(d, { id: "n1", account_id: "acc", tenant_id: "t", topic: "orders_v2", resource: "/orders/2000003508419013", tries: 1 });
    expect(out).toEqual({ status: "done", note: "create_sale" });
    const ingest = rpcCalls.filter((r) => r.fn === "ml_ingest_pack");
    expect(ingest).toHaveLength(1);
    const p = ingest[0]!.args.p as { pack_key: string; orders: unknown[]; billing: { docType: string } };
    expect(p.pack_key).toBe("2000000099999");
    expect(p.orders).toHaveLength(2);
    expect(p.billing.docType).toBe("cuit");
    expect(f.calls.find((c) => c.url.includes("/shipments/"))!.headers["x-format-new"]).toBe("true");
    expect(rpcCalls.some((r) => r.fn === "ml_shipment_upsert")).toBe(true);
  });

  it("un tópico fuera del MVP se ignora y un 429 se reprograma sin gastar intento", async () => {
    const { d } = deps(() => [429, { error: "local_rate_limited" }, { "retry-after": "3" }]);
    expect(await processNotification(d, { id: "n", account_id: "a", tenant_id: "t", topic: "messages", resource: "/messages/abc-123", tries: 1 })).toEqual({
      status: "ignored",
      note: "topic_not_in_mvp",
    });
    expect(await processNotification(d, { id: "n", account_id: "a", tenant_id: "t", topic: "questions", resource: "/questions/12345", tries: 1 })).toEqual({
      status: "retry",
      error: expect.any(String),
      retryMs: 3000,
    });
    expect(outcomeOf(new MlApiError("invalid_grant", "x", 400, false), 1).status).toBe("error");
  });

  it("stock_push: valor absoluto del snapshot por PUT /items", async () => {
    const { d, f, answers } = deps(() => [200, {}]);
    answers.ml_item_stock_snapshot = {
      ml_item_id: "MLA1500000001",
      user_product_id: null,
      stock_mode: "item",
      has_variations: false,
      push_enabled: true,
      links: [{ ml_variation_id: null, qty: 4 }],
    };
    const r = await processJob(d, { id: "j", account_id: "a", tenant_id: "t", kind: "stock_push", ref: null, payload: { item_id: "row" }, attempts: 1, max_attempts: 8 });
    expect(r).toEqual({ status: "done" });
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://api.mercadolibre.com/items/MLA1500000001");
    expect(JSON.parse(put.body!)).toEqual({ available_quantity: 4 });
  });

  it("price_push respeta la automatización de precios de ML (400) y no pelea", async () => {
    const { d, rpcCalls, answers } = deps(() => [400, { message: "Item has an active price automation", error: "validation_error" }]);
    answers.ml_item_price_snapshot = { ml_item_id: "MLA1", price_source: "pos", has_variations: false, push_enabled: true, links: [{ ml_variation_id: null, price: 1999 }] };
    const r = await processJob(d, { id: "j", account_id: "a", tenant_id: "t", kind: "price_push", ref: null, payload: { item_id: "row" }, attempts: 1, max_attempts: 8 });
    expect(r).toEqual({ status: "done", note: "price_automation" });
    expect(rpcCalls.find((c) => c.fn === "ml_item_pushed")!.args.p).toMatchObject({ price_source: "automation" });
  });

  it("invoice_upload: arma el PDF (< 1 MB) y lo sube al pack", async () => {
    const { d, rpcCalls, answers } = deps(() => [200, {}]);
    answers.ml_invoice_pdf_data = invoiceData();
    let path = "";
    let file: Blob | null = null;
    d.postForm = async (_a, p, form) => {
      path = p;
      file = form.get("fiscal_document") as Blob;
      return { ids: ["FD-9"] };
    };
    const r = await processJob(d, { id: "j", account_id: "a", tenant_id: "t", kind: "invoice_upload", ref: "2000000099999", payload: { fiscal_document_id: "doc", pack_key: "2000000099999" }, attempts: 1, max_attempts: 8 });
    expect(r).toEqual({ status: "done" });
    expect(path).toBe("/packs/2000000099999/fiscal_documents");
    expect(file!.type).toBe("application/pdf");
    expect(file!.size).toBeLessThan(1_000_000);
    expect(rpcCalls.find((c) => c.fn === "ml_invoice_uploaded")!.args).toMatchObject({ p_ok: true, p_ml_id: "FD-9" });
  });
});

function invoiceData() {
  return {
    emitter: { name: "Ninja Test SRL", cuit: "30712345678", ivaCondition: "responsable_inscripto", address: "Calle 1, CABA" },
    doc: {
      letter: "A", cbteTipo: 1, label: "FACTURA", ptoVta: 3, nro: 125, fecha: "2026-10-13", cae: "76123456789012",
      caeVto: "2026-10-23", qrUrl: "https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9", total: 3630, netTaxed: 3000, iva: 630, otherTaxes: 0,
    },
    receptor: { name: "Pérez SRL", docType: "cuit", docNumber: "20123456786", ivaCondition: "responsable_inscripto", address: null },
    items: Array.from({ length: 30 }, (_, i) => ({ description: `Producto ${i} con ñ y acentos`, qty: 1, unitPrice: 121, subtotal: 121 })),
    notes: "Venta en Mercado Libre 2000000099999",
  };
}

describe("PDF de la factura y etiquetas", () => {
  it("PDF válido con CAE, QR y varias hojas", () => {
    const pdf = buildInvoicePdf(invoiceData());
    const txt = new TextDecoder("latin1").decode(pdf);
    expect(txt.startsWith("%PDF-1.4")).toBe(true);
    expect(txt).toMatch(/CAE N\xB0: 76123456789012/);
    expect(txt).toMatch(/\/Count 2/);
    expect(txt).toMatch(/startxref\n\d+\n%%EOF/);
    expect(pdf.length).toBeLessThan(1_000_000);
  });
  it("el QR de las Edge es copia exacta de lib/qr/qrcode.ts", () => {
    const a = readFileSync(join(process.cwd(), "lib", "qr", "qrcode.ts"), "utf8");
    const b = readFileSync(join(process.cwd(), "supabase", "functions", "_shared", "mercadolibre", "qrcode.ts"), "utf8");
    expect(b).toBe(a);
  });
  it("ZPL directo o dentro de un ZIP", async () => {
    expect(await extractZpl(new TextEncoder().encode("^XA^FDHola^FS^XZ"))).toBe("^XA^FDHola^FS^XZ");
    const zpl = new TextEncoder().encode("^XA^FDEtiqueta^FS^XZ");
    const name = new TextEncoder().encode("Etiqueta de envio.txt");
    const hdr = new Uint8Array(30);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(18, zpl.length, true);
    dv.setUint32(22, zpl.length, true);
    dv.setUint16(26, name.length, true);
    const zip = new Uint8Array([...hdr, ...name, ...zpl]);
    expect(await extractZpl(zip, async (d) => new Uint8Array(inflateRawSync(d)))).toBe("^XA^FDEtiqueta^FS^XZ");
  });
});

describe("migraciones y deploy", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.startsWith("2026111040"));
  const sql = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  it("feature OPTIONAL desde Pro con gating en el medio de cobro", () => {
    expect(sql).toMatch(/'mercadolibre', 'Mercado Libre'[\s\S]*'integraciones', false/);
    expect(sql).toMatch(/'mercadolibre', \(p\.key in \('pro', 'business', 'enterprise'\)\)/);
    expect(sql).toMatch(/when 'mercadolibre'\s+then 'mercadolibre'/);
  });
  it("tokens y estados OAuth sin acceso de clientes; sin OR is_internal()", () => {
    expect(sql).toMatch(/revoke all on ml_tokens, ml_oauth_states, ml_rate_buckets from anon, authenticated/);
    expect(sql).not.toMatch(/using \([^;]*or\s+is_internal\(\)/i);
    expect(sql).toMatch(/\(select current_tenant_id\(\)\)/);
  });
  it("la venta de ML no mueve caja y no recrea create_sale", () => {
    const rpc = readFileSync(join(dir, "20261110400200_mercadolibre_rpc.sql"), "utf8");
    const ingest = rpc.slice(rpc.indexOf("create or replace function ml_ingest_pack"), rpc.indexOf("-- H) Facturación"));
    expect(ingest).not.toMatch(/cash_movements/);
    expect(ingest).toMatch(/'mercadolibre', v_total/);
    expect(sql).not.toMatch(/function public\.create_sale/);
  });
  it("las Edge públicas están declaradas", () => {
    expect(PUBLIC_FUNCTIONS).toEqual(expect.arrayContaining(["ml_webhook", "ml_oauth_callback"]));
    const toml = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
    expect(toml).toMatch(/\[functions\.ml_webhook\]\nverify_jwt = false/);
  });
});

describe("UI: mensajes, etiquetas y feature", () => {
  it("errores del servidor con mensaje claro", async () => {
    const { mlErrorMessage, orderNet, LOGISTIC_LABELS, INVOICE_MODE_LABELS } = await import("@/lib/mercadolibre/labels");
    expect(mlErrorMessage({ error: "ml_app_not_configured" })).toMatch(/Falta configurar la app de Mercado Libre/);
    expect(mlErrorMessage(new Error("feature_not_in_plan: mercadolibre"))).toMatch(/plan/);
    expect(mlErrorMessage({ error: "ml_account_taken" })).toMatch(/otro negocio/);
    expect(mlErrorMessage("invalid_grant")).toMatch(/reconect/);
    expect(orderNet(3000, 391, 450.5)).toBe(2158.5);
    expect(LOGISTIC_LABELS.self_service).toBe("Flex");
    expect(LOGISTIC_LABELS.fulfillment).toBe("Full");
    expect(INVOICE_MODE_LABELS.on_paid).toBeTruthy();
  });
  it("feature OPTIONAL desde Pro con copy y medio de cobro con etiqueta", async () => {
    const { FEATURE_INFO } = await import("@/lib/saas/featureInfo");
    const { PAYMENT_METHOD_LABELS } = await import("@/lib/utils/paymentMethods");
    expect(FEATURE_INFO.mercadolibre?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.mercadolibre?.impact).toMatch(/servidor/);
    expect(PAYMENT_METHOD_LABELS.mercadolibre).toBe("Mercado Libre");
  });
});
