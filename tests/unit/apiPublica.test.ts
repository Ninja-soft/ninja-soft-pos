// @vitest-environment node
// API pública v1 (ADR-094): validación, límite por cliente, hashing, cursor,
// rutas (nunca mandan el negocio) y guardas estáticas de las migraciones.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BATCH,
  customersUpsertSchema,
  pricesUpdateSchema,
  productsQuerySchema,
  productsUpsertSchema,
  salesQuerySchema,
  stockAdjustSchema,
  stockQuerySchema,
} from "@/lib/api-publica/schemas";
import { SlidingWindowLimiter, rateDecision, slidingEstimate, windowStart } from "@/lib/api-publica/rateLimit";
import {
  ACCESS_TOKEN_RE,
  CLIENT_ID_RE,
  CLIENT_SECRET_RE,
  parseBasic,
  parseBearer,
  secretHint,
  sha256Hex,
} from "@/lib/api-publica/hashing";
import { decodeIdCursor, decodeKeyset, encodeIdCursor, encodeKeyset, nextCursor } from "@/lib/api-publica/cursor";
import { API_SCOPES, cleanScopes } from "@/lib/api-publica/scopes";
import { isPublicApiPath } from "@/lib/api-publica/paths";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const ROOT = path.resolve(__dirname, "..", "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");
const MIGS = ["20261109400000", "20261109400100", "20261109400200", "20261109400300"].map((p) => {
  const f = fs.readdirSync(MIG_DIR).find((x) => x.startsWith(p));
  if (!f) throw new Error(`falta la migración ${p}`);
  return { name: f, sql: fs.readFileSync(path.join(MIG_DIR, f), "utf8") };
});
const ALL = MIGS.map((m) => m.sql).join("\n");
const sqlOf = (prefix: string) => MIGS.find((m) => m.name.startsWith(prefix))!.sql;

const TOKEN = `nsat_${"a".repeat(64)}`;
const UUID_A = "11111111-1111-4111-8111-111111111111";

// ─────────────────────────────────────────────────────────────────────────────
describe("validación (Zod)", () => {
  it("productos: SKU obligatorio, lote de 1 a 500 y objetos estrictos", () => {
    expect(productsUpsertSchema.safeParse({ items: [{ sku: "A1", name: "Yerba", price: 10 }] }).success).toBe(true);
    expect(productsUpsertSchema.safeParse({ items: [] }).success).toBe(false);
    expect(productsUpsertSchema.safeParse({ items: [{ name: "Sin SKU" }] }).success).toBe(false);
    const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ sku: `S${i}` }));
    expect(productsUpsertSchema.safeParse({ items: big }).success).toBe(false);
    expect(productsUpsertSchema.safeParse({ items: big.slice(0, MAX_BATCH) }).success).toBe(true);
    // Un campo desconocido (p. ej. el negocio) nunca se ignora en silencio.
    expect(productsUpsertSchema.safeParse({ items: [{ sku: "A", tenant_id: UUID_A }] }).success).toBe(false);
    expect(productsUpsertSchema.safeParse({ tenant_id: UUID_A, items: [{ sku: "A" }] }).success).toBe(false);
  });

  it("productos: precios no negativos y sin repetidos de SKU ni código de barras", () => {
    expect(productsUpsertSchema.safeParse({ items: [{ sku: "A", price: -1 }] }).success).toBe(false);
    expect(productsUpsertSchema.safeParse({ items: [{ sku: "A" }, { sku: "A" }] }).success).toBe(false);
    expect(
      productsUpsertSchema.safeParse({ items: [{ sku: "A", barcode: "779" }, { sku: "B", barcode: "779" }] }).success,
    ).toBe(false);
    expect(productsUpsertSchema.safeParse({ items: [{ sku: "A", price: "10" }] }).success).toBe(false);
  });

  it("precios: price obligatorio", () => {
    expect(pricesUpdateSchema.safeParse({ items: [{ sku: "A", price: 100 }] }).success).toBe(true);
    expect(pricesUpdateSchema.safeParse({ items: [{ sku: "A" }] }).success).toBe(false);
    expect(pricesUpdateSchema.safeParse({ items: [{ sku: "A", price: 1 }, { sku: "A", price: 2 }] }).success).toBe(false);
  });

  it("stock: motivo obligatorio, delta distinto de 0 y conteo no negativo", () => {
    const ok = stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 5, reason: "purchase" }] });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.items[0]!.mode).toBe("delta");
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 5 }] }).success).toBe(false);
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 0, reason: "loss" }] }).success).toBe(false);
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: -1, mode: "set", reason: "count" }] }).success).toBe(false);
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 0, mode: "set", reason: "count" }] }).success).toBe(true);
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 1, reason: "sale" }] }).success).toBe(false);
    expect(stockAdjustSchema.safeParse({ items: [{ sku: "A", qty: 1, reason: "loss", store_id: "x" }] }).success).toBe(false);
  });

  it("clientes: id o external_id, enums fiscales y sin repetidos", () => {
    expect(customersUpsertSchema.safeParse({ items: [{ external_id: "E1", name: "Ana" }] }).success).toBe(true);
    expect(customersUpsertSchema.safeParse({ items: [{ id: UUID_A, phone: "11" }] }).success).toBe(true);
    expect(customersUpsertSchema.safeParse({ items: [{ name: "Sin clave" }] }).success).toBe(false);
    expect(customersUpsertSchema.safeParse({ items: [{ external_id: "E1", document_type: "rut" }] }).success).toBe(false);
    expect(
      customersUpsertSchema.safeParse({ items: [{ external_id: "E1" }, { external_id: "E1" }] }).success,
    ).toBe(false);
  });

  it("consultas: límites, fechas ISO y rango de ventas de hasta 93 días", () => {
    expect(productsQuerySchema.safeParse({ limit: "100" }).success).toBe(true);
    expect(productsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(productsQuerySchema.safeParse({ updated_since: "ayer" }).success).toBe(false);
    expect(productsQuerySchema.safeParse({ tenant_id: UUID_A }).success).toBe(false);
    expect(salesQuerySchema.safeParse({ from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" }).success).toBe(true);
    expect(salesQuerySchema.safeParse({ from: "2026-10-31T00:00:00Z", to: "2026-10-01T00:00:00Z" }).success).toBe(false);
    expect(salesQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }).success).toBe(false);
    const s = stockQuerySchema.safeParse({ sku: "A, B,,C" });
    expect(s.success && s.data.sku).toEqual(["A", "B", "C"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("límite por cliente (ventana deslizante)", () => {
  it("pondera la ventana anterior por lo que falta del minuto", () => {
    expect(slidingEstimate(100, 10, 0)).toBe(110);
    expect(slidingEstimate(100, 10, 0.5)).toBe(60);
    expect(slidingEstimate(100, 10, 1)).toBe(10);
  });

  it("decide con el pedido actual incluido y calcula Retry-After", () => {
    expect(rateDecision({ prev: 0, current: 10, elapsedFraction: 0.2, limit: 10 })).toMatchObject({ allowed: true, remaining: 0 });
    const no = rateDecision({ prev: 0, current: 11, elapsedFraction: 0.5, limit: 10 });
    expect(no.allowed).toBe(false);
    expect(no.retryAfter).toBe(30);
  });

  it("el simulador frena al pasar el límite y libera al correr la ventana", () => {
    const lim = new SlidingWindowLimiter(5);
    const t0 = windowStart(Date.UTC(2026, 9, 13, 12, 0, 0)) + 1_000;
    for (let i = 0; i < 5; i++) expect(lim.hit(t0 + i).allowed).toBe(true);
    expect(lim.hit(t0 + 10).allowed).toBe(false);
    // Lo rechazado no cuenta: a mitad del minuto siguiente la anterior pesa 2,5.
    expect(lim.hit(t0 + 60_000 + 29_000).allowed).toBe(true);
    expect(lim.hit(t0 + 60_000 + 29_001).allowed).toBe(true);
    expect(lim.hit(t0 + 60_000 + 29_002).allowed).toBe(false);
    // Dos minutos después no queda nada.
    expect(lim.hit(t0 + 180_000).allowed).toBe(true);
  });

  it("la base usa la misma fórmula", () => {
    const sql = sqlOf("20261109400200");
    expect(sql).toMatch(/coalesce\(v_prev, 0\) \* \(1 - v_elapsed\) \+ v_cur/);
    expect(sql).toMatch(/date_trunc\('minute', v_now\)/);
    // Lo rechazado se descuenta (sólo cuenta lo permitido).
    expect(sql).toMatch(/set hits = greatest\(w\.hits - 1, 0\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("hashing y formatos de credenciales", () => {
  it("sha256 hex igual al de la base (_api_sha256)", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sqlOf("20261109400100")).toMatch(/encode\(digest\(convert_to\(p, 'UTF8'\), 'sha256'\), 'hex'\)/);
  });

  it("formatos de client_id, secreto y token", () => {
    expect(CLIENT_ID_RE.test(`nsc_${"0".repeat(24)}`)).toBe(true);
    expect(CLIENT_SECRET_RE.test(`nss_${"f".repeat(64)}`)).toBe(true);
    expect(ACCESS_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(ACCESS_TOKEN_RE.test(`nsat_${"A".repeat(64)}`)).toBe(false);
    expect(secretHint(`nss_${"0".repeat(60)}beef`)).toBe("beef");
  });

  it("Bearer y Basic", () => {
    expect(parseBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseBearer(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseBearer("Bearer x")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    const b = Buffer.from("nsc_1:nss_2").toString("base64");
    expect(parseBasic(`Basic ${b}`)).toEqual({ clientId: "nsc_1", clientSecret: "nss_2" });
    expect(parseBasic("Basic !!!")).toBeNull();
  });

  it("la base nunca guarda el secreto ni el token en claro", () => {
    const cred = sqlOf("20261109400100");
    expect(cred).toMatch(/secret_hash\s+text not null/);
    expect(cred).not.toMatch(/\bclient_secret\s+text/);
    expect(cred).toMatch(/_api_sha256\(v_secret\)/);
    expect(sqlOf("20261109400200")).toMatch(/token_hash, scopes, expires_at\)\s+values \(v_client\.tenant_id, v_client\.id, _api_sha256\(v_token\)/);
    // El hash no se expone por REST (grants por columna).
    const grant = /grant select \(([^)]*)\)\s+on api_clients to authenticated/.exec(cred);
    expect(grant).not.toBeNull();
    expect(grant![1]).not.toMatch(/secret_hash/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("cursor", () => {
  it("ida y vuelta (fecha + id) e id solo", () => {
    const t = "2026-10-13T12:00:00.123456+00:00";
    expect(decodeKeyset(encodeKeyset(t, UUID_A))).toEqual({ t, id: UUID_A });
    expect(decodeIdCursor(encodeIdCursor(UUID_A))).toEqual({ id: UUID_A });
  });

  it("rechaza cursores manipulados", () => {
    expect(decodeKeyset("no-es-base64!")).toBeNull();
    expect(decodeKeyset(Buffer.from('{"t":"ayer","id":"x"}').toString("base64url"))).toBeNull();
    expect(decodeKeyset(Buffer.from("[1]").toString("base64url"))).toBeNull();
    expect(decodeIdCursor(Buffer.from('{"id":"; drop table"}').toString("base64url"))).toBeNull();
  });

  it("next de la base a cursor opaco", () => {
    expect(nextCursor(null, "updated_at")).toBeNull();
    const c = nextCursor({ updated_at: "2026-10-13T12:00:00+00:00", id: UUID_A }, "updated_at");
    expect(decodeKeyset(c!)).toEqual({ t: "2026-10-13T12:00:00+00:00", id: UUID_A });
    expect(decodeIdCursor(nextCursor({ id: UUID_A })!)).toEqual({ id: UUID_A });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("rutas /api/v1 (con la base simulada)", () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let reply: unknown = { status: 200, body: { data: [], next: null }, rate: { limit: 600, remaining: 599, reset: 30 } };

  beforeEach(() => {
    calls.length = 0;
    reply = { status: 200, body: { data: [], next: null }, rate: { limit: 600, remaining: 599, reset: 30 } };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: reply, error: null };
        },
      }),
    }));
  });

  it("sin Bearer responde 401 y no llama a la base", async () => {
    const { GET } = await import("@/app/api/v1/products/route");
    const res = await GET(new Request("https://x.test/api/v1/products"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(calls).toHaveLength(0);
  });

  it("lista: pasa el token y el cursor, nunca un negocio, y arma next_cursor", async () => {
    reply = {
      status: 200,
      body: { data: [{ id: UUID_A }], next: { updated_at: "2026-10-13T12:00:00+00:00", id: UUID_A } },
      rate: { limit: 600, remaining: 10, reset: 5 },
    };
    const { GET } = await import("@/app/api/v1/products/route");
    const res = await GET(
      new Request("https://x.test/api/v1/products?limit=1", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-remaining")).toBe("10");
    const body = (await res.json()) as { data: unknown[]; next_cursor: string };
    expect(decodeKeyset(body.next_cursor)).toEqual({ t: "2026-10-13T12:00:00+00:00", id: UUID_A });
    expect(calls[0]!.fn).toBe("api_v1_products_list");
    expect(calls[0]!.args.p_token).toBe(TOKEN);
    expect(Object.keys(calls[0]!.args).some((k) => /tenant/i.test(k))).toBe(false);
  });

  it("lote: 422 con detalles si el cuerpo no valida, 413 si es muy grande, 415 sin JSON", async () => {
    const { POST } = await import("@/app/api/v1/products/batch/route");
    const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const bad = await POST(new Request("https://x.test/api/v1/products/batch", { method: "POST", headers: h, body: '{"items":[{}]}' }));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("validation_error");
    const big = await POST(
      new Request("https://x.test/api/v1/products/batch", { method: "POST", headers: h, body: "x".repeat(1_048_577) }),
    );
    expect(big.status).toBe(413);
    const txt = await POST(
      new Request("https://x.test/api/v1/products/batch", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(txt.status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it("lote: manda items e Idempotency-Key y respeta el estado de la base (429 con Retry-After)", async () => {
    reply = {
      status: 429,
      body: { error: { code: "rate_limited", message: "x" } },
      rate: { limit: 10, remaining: 0, reset: 12, retry_after: 12 },
    };
    const { POST } = await import("@/app/api/v1/prices/batch/route");
    const res = await POST(
      new Request("https://x.test/api/v1/prices/batch", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "idempotency-key": "lote-0001" },
        body: JSON.stringify({ items: [{ sku: "A", price: 10 }] }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(calls[0]!.args).toEqual({ p_token: TOKEN, p_items: [{ sku: "A", price: 10 }], p_idempotency_key: "lote-0001" });
  });

  it("token: client_credentials por form o Basic; errores al estilo OAuth", async () => {
    reply = { status: 200, body: { access_token: TOKEN, token_type: "Bearer", expires_in: 3600, scope: "products:read" } };
    const { POST } = await import("@/app/api/v1/oauth/token/route");
    const ok = await POST(
      new Request("https://x.test/api/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials&client_id=nsc_1&client_secret=nss_2&scope=products:read",
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(calls[0]).toEqual({
      fn: "api_token_issue",
      args: { p_client_id: "nsc_1", p_client_secret: "nss_2", p_scope: "products:read" },
    });
    const grant = await POST(
      new Request("https://x.test/api/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=password",
      }),
    );
    expect(grant.status).toBe(400);
    expect(((await grant.json()) as { error: string }).error).toBe("unsupported_grant_type");
    reply = { status: 401, body: { error: { code: "invalid_client", message: "Credenciales inválidas." } } };
    const bad = await POST(
      new Request("https://x.test/api/v1/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from("nsc_1:mal").toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      }),
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid_client", error_description: "Credenciales inválidas." });
  });

  it("el middleware deja pasar /api/v1 sin sesión", () => {
    expect(isPublicApiPath("/api/v1/products")).toBe(true);
    expect(isPublicApiPath("/api/openapi.json")).toBe(true);
    expect(isPublicApiPath("/api/libro-iva")).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, "middleware.ts"), "utf8")).toMatch(/isPublicApiPath\(request\.nextUrl\.pathname\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("feature api_publica (CLAUDE.md §6)", () => {
  it("OPTIONAL sólo Enterprise, con copy", () => {
    const f = sqlOf("20261109400000");
    expect(f).toMatch(/'api_publica',[\s\S]*'integraciones', false, 210/);
    expect(f).toMatch(/'api_publica', \(p\.key = 'enterprise'\)/);
    expect(FEATURE_INFO.api_publica?.minPlan).toBe("Enterprise");
  });

  it("gating real: el token, cada llamada y la gestión exigen la feature", () => {
    expect(sqlOf("20261109400200").match(/tenant_has_feature_for\([^)]*'api_publica'\)/g)?.length).toBeGreaterThanOrEqual(2);
    const cred = sqlOf("20261109400100");
    for (const fn of ["api_client_create", "api_client_update", "api_client_rotate"]) {
      const body = new RegExp(`function ${fn}\\([\\s\\S]*?\\$\\$;`).exec(cred)![0];
      expect(body, fn).toMatch(/_api_owner_assert\(true\)/);
    }
    // Revocar siempre se puede (cortar acceso no depende del plan).
    expect(new RegExp("function api_client_revoke\\([\\s\\S]*?\\$\\$;").exec(cred)![0]).toMatch(/_api_owner_assert\(false\)/);
    expect(cred).toMatch(/coalesce\(member_role_in\(v_tenant\), ''\) <> 'owner'/);
  });

  it("los alcances del front son los de la base", () => {
    const m = /array\[([^\]]*)\]::text\[\]/.exec(sqlOf("20261109400100"))!;
    const sqlScopes = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(sqlScopes).toEqual([...API_SCOPES]);
    expect(cleanScopes(["sales:read", "products:read", "sales:read"])).toEqual(["products:read", "sales:read"]);
    expect(cleanScopes(["admin"])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("OpenAPI 3.1 (public/api/openapi.json)", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "api", "openapi.json"), "utf8")) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { securitySchemes: { oauth2: { flows: { clientCredentials: { scopes: Record<string, string> } } } } };
  };

  it("versión 3.1, alcances de la credencial y una ruta por cada route handler", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.components.securitySchemes.oauth2.flows.clientCredentials.scopes)).toEqual([...API_SCOPES]);
    const base = path.join(ROOT, "app", "api", "v1");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.ts") routes.push("/" + path.relative(base, dir).split(path.sep).join("/"));
      }
    };
    walk(base);
    const documented = routes.filter((r) => !r.includes("[...rest]")).sort();
    expect(documented).toEqual(Object.keys(spec.paths).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("migraciones: aislamiento y reglas del repo", () => {
  const v1 = sqlOf("20261109400300");
  const publicFns = [...v1.matchAll(/create or replace function (api_v1_[a-z_]+)\(/g)].map((m) => m[1]!);

  it("cada RPC pública autentica con su alcance y sólo se otorga a anon", () => {
    const expected: Record<string, string> = {
      api_v1_products_list: "products:read",
      api_v1_products_upsert: "products:write",
      api_v1_prices_update: "prices:write",
      api_v1_stores_list: "stock:read",
      api_v1_stock_list: "stock:read",
      api_v1_stock_adjust: "stock:write",
      api_v1_sales_list: "sales:read",
      api_v1_customers_list: "customers:read",
      api_v1_customers_upsert: "customers:write",
    };
    expect(publicFns.sort()).toEqual(Object.keys(expected).sort());
    for (const fn of publicFns) {
      const body = new RegExp(`function ${fn}\\([\\s\\S]*?\\$\\$;`).exec(v1)![0];
      expect(body, fn).toContain(`_api_auth(p_token, '${expected[fn]}')`);
      expect(body, fn).toMatch(/security definer/);
      // El negocio sale del token validado, no de un parámetro.
      expect(body.split("$$")[0], fn).not.toMatch(/p_tenant/);
      expect(v1, fn).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s+from public, authenticated;`));
      expect(v1, fn).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to anon;`));
    }
  });

  it("las funciones internas (con el negocio como parámetro) no se otorgan a nadie", () => {
    const internals = [...ALL.matchAll(/create or replace function (_api_[a-z0-9_]+)\(/g)].map((m) => m[1]!);
    expect(internals.length).toBeGreaterThan(10);
    for (const fn of new Set(internals)) {
      expect(ALL, fn).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated;`));
      expect(ALL, fn).not.toMatch(new RegExp(`grant execute on function ${fn}\\(`));
    }
  });

  it("toda lectura y escritura de las operaciones filtra por el negocio validado", () => {
    for (const t of ["products p", "customers c", "stores s", "product_stock ps", "sales x"]) {
      const re = new RegExp(`from ${t}\\b[\\s\\S]{0,200}?where`, "g");
      for (const m of v1.matchAll(re)) {
        const tail = v1.slice(m.index!, m.index! + m[0].length + 200);
        expect(tail, t).toMatch(/tenant_id = p_tenant/);
      }
    }
    for (const m of v1.matchAll(/^\s*update (products|customers) [a-z]\s*$/gm)) {
      const block = v1.slice(m.index!, m.index! + 900);
      expect(block, m[0]).toMatch(/\.tenant_id = p_tenant/);
    }
    // Inserts con tenant_id explícito (P8).
    for (const m of v1.matchAll(/insert into (products|customers|stock_movements|audit_logs) \(([^)]*)\)/g)) {
      expect(m[2], m[1]).toMatch(/tenant_id/);
    }
  });

  it("sin service_role, sin is_internal(), policies con (select ...) y sin create_sale", () => {
    const code = ALL.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/service_role/);
    expect(code).not.toMatch(/is_internal\(\)/);
    expect(code).not.toMatch(/create_sale/);
    for (const m of ALL.matchAll(/create policy [\s\S]*?;/g)) {
      expect(m[0]).not.toMatch(/(?<!select )current_tenant_id\(\)(?!\))/);
      expect(m[0]).toMatch(/\(select current_tenant_id\(\)\)/);
    }
  });

  it("gestión auditada y tokens cortados al rotar, revocar o quitar alcances", () => {
    const cred = sqlOf("20261109400100");
    for (const a of ["api_client_created", "api_client_updated", "api_client_rotated", "api_client_revoked"]) {
      expect(cred).toContain(`'${a}'`);
    }
    expect(cred.match(/update api_access_tokens t set revoked_at = now\(\)/g)?.length).toBe(3);
    expect(v1).toContain("'api_products_upserted'");
    expect(v1).toContain("'api_stock_adjusted'");
    expect(v1).toContain("'api_prices_updated'");
    expect(v1).toContain("'api_customers_upserted'");
  });

  it("FKs de las tablas nuevas con índice", () => {
    const cred = sqlOf("20261109400100");
    for (const idx of [
      "api_clients_tenant_idx",
      "api_clients_created_by_idx",
      "api_clients_revoked_by_idx",
      "api_access_tokens_client_idx",
      "api_access_tokens_tenant_idx",
      "api_rate_windows_tenant_idx",
      "api_idempotency_keys_tenant_idx",
    ]) {
      expect(cred).toContain(idx);
    }
  });
});
