// @vitest-environment node
// Portal público de la API (ADR-163, H68b): sandbox con dataset ficticio que
// cubre los 10 endpoints del spec, decisión demo / prueba propia / producción
// rechazada, límite por IP, documentación HTML autocontenida y envío por
// email auditado (migración).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const forwarded = vi.hoisted(() => ({ calls: [] as { url: string; method: string; auth: string | null; body: string }[] }));

function fakeHandler() {
  return async (req: Request) => {
    forwarded.calls.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body: await req.text() });
    return new Response(JSON.stringify({ forwarded: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

vi.mock("@/app/api/v1/oauth/token/route", () => ({ POST: fakeHandler() }));
vi.mock("@/app/api/v1/products/route", () => ({ GET: fakeHandler() }));
vi.mock("@/app/api/v1/products/batch/route", () => ({ POST: fakeHandler() }));
vi.mock("@/app/api/v1/prices/batch/route", () => ({ POST: fakeHandler() }));
vi.mock("@/app/api/v1/stores/route", () => ({ GET: fakeHandler() }));
vi.mock("@/app/api/v1/stock/route", () => ({ GET: fakeHandler() }));
vi.mock("@/app/api/v1/stock/adjustments/route", () => ({ POST: fakeHandler() }));
vi.mock("@/app/api/v1/sales/route", () => ({ GET: fakeHandler() }));
vi.mock("@/app/api/v1/customers/route", () => ({ GET: fakeHandler() }));
vi.mock("@/app/api/v1/customers/batch/route", () => ({ POST: fakeHandler() }));

import { API_SCOPES } from "@/lib/api-publica/scopes";
import { isDevelopersPath, isPublicApiPath } from "@/lib/api-publica/paths";
import { ENDPOINTS } from "@/lib/api/spec";
import {
  DEMO_CLIENT_ID,
  DEMO_CLIENT_SECRET,
  DEMO_ENDPOINT_IDS,
  SANDBOX_BASE_PATH,
  demoToken,
  demoTokenScopes,
  handleDemo,
  isDemoToken,
  sandboxDecision,
  simulatedId,
  type DemoRequest,
} from "@/lib/api/sandboxDemo";
import { DEMO_CUSTOMERS, DEMO_PRODUCTS, DEMO_SALES } from "@/lib/api/sandboxDataset";
import { IpRateLimiter, clientIp } from "@/lib/api/ipRateLimit";
import { buildDocsHtml, escapeHtml } from "@/lib/api/docsHtml";
import { buildPostmanCollection } from "@/lib/api/postman";
import { tryUrl } from "@/lib/api/tryit";
import * as sandboxRoute from "@/app/api/sandbox/v1/[...path]/route";
import * as docsRoute from "@/app/api/docs/html/route";

const ROOT = path.resolve(__dirname, "..", "..");
const ALL = demoToken(API_SCOPES);

function req(method: string, p: string, opts: { token?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): DemoRequest {
  const h = new Headers(opts.headers);
  if (opts.token) h.set("authorization", `Bearer ${opts.token}`);
  if (opts.body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  return {
    method,
    path: p,
    query: new URLSearchParams(opts.query),
    headers: h,
    body: opts.body === undefined ? "" : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  };
}

const body = (r: { body: unknown }) => r.body as Record<string, any>;

describe("sandbox público: cobertura del spec", () => {
  it("responde todos los endpoints del spec y nada más", () => {
    expect([...DEMO_ENDPOINT_IDS].sort()).toEqual(ENDPOINTS.map((e) => e.id).sort());
  });

  it("el módulo no habla con Supabase ni con la red", () => {
    for (const f of ["lib/api/sandboxDemo.ts", "lib/api/sandboxDataset.ts", "lib/api/sandboxConstants.ts"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "");
      expect(src).not.toMatch(/supabase|fetch\(|service_role/i);
    }
  });

  it("el dataset es ficticio: emails .example y sin tenant_id", () => {
    for (const c of DEMO_CUSTOMERS) if (c.email) expect(c.email).toMatch(/\.example$/);
    const all = JSON.stringify([DEMO_PRODUCTS, DEMO_CUSTOMERS, DEMO_SALES]);
    expect(all).not.toMatch(/tenant_id/);
  });

  it("los ejemplos de cuerpo del spec funcionan contra el dataset (200 con dry_run)", () => {
    for (const e of ENDPOINTS.filter((x) => x.response.shape === "batch")) {
      const r = handleDemo(req("POST", e.path, { token: ALL, body: e.body!.example }));
      expect(r.status, e.id).toBe(200);
      const b = body(r);
      expect(b.dry_run).toBe(true);
      const total = Object.values(b.summary as Record<string, number>).reduce((a, n) => a + n, 0);
      expect(total).toBe((e.body!.example as { items: unknown[] }).items.length);
      expect(r.headers["X-Ninja-Environment"]).toBe("test");
    }
  });

  it("las lecturas con los parámetros de ejemplo devuelven datos", () => {
    for (const e of ENDPOINTS.filter((x) => x.method === "GET")) {
      const query: Record<string, string> = {};
      for (const p of e.params) if (p.in === "query" && p.required) query[p.name] = String(p.example);
      const r = handleDemo(req("GET", e.path, { token: ALL, query }));
      expect(r.status, e.id).toBe(200);
      expect((body(r).data as unknown[]).length, e.id).toBeGreaterThan(0);
    }
  });

  it("es determinístico", () => {
    const a = handleDemo(req("POST", "/products/batch", { token: ALL, body: { items: [{ sku: "NUEVO-1", name: "Nuevo" }] } }));
    const b = handleDemo(req("POST", "/products/batch", { token: ALL, body: { items: [{ sku: "NUEVO-1", name: "Nuevo" }] } }));
    expect(a.body).toEqual(b.body);
    expect(body(a).results[0].id).toBe(simulatedId("product", "NUEVO-1"));
  });
});

describe("sandbox público: token y alcances", () => {
  const tokenReq = (fields: Record<string, string>, headers?: Record<string, string>) =>
    handleDemo({
      method: "POST",
      path: "/oauth/token",
      query: new URLSearchParams(),
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded", ...headers }),
      body: new URLSearchParams(fields).toString(),
    });

  it("emite un token de prueba con las credenciales de ejemplo (cuerpo o Basic)", () => {
    const r = tokenReq({ grant_type: "client_credentials", client_id: DEMO_CLIENT_ID, client_secret: DEMO_CLIENT_SECRET });
    expect(r.status).toBe(200);
    expect(body(r).environment).toBe("test");
    expect(isDemoToken(body(r).access_token)).toBe(true);
    const basic = Buffer.from(`${DEMO_CLIENT_ID}:${DEMO_CLIENT_SECRET}`).toString("base64");
    expect(tokenReq({ grant_type: "client_credentials" }, { authorization: `Basic ${basic}` }).status).toBe(200);
  });

  it("errores OAuth: secreto incorrecto, grant_type y alcance inexistente", () => {
    expect(tokenReq({ grant_type: "client_credentials", client_id: DEMO_CLIENT_ID, client_secret: "nss_test_x" }).status).toBe(401);
    expect(body(tokenReq({ grant_type: "password", client_id: DEMO_CLIENT_ID, client_secret: DEMO_CLIENT_SECRET })).error).toBe(
      "unsupported_grant_type",
    );
    const bad = tokenReq({ grant_type: "client_credentials", client_id: DEMO_CLIENT_ID, client_secret: DEMO_CLIENT_SECRET, scope: "tenants:write" });
    expect(bad.status).toBe(400);
    expect(body(bad).error).toBe("invalid_scope");
  });

  it("un token acotado da insufficient_scope igual que producción", () => {
    const r = tokenReq({ grant_type: "client_credentials", client_id: DEMO_CLIENT_ID, client_secret: DEMO_CLIENT_SECRET, scope: "products:read" });
    const tok = body(r).access_token as string;
    expect(demoTokenScopes(tok)).toEqual(["products:read"]);
    expect(handleDemo(req("GET", "/products", { token: tok })).status).toBe(200);
    const denied = handleDemo(req("POST", "/products/batch", { token: tok, body: { items: [{ sku: "X" }] } }));
    expect(denied.status).toBe(403);
    expect(body(denied).error.code).toBe("insufficient_scope");
  });

  it("sin token o con un token que no es de ejemplo: 401", () => {
    expect(handleDemo(req("GET", "/stores")).status).toBe(401);
    expect(handleDemo(req("GET", "/stores", { token: `nsat_test_${"a".repeat(64)}` })).status).toBe(401);
  });

  it("404 y 405 con el formato de la API", () => {
    expect(handleDemo(req("GET", "/tenants", { token: ALL })).status).toBe(404);
    const r = handleDemo(req("DELETE", "/products", { token: ALL }));
    expect(r.status).toBe(405);
    expect(body(r).error.code).toBe("method_not_allowed");
  });
});

describe("sandbox público: lecturas", () => {
  it("productos: cursor, include_deleted y filtro por SKU", () => {
    const p1 = handleDemo(req("GET", "/products", { token: ALL, query: { limit: "3" } }));
    const b1 = body(p1);
    expect(b1.data).toHaveLength(3);
    expect(b1.next_cursor).toBeTruthy();
    const p2 = body(handleDemo(req("GET", "/products", { token: ALL, query: { limit: "500", cursor: b1.next_cursor } })));
    const seen = [...b1.data, ...p2.data].map((x: { id: string }) => x.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(DEMO_PRODUCTS.filter((x) => !x.deleted_at).length);
    expect(p2.next_cursor).toBeNull();
    const withDeleted = body(handleDemo(req("GET", "/products", { token: ALL, query: { include_deleted: "true" } })));
    expect(withDeleted.data).toHaveLength(DEMO_PRODUCTS.length);
    const one = body(handleDemo(req("GET", "/products", { token: ALL, query: { sku: "ALM-ARROZ-1KG" } })));
    expect(one.data).toHaveLength(1);
  });

  it("cursor inválido y campo desconocido", () => {
    expect(body(handleDemo(req("GET", "/products", { token: ALL, query: { cursor: "nope" } }))).error.code).toBe("invalid_cursor");
    expect(handleDemo(req("GET", "/products", { token: ALL, query: { tenant_id: "x" } })).status).toBe(422);
  });

  it("stock por sucursal y sucursal inexistente", () => {
    const north = body(handleDemo(req("GET", "/stock", { token: ALL, query: { store_id: "a1b2c3d4-0000-4000-8000-000000000002" } })));
    expect(north.data.every((r: { store_id: string }) => r.store_id === "a1b2c3d4-0000-4000-8000-000000000002")).toBe(true);
    const missing = handleDemo(req("GET", "/stock", { token: ALL, query: { store_id: "a1b2c3d4-0000-4000-8000-0000000000ff" } }));
    expect(missing.status).toBe(404);
  });

  it("ventas: rango y tope de 93 días", () => {
    const r = body(handleDemo(req("GET", "/sales", { token: ALL, query: { from: "2026-10-05T00:00:00-03:00", to: "2026-10-11T00:00:00-03:00" } })));
    expect(r.data.map((s: { number: number }) => s.number)).toEqual([1531, 1532]);
    expect(handleDemo(req("GET", "/sales", { token: ALL, query: { from: "2026-01-01T00:00:00Z", to: "2026-10-01T00:00:00Z" } })).status).toBe(422);
  });
});

describe("sandbox público: escrituras simuladas", () => {
  const post = (p: string, items: unknown[]) => body(handleDemo(req("POST", p, { token: ALL, body: { items } })));

  it("productos: alta, edición, sin cambios y errores por ítem", () => {
    const r = post("/products/batch", [
      { sku: "NUEVO-1", name: "Nuevo" },
      { sku: "NUEVO-2" },
      { sku: "ALM-ARROZ-1KG", price: 1790 },
      { sku: "ALM-FIDEOS-500", price: 1 },
      { sku: "OTRO", name: "Otro", barcode: "7790070012345" },
    ]);
    expect(r.results.map((x: { status: string; error?: string }) => x.error ?? x.status)).toEqual([
      "created",
      "name_required",
      "unchanged",
      "updated",
      "barcode_in_use",
    ]);
    expect(r.summary).toEqual({ created: 1, updated: 1, unchanged: 1, failed: 2 });
  });

  it("precios y stock", () => {
    expect(post("/prices/batch", [{ sku: "NO-EXISTE", price: 1 }]).results[0].error).toBe("product_not_found");
    const s = post("/stock/adjustments", [
      { sku: "ALM-ARROZ-1KG", qty: 5, reason: "purchase" },
      { sku: "ALM-ARROZ-1KG", store_id: "a1b2c3d4-0000-4000-8000-000000000002", mode: "set", qty: 18, reason: "count" },
      { sku: "REM-BASICA", qty: 1, reason: "purchase" },
      { sku: "ALM-YERBA-1KG", store_id: "a1b2c3d4-0000-4000-8000-0000000000ff", qty: 1, reason: "purchase" },
    ]);
    expect(s.results[0]).toMatchObject({ status: "adjusted", qty: 35, delta: 5 });
    expect(s.results[1]).toMatchObject({ status: "unchanged", qty: 18, delta: 0 });
    expect(s.results[2].error).toBe("variants_not_supported");
    expect(s.results[3].error).toBe("store_not_found");
  });

  it("clientes: por id, por external_id y conflictos", () => {
    const r = post("/customers/batch", [
      { id: "0f9d2c1a-7b3e-4c55-8f0a-0000000000ff", name: "X" },
      { id: "0f9d2c1a-7b3e-4c55-8f0a-000000000001", external_id: "ERP-000124" },
      { external_id: "ERP-NUEVO" },
      { external_id: "ERP-NUEVO-2", name: "Nuevo SA" },
      { external_id: "ERP-000123", phone: "+54 11 0000-0099" },
    ]);
    expect(r.results.map((x: { status: string; error?: string }) => x.error ?? x.status)).toEqual([
      "customer_not_found",
      "external_id_in_use",
      "name_required",
      "created",
      "updated",
    ]);
  });

  it("validación, Content-Type e Idempotency-Key como /api/v1", () => {
    expect(handleDemo(req("POST", "/products/batch", { token: ALL, body: { items: [{ sku: "A", tenant_id: "x" }] } })).status).toBe(422);
    expect(handleDemo(req("POST", "/products/batch", { token: ALL, body: "{", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect(
      handleDemo(req("POST", "/products/batch", { token: ALL, body: { items: [{ sku: "A" }] }, headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
    expect(
      handleDemo(req("POST", "/products/batch", { token: ALL, body: { items: [{ sku: "A" }] }, headers: { "idempotency-key": "x" } })).status,
    ).toBe(400);
  });
});

describe("sandbox público: qué se responde, qué se pasa y qué se rechaza", () => {
  const live = `nsat_${"a".repeat(64)}`;
  const test = `nsat_test_${"a".repeat(64)}`;

  it("decisión por prefijo de la credencial", () => {
    expect(sandboxDecision(req("GET", "/products", { token: ALL })).kind).toBe("demo");
    expect(sandboxDecision(req("GET", "/products")).kind).toBe("demo");
    expect(sandboxDecision(req("GET", "/products", { token: test })).kind).toBe("forward");
    const rej = sandboxDecision(req("GET", "/products", { token: live }));
    expect(rej.kind).toBe("reject");
    const tok = (id: string, secret: string) =>
      sandboxDecision({
        method: "POST",
        path: "/oauth/token",
        headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString(),
      });
    expect(tok(DEMO_CLIENT_ID, DEMO_CLIENT_SECRET).kind).toBe("demo");
    expect(tok(`nsc_test_${"b".repeat(24)}`, `nss_test_${"c".repeat(64)}`).kind).toBe("forward");
    expect(tok(`nsc_${"b".repeat(24)}`, `nss_${"c".repeat(64)}`).kind).toBe("reject");
    // Prefijos cruzados: client de prueba con secreto de producción.
    expect(tok(`nsc_test_${"b".repeat(24)}`, `nss_${"c".repeat(64)}`).kind).toBe("reject");
  });

  describe("ruta /api/sandbox/v1", () => {
    beforeEach(() => {
      forwarded.calls.length = 0;
    });
    let ipSeq = 0;
    const call = (method: "GET" | "POST", p: string, init: { headers?: Record<string, string>; body?: string; ip?: string } = {}) => {
      const ip = init.ip ?? `10.0.0.${++ipSeq}`;
      const r = new Request(`https://pos.soft.ninja${SANDBOX_BASE_PATH}${p}`, {
        method,
        headers: { "x-forwarded-for": ip, ...init.headers },
        body: init.body,
      });
      const segs = p.split("?")[0]!.replace(/^\//, "").split("/");
      return (method === "GET" ? sandboxRoute.GET : sandboxRoute.POST)(r, { params: { path: segs } });
    };

    it("datos ficticios sin tocar /api/v1", async () => {
      const res = await call("GET", "/stores", { headers: { authorization: `Bearer ${ALL}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ninja-dataset")).toBe("demo");
      expect(res.headers.get("ratelimit-limit")).toBe("60");
      expect(forwarded.calls).toHaveLength(0);
    });

    it("credencial de prueba propia: pasa a /api/v1 con el mismo pedido", async () => {
      const res = await call("GET", "/products?limit=5", { headers: { authorization: `Bearer ${test}` } });
      expect(res.status).toBe(200);
      expect(forwarded.calls).toHaveLength(1);
      expect(forwarded.calls[0]!.url).toBe("https://pos.soft.ninja/api/v1/products?limit=5");
      expect(forwarded.calls[0]!.auth).toBe(`Bearer ${test}`);
    });

    it("credencial de producción: rechazada sin llegar a /api/v1", async () => {
      const res = await call("GET", "/products", { headers: { authorization: `Bearer ${live}` } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("sandbox_only");
      const tok = await call("POST", "/oauth/token", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=client_credentials&client_id=nsc_${"b".repeat(24)}&client_secret=nss_${"c".repeat(64)}`,
      });
      expect(tok.status).toBe(401);
      expect(forwarded.calls).toHaveLength(0);
    });

    it("límite por IP: 429 con Retry-After", async () => {
      let last: Response | null = null;
      for (let i = 0; i < 61; i++) last = await call("GET", "/stores", { ip: "203.0.113.7", headers: { authorization: `Bearer ${ALL}` } });
      expect(last!.status).toBe(429);
      expect(last!.headers.get("retry-after")).toBeTruthy();
      const other = await call("GET", "/stores", { ip: "203.0.113.8", headers: { authorization: `Bearer ${ALL}` } });
      expect(other.status).toBe(200);
    });
  });
});

describe("límite por IP", () => {
  it("cuenta por IP y descarta las viejas con tope de memoria", () => {
    const l = new IpRateLimiter(2);
    const t = 1_700_000_000_000;
    expect(l.hit("a", t).allowed).toBe(true);
    expect(l.hit("a", t).allowed).toBe(true);
    expect(l.hit("a", t).allowed).toBe(false);
    expect(l.hit("b", t).allowed).toBe(true);
  });

  it("toma la primera IP de x-forwarded-for", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("documentación HTML y descargas", () => {
  const html = buildDocsHtml({ origin: "https://pos.soft.ninja", generatedAt: new Date("2026-10-15T12:00:00Z") });

  it("trae todos los endpoints, errores y el sandbox público", () => {
    for (const e of ENDPOINTS) {
      expect(html).toContain(`id="${e.id}"`);
      expect(html).toContain(`/api/v1${e.path}`);
    }
    expect(html).toContain("validation_error");
    expect(html).toContain(DEMO_CLIENT_ID);
    expect(html).toContain("https://pos.soft.ninja/api/sandbox/v1");
  });

  it("es autocontenido: sin scripts, estilos ni imágenes externas", () => {
    expect(html).not.toMatch(/<script[^>]*src=|<link\s|<img\s|@import|url\(/i);
    expect(html).toMatch(/@media print/);
    expect(html).not.toContain("<script>");
    expect(buildDocsHtml({ origin: "https://x.example", autoPrint: true })).toContain("window.print()");
  });

  it("escapa todo lo que viene del spec", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(html).not.toMatch(/<code>\{[^<]*"[^<]*<\/code>/);
  });

  it("la ruta sirve el HTML y lo adjunta con ?download=1", async () => {
    const inline = docsRoute.GET(new Request("https://pos.soft.ninja/api/docs/html"));
    expect(inline.headers.get("content-type")).toMatch(/text\/html/);
    expect(inline.headers.get("content-disposition")).toBeNull();
    const dl = docsRoute.GET(new Request("https://pos.soft.ninja/api/docs/html?download=1"));
    expect(dl.headers.get("content-disposition")).toMatch(/attachment; filename="ninjasoft-api-v1\.html"/);
    const pr = await docsRoute.GET(new Request("https://pos.soft.ninja/api/docs/html?print=1")).text();
    expect(pr).toContain("window.print()");
  });

  it("Postman del sandbox público: base y credenciales de ejemplo", () => {
    const c = buildPostmanCollection({
      origin: "https://pos.soft.ninja",
      basePath: SANDBOX_BASE_PATH,
      clientId: DEMO_CLIENT_ID,
      clientSecret: DEMO_CLIENT_SECRET,
      environment: "test",
      demo: true,
      id: "x",
    }) as { variable: { key: string; value: string }[]; info: { name: string } };
    const v = Object.fromEntries(c.variable.map((x) => [x.key, x.value]));
    expect(v.base_url).toBe("https://pos.soft.ninja/api/sandbox/v1");
    expect(v.client_id).toBe(DEMO_CLIENT_ID);
    expect(c.info.name).toMatch(/sandbox público/);
  });

  it("Probar apunta a la base que se le pasa", () => {
    const e = ENDPOINTS.find((x) => x.id === "stores.list")!;
    expect(tryUrl(e, {}, SANDBOX_BASE_PATH)).toBe("/api/sandbox/v1/stores");
    expect(tryUrl(e, {})).toBe("/api/v1/stores");
  });
});

describe("rutas sin sesión", () => {
  it("el middleware deja pasar el sandbox, el HTML y /developers", () => {
    expect(isPublicApiPath("/api/sandbox/v1/products")).toBe(true);
    expect(isPublicApiPath("/api/docs/html")).toBe(true);
    expect(isPublicApiPath("/api/sandboxx")).toBe(false);
    expect(isDevelopersPath("/developers")).toBe(true);
    expect(isDevelopersPath("/developersx")).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, "lib", "supabase", "middleware.ts"), "utf8")).toMatch(/isDevelopersPath\(pathname\)/);
  });

  it("la página pública existe y usa el sandbox público", () => {
    const page = fs.readFileSync(path.join(ROOT, "app", "(public)", "developers", "page.tsx"), "utf8");
    expect(page).toMatch(/PublicDevelopers/);
    const comp = fs.readFileSync(path.join(ROOT, "components", "integrations", "api", "PublicDevelopers.tsx"), "utf8");
    expect(comp).toMatch(/basePath=\{SANDBOX_BASE_PATH\}/);
    expect(comp).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("migración 20270101100000_api_sandbox_publico", () => {
  const MIG = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20270101100000_api_sandbox_publico.sql"), "utf8");
  const code = MIG.replace(/--.*$/gm, "");

  it("sólo el dueño, por el sistema de emails, auditado y con tope", () => {
    expect(code).toMatch(/_api_owner_assert\(false\)/);
    expect(code).toMatch(/perform enqueue_system_email\(/);
    expect(code).toMatch(/insert into audit_logs[\s\S]*'api_docs_emailed'/);
    expect(code).toMatch(/too_many_emails/);
    expect(code).toMatch(/_catalog_html\(v_note\)/);
    expect(code).toMatch(/revoke all on function api_docs_send_email\(text, text\) from public, anon;/);
    expect(code).toMatch(/grant execute on function api_docs_send_email\(text, text\) to authenticated;/);
  });

  it("no abre al staff con is_internal() ni crea tablas o policies", () => {
    expect(code).not.toMatch(/is_internal\(\)/);
    expect(code).not.toMatch(/create table|create policy/i);
  });
});
