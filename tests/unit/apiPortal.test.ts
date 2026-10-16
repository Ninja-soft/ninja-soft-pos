// @vitest-environment node
// Portal de la API pública (ADR-159, H68b): la fuente de verdad (lib/api/spec.ts)
// coincide con las rutas y los esquemas Zod reales, el OpenAPI y la colección
// de Postman se generan bien y sin secretos, y el sandbox hace dry_run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  customerItemSchema,
  customersQuerySchema,
  customersUpsertSchema,
  priceItemSchema,
  pricesUpdateSchema,
  productItemSchema,
  productsQuerySchema,
  productsUpsertSchema,
  salesQuerySchema,
  stockAdjustSchema,
  stockItemSchema,
  stockQuerySchema,
  tokenRequestSchema,
} from "@/lib/api-publica/schemas";
import { API_SCOPES } from "@/lib/api-publica/scopes";
import {
  ACCESS_TOKEN_RE,
  CLIENT_ID_RE,
  CLIENT_SECRET_RE,
  isSandboxClientId,
  isSandboxToken,
  parseBearer,
} from "@/lib/api-publica/hashing";
import { ENDPOINTS, ERRORS, MODELS, RESOURCES, findEndpoint, type EndpointSpec } from "@/lib/api/spec";
import { buildOpenApi, fieldSchema } from "@/lib/api/openapi";
import { buildPostmanCollection, POSTMAN_SCHEMA, postmanFileName } from "@/lib/api/postman";
import { pyLiteral, snippet, SNIPPET_LANGS } from "@/lib/api/snippets";
import { checkBody, checkSandboxCreds, initialQuery, maskToken, tryUrl } from "@/lib/api/tryit";

const ROOT = path.resolve(__dirname, "..", "..");
const V1 = path.join(ROOT, "app", "api", "v1");
const MIG = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20261228100000_api_portal_sandbox.sql"), "utf8");

const LIVE_ID = `nsc_${"a".repeat(24)}`;
const TEST_ID = `nsc_test_${"b".repeat(24)}`;
const TEST_SECRET = `nss_test_${"c".repeat(64)}`;
const LIVE_SECRET = `nss_${"d".repeat(64)}`;
const TEST_TOKEN = `nsat_test_${"e".repeat(64)}`;
const LIVE_TOKEN = `nsat_${"f".repeat(64)}`;

/** Forma (objeto) de un esquema Zod, atravesando refine / superRefine. */
function shapeOf(s: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  let cur = s as z.ZodTypeAny & { _def: { schema?: z.ZodTypeAny }; shape?: Record<string, z.ZodTypeAny> };
  while (!cur.shape && cur._def.schema) cur = cur._def.schema as typeof cur;
  if (!cur.shape) throw new Error("sin shape");
  return cur.shape;
}

function routeFile(e: EndpointSpec): string {
  return path.join(V1, ...e.path.replace(/^\//, "").split("/"), "route.ts");
}

// ─────────────────────────────────────────────────────────────────────────────
describe("spec: sólo endpoints que existen", () => {
  it("cada endpoint tiene su route handler con ese método", () => {
    for (const e of ENDPOINTS) {
      const f = routeFile(e);
      expect(fs.existsSync(f), `${e.method} ${e.path}`).toBe(true);
      expect(fs.readFileSync(f, "utf8"), `${e.method} ${e.path}`).toMatch(
        new RegExp(`export (async )?function ${e.method}\\b|export const ${e.method}\\b`),
      );
    }
  });

  it("cada route handler de /api/v1 está documentado (salvo el 404 genérico)", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.name === "route.ts") routes.push("/" + path.relative(V1, dir).split(path.sep).join("/"));
      }
    };
    walk(V1);
    const documented = new Set(ENDPOINTS.map((e) => e.path));
    expect(routes.filter((r) => !r.includes("[...rest]")).sort()).toEqual([...documented].sort());
  });

  it("ids únicos, recursos válidos, alcances reales y errores del catálogo", () => {
    expect(new Set(ENDPOINTS.map((e) => e.id)).size).toBe(ENDPOINTS.length);
    const resources = new Set(RESOURCES.map((r) => r.id));
    const codes = new Set(ERRORS.map((x) => x.code));
    for (const e of ENDPOINTS) {
      expect(resources.has(e.resource)).toBe(true);
      if (e.scope) expect(API_SCOPES).toContain(e.scope);
      for (const c of e.errors) expect(codes.has(c), `${e.id}: ${c}`).toBe(true);
      expect(MODELS[e.response.model]).toBeDefined();
    }
    expect(new Set(ERRORS.map((x) => x.code)).size).toBe(ERRORS.length);
  });

  it("no documenta webhooks ni recursos que la API no tiene", () => {
    const all = JSON.stringify(ENDPOINTS);
    expect(all).not.toMatch(/"\/webhooks|"\/variants|"\/price-lists|"\/invoices|"\/images/);
  });
});

describe("spec: campos iguales a los esquemas Zod", () => {
  const cases: [string, z.ZodTypeAny][] = [
    ["products.batch", productItemSchema],
    ["prices.batch", priceItemSchema],
    ["stock.adjustments", stockItemSchema],
    ["customers.batch", customerItemSchema],
  ];
  it.each(cases)("%s: campos del ítem y obligatorios", (id, schema) => {
    const e = findEndpoint(id)!;
    const shape = shapeOf(schema);
    expect(e.body!.itemFields!.map((f) => f.name).sort()).toEqual(Object.keys(shape).sort());
    for (const f of e.body!.itemFields!) {
      expect(Boolean(f.required), `${id}.${f.name}`).toBe(!shape[f.name]!.isOptional());
    }
  });

  const queries: [string, z.ZodTypeAny][] = [
    ["products.list", productsQuerySchema],
    ["customers.list", customersQuerySchema],
    ["stock.list", stockQuerySchema],
    ["sales.list", salesQuerySchema],
  ];
  it.each(queries)("%s: parámetros de la URL", (id, schema) => {
    const e = findEndpoint(id)!;
    const params = e.params.filter((p) => p.in === "query");
    const shape = shapeOf(schema);
    expect(params.map((p) => p.name).sort()).toEqual(Object.keys(shape).sort());
    for (const p of params) expect(Boolean(p.required), `${id}.${p.name}`).toBe(!shape[p.name]!.isOptional());
  });

  it("token: campos del cuerpo", () => {
    const e = findEndpoint("oauth.token")!;
    expect(e.body!.fields!.map((f) => f.name).sort()).toEqual(Object.keys(shapeOf(tokenRequestSchema)).sort());
  });

  it("los ejemplos de cuerpo y de query pasan la validación real", () => {
    expect(productsUpsertSchema.safeParse(findEndpoint("products.batch")!.body!.example).success).toBe(true);
    expect(pricesUpdateSchema.safeParse(findEndpoint("prices.batch")!.body!.example).success).toBe(true);
    expect(stockAdjustSchema.safeParse(findEndpoint("stock.adjustments")!.body!.example).success).toBe(true);
    expect(customersUpsertSchema.safeParse(findEndpoint("customers.batch")!.body!.example).success).toBe(true);
    const q = (id: string) =>
      Object.fromEntries(
        findEndpoint(id)!
          .params.filter((p) => p.in === "query" && p.example !== undefined)
          .map((p) => [p.name, String(p.example)]),
      );
    expect(productsQuerySchema.safeParse(q("products.list")).success).toBe(true);
    expect(customersQuerySchema.safeParse(q("customers.list")).success).toBe(true);
    expect(stockQuerySchema.safeParse(q("stock.list")).success).toBe(true);
    expect(salesQuerySchema.safeParse(q("sales.list")).success).toBe(true);
  });

  it("los ejemplos de respuesta traen los campos del modelo", () => {
    for (const e of ENDPOINTS) {
      const ex = e.response.example as Record<string, unknown>;
      const fields = MODELS[e.response.model].fields.map((f) => f.name);
      if (e.response.shape === "token") expect(Object.keys(ex).sort()).toEqual([...fields].sort());
      if (e.response.shape === "page" || e.response.shape === "data") {
        const row = (ex.data as Record<string, unknown>[])[0]!;
        expect(Object.keys(row).sort(), e.id).toEqual([...fields].sort());
      }
      if (e.response.shape === "batch") {
        expect(Object.keys(ex.summary as object).sort(), e.id).toEqual([...(e.response.summary ?? [])].sort());
        for (const r of ex.results as Record<string, unknown>[]) {
          for (const k of Object.keys(r)) expect(fields, `${e.id}.${k}`).toContain(k);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("OpenAPI 3.1", () => {
  const doc = buildOpenApi("https://pos.soft.ninja/") as {
    openapi: string;
    servers: { url: string }[];
    paths: Record<string, Record<string, { operationId: string; security: unknown[]; responses: Record<string, unknown> }>>;
    components: {
      schemas: Record<string, unknown>;
      securitySchemes: { oauth2: { flows: { clientCredentials: { tokenUrl: string; scopes: Record<string, string> } } } };
    };
  };

  it("versión, servidor, tokenUrl y alcances", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]!.url).toBe("https://pos.soft.ninja/api/v1");
    expect(doc.components.securitySchemes.oauth2.flows.clientCredentials.tokenUrl).toBe("https://pos.soft.ninja/api/v1/oauth/token");
    expect(Object.keys(doc.components.securitySchemes.oauth2.flows.clientCredentials.scopes)).toEqual([...API_SCOPES]);
  });

  it("una operación por endpoint con operationId único, seguridad y respuestas de error", () => {
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops).toHaveLength(ENDPOINTS.length);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    for (const o of ops) {
      expect(o.security.length).toBeGreaterThan(0);
      expect(Object.keys(o.responses).length).toBeGreaterThan(1);
    }
    expect(doc.paths["/products"]!.get!.security).toEqual([{ oauth2: ["products:read"] }]);
    for (const m of Object.keys(MODELS)) expect(doc.components.schemas[m]).toBeDefined();
  });

  it("nullable y enum en JSON Schema 2020-12", () => {
    expect(fieldSchema({ name: "x", type: "string", nullable: true, enum: ["a"], description: "d" })).toMatchObject({
      type: ["string", "null"],
      enum: ["a", null],
    });
  });

  it("sin secretos ni tokens reales", () => {
    const s = JSON.stringify(doc);
    expect(s).not.toMatch(/nss_(test_)?[0-9a-f]{64}/);
  });

  it("la ruta /api/openapi.json responde el documento con el origen del pedido", async () => {
    const { GET } = await import("@/app/api/openapi.json/route");
    const res = GET(new Request("https://demo.soft.ninja/api/openapi.json"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { servers: { url: string }[] };
    expect(body.servers[0]!.url).toBe("https://demo.soft.ninja/api/v1");
  });

  it("ya no hay un openapi.json estático que pise la ruta", () => {
    expect(fs.existsSync(path.join(ROOT, "public", "api", "openapi.json"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("colección de Postman v2.1", () => {
  type Item = { name: string; request: { method: string; url: { raw: string }; body?: { mode: string; raw?: string } }; event?: unknown[] };
  type Coll = {
    info: { schema: string; name: string; _postman_id: string };
    variable: { key: string; value: string; type: string }[];
    item: { name: string; item: Item[] }[];
    event: { listen: string; script: { exec: string[] } }[];
    auth: { type: string };
  };
  const vars = (c: Coll) => Object.fromEntries(c.variable.map((v) => [v.key, v.value]));

  it("esquema, carpetas por recurso y todos los endpoints", () => {
    const c = buildPostmanCollection({ origin: "https://pos.soft.ninja", id: "fixed" }) as unknown as Coll;
    expect(c.info.schema).toBe(POSTMAN_SCHEMA);
    expect(c.info._postman_id).toBe("fixed");
    expect(c.item.map((f) => f.name)).toEqual(RESOURCES.map((r) => r.title));
    const items = c.item.flatMap((f) => f.item);
    expect(items).toHaveLength(ENDPOINTS.length);
    for (const it of items) expect(it.request.url.raw.startsWith("{{base_url}}/")).toBe(true);
    expect(c.auth.type).toBe("bearer");
    expect(c.event[0]!.listen).toBe("prerequest");
    expect(c.event[0]!.script.exec.join("\n")).toMatch(/oauth\/token/);
    const token = items.find((i) => i.request.url.raw.endsWith("/oauth/token"))!;
    expect(token.event).toBeDefined();
  });

  it("variables precargadas: base_url y client_id; sin secreto si no se pasa", () => {
    const c = buildPostmanCollection({ origin: "https://pos.soft.ninja/", clientId: LIVE_ID, id: "x" }) as unknown as Coll;
    const v = vars(c);
    expect(v.base_url).toBe("https://pos.soft.ninja/api/v1");
    expect(v.client_id).toBe(LIVE_ID);
    expect(v.client_secret).toBe("");
    expect(v.access_token).toBe("");
    expect(c.variable.find((x) => x.key === "client_secret")!.type).toBe("secret");
    expect(JSON.stringify(c)).not.toMatch(/nss_/);
    expect(c.info.name).not.toMatch(/prueba/);
  });

  it("con el secreto recién creado lo incluye y marca la colección de prueba", () => {
    const c = buildPostmanCollection({
      origin: "https://pos.soft.ninja",
      clientId: TEST_ID,
      clientSecret: TEST_SECRET,
      id: "x",
    }) as unknown as Coll;
    expect(vars(c).client_secret).toBe(TEST_SECRET);
    expect(c.info.name).toMatch(/prueba/);
    // El secreto sólo vive en la variable, nunca dentro de un pedido.
    for (const it of c.item.flatMap((f) => f.item)) expect(JSON.stringify(it)).not.toContain(TEST_SECRET);
    expect(postmanFileName("test")).toMatch(/prueba\.postman_collection\.json$/);
  });

  it("los cuerpos de lote son el ejemplo del spec", () => {
    const c = buildPostmanCollection({ origin: "https://x", id: "x" }) as unknown as Coll;
    const it = c.item.flatMap((f) => f.item).find((i) => i.request.url.raw === "{{base_url}}/products/batch")!;
    expect(JSON.parse(it.request.body!.raw!)).toEqual(findEndpoint("products.batch")!.body!.example);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ejemplos curl / JavaScript / Python", () => {
  it("todos los endpoints en los tres lenguajes, sin secretos", () => {
    for (const e of ENDPOINTS) {
      for (const l of SNIPPET_LANGS) {
        const s = snippet(l.id, e, "https://pos.soft.ninja");
        expect(s).toContain(`https://pos.soft.ninja/api/v1${e.path}`);
        expect(s).not.toMatch(/nss_|nsat_[0-9a-f]/);
      }
    }
  });

  it("token con Basic y variables de entorno; lotes con Idempotency-Key", () => {
    const tok = findEndpoint("oauth.token")!;
    expect(snippet("curl", tok, "https://x")).toMatch(/-u "\$NINJA_CLIENT_ID:\$NINJA_CLIENT_SECRET"/);
    expect(snippet("python", tok, "https://x")).toMatch(/os\.environ\["NINJA_CLIENT_SECRET"\]/);
    const batch = findEndpoint("products.batch")!;
    expect(snippet("javascript", batch, "https://x")).toMatch(/"Idempotency-Key": crypto\.randomUUID\(\)/);
    expect(snippet("curl", findEndpoint("sales.list")!, "https://x")).toMatch(/from=.*&to=/);
  });

  it("Python usa True / False / None", () => {
    expect(pyLiteral({ a: true, b: false, c: null })).toMatch(/True[\s\S]*False[\s\S]*None/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("sandbox: credenciales de prueba", () => {
  it("formatos con test_ y detección", () => {
    expect(CLIENT_ID_RE.test(TEST_ID)).toBe(true);
    expect(CLIENT_SECRET_RE.test(TEST_SECRET)).toBe(true);
    expect(ACCESS_TOKEN_RE.test(TEST_TOKEN)).toBe(true);
    expect(parseBearer(`Bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
    expect(isSandboxToken(TEST_TOKEN)).toBe(true);
    expect(isSandboxToken(LIVE_TOKEN)).toBe(false);
    expect(isSandboxClientId(TEST_ID)).toBe(true);
    expect(isSandboxClientId(LIVE_ID)).toBe(false);
    expect(CLIENT_ID_RE.test(`nsc_TEST_${"b".repeat(24)}`)).toBe(false);
  });

  it("el Probar sólo acepta credenciales de prueba", () => {
    expect(checkSandboxCreds(TEST_ID, TEST_SECRET)).toEqual({ ok: true });
    expect(checkSandboxCreds(LIVE_ID, LIVE_SECRET).ok).toBe(false);
    expect(checkSandboxCreds(TEST_ID, LIVE_SECRET).ok).toBe(false);
    expect(checkSandboxCreds("", "").ok).toBe(false);
  });

  it("URL del Probar sin vacíos, cuerpo JSON y token enmascarado", () => {
    const e = findEndpoint("sales.list")!;
    const q = initialQuery(e);
    expect(q.from).toBeTruthy();
    expect(q.store_id).toBe("");
    const u = tryUrl(e, q);
    expect(u.startsWith("/api/v1/sales?")).toBe(true);
    expect(u).not.toMatch(/store_id=/);
    expect(checkBody('{"items":[]}')).toEqual({ ok: true, text: '{"items":[]}' });
    expect(checkBody("[1]").ok).toBe(false);
    expect(checkBody("{").ok).toBe(false);
    expect(maskToken(TEST_TOKEN)).not.toContain(TEST_TOKEN.slice(20, 60));
  });
});

describe("sandbox: la ruta marca el ambiente y respeta el dry_run de la base", () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let reply: unknown;
  beforeEach(() => {
    calls.length = 0;
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

  it("escritura con token de prueba: misma RPC, body con dry_run y header test", async () => {
    reply = {
      status: 200,
      sandbox: true,
      body: { summary: { created: 1, updated: 0, unchanged: 0, failed: 0 }, results: [], dry_run: true },
      rate: { limit: 600, remaining: 599, reset: 30 },
    };
    const { POST } = await import("@/app/api/v1/products/batch/route");
    const res = await POST(
      new Request("https://x.test/api/v1/products/batch", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ items: [{ sku: "A1", name: "Yerba" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ninja-environment")).toBe("test");
    expect(((await res.json()) as { dry_run: boolean }).dry_run).toBe(true);
    expect(calls[0]!.fn).toBe("api_v1_products_upsert");
    expect(calls[0]!.args.p_token).toBe(TEST_TOKEN);
    // La ruta no decide el sandbox: no manda ningún flag a la base.
    expect(Object.keys(calls[0]!.args).sort()).toEqual(["p_idempotency_key", "p_items", "p_token"]);
  });

  it("lectura con token live: header live", async () => {
    reply = { status: 200, body: { data: [], next: null }, rate: { limit: 600, remaining: 599, reset: 30 } };
    const { GET } = await import("@/app/api/v1/stores/route");
    const res = await GET(new Request("https://x.test/api/v1/stores", { headers: { authorization: `Bearer ${LIVE_TOKEN}` } }));
    expect(res.headers.get("x-ninja-environment")).toBe("live");
  });
});

describe("migración 20261228100000: dry_run en la base", () => {
  const WRITES: [string, string][] = [
    ["api_v1_products_upsert", "_api_v1_products_upsert"],
    ["api_v1_prices_update", "_api_v1_prices_update"],
    ["api_v1_stock_adjust", "_api_v1_stock_adjust"],
    ["api_v1_customers_upsert", "_api_v1_customers_upsert"],
  ];

  it.each(WRITES)("%s corre la operación y la deshace con el centinela en sandbox", (pub, inner) => {
    const start = MIG.indexOf(`create or replace function ${pub}(`);
    expect(start).toBeGreaterThan(-1);
    const body = MIG.slice(start, MIG.indexOf("$$;", start));
    const call = body.indexOf(`v_out := ${inner}(`);
    const sentinel = body.indexOf("if v_sandbox then raise exception 'api_sandbox_rollback'; end if;");
    expect(call).toBeGreaterThan(-1);
    // El centinela va DESPUÉS de la operación y DENTRO del mismo subbloque.
    expect(sentinel).toBeGreaterThan(call);
    expect(body.slice(call, sentinel)).not.toMatch(/\bend;/);
    expect(body).toMatch(/if not \(v_sandbox and v_msg = 'api_sandbox_rollback'\) then/);
    expect(body).toMatch(/if v_sandbox then v_out := _api_mark_dry_run\(v_out\); end if;/);
    expect(MIG).toMatch(new RegExp(`grant execute on function ${pub}\\(text, jsonb, text\\) to anon;`));
    expect(MIG).toMatch(new RegExp(`revoke all on function ${pub}\\(text, jsonb, text\\) from public, authenticated;`));
  });

  it("_api_auth decide el sandbox con el ambiente de la credencial (no con el header)", () => {
    expect(MIG).toMatch(/'sandbox', v_tok\.environment = 'test'/);
    expect(MIG).toMatch(/p_token !~ '\^nsat_\(test_\)\?\[0-9a-f\]\{64\}\$'/);
  });

  it("prefijos y ambiente consistentes, secretos sólo como hash y auditoría", () => {
    expect(MIG).toMatch(/check \(\(environment = 'test'\) = \(left\(client_id, 9\) = 'nsc_test_'\)\)/);
    expect(MIG).toMatch(/drop function if exists api_client_create\(text, text\[\], integer\);/);
    expect(MIG).toMatch(/_api_sha256\(v_secret\)/);
    expect(MIG).toMatch(/'api_client_created'/);
    expect(MIG).toMatch(/'api_client_rotated'/);
    expect(MIG).not.toMatch(/secret_hash'/);
  });

  it("reglas del repo: sin is_internal, sin tablas ni policies nuevas, gating de la feature", () => {
    expect(MIG).not.toMatch(/is_internal\(\)/);
    expect(MIG).not.toMatch(/create table/i);
    expect(MIG).not.toMatch(/create policy/i);
    expect(MIG).toMatch(/_api_owner_assert\(true\)/);
    expect(MIG).toMatch(/tenant_has_feature_for\(v_tok\.tenant_id, 'api_publica'\)/);
    expect(MIG).toMatch(/tenant_has_feature_for\(v_client\.tenant_id, 'api_publica'\)/);
  });
});
