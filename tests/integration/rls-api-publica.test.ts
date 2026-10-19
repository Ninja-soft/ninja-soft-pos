// @vitest-environment node
// =============================================================================
// API pública v1 (ADR-094, migraciones 20261109400000 a 20261109400300):
// aislamiento entre negocios, alcances, revocación, plan, idempotencia,
// límite por cliente y rendimiento (1000 productos en lotes).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
//
// Escenario: negocios A y B con `api_publica` (add-on), C sin la feature.
// Las RPC públicas se llaman con un cliente anónimo, igual que la ruta
// /api/v1 de Next: lo único que identifica al negocio es el token.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `api-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ALL_SCOPES = [
  "products:read",
  "products:write",
  "stock:read",
  "stock:write",
  "prices:write",
  "sales:read",
  "customers:read",
  "customers:write",
];

type User = { id: string; client: SupabaseClient };
type Env = { status: number; body: Record<string, unknown> & { error?: { code: string } }; rate?: { remaining: number } };
type Cred = { id: string; client_id: string; client_secret: string };
type Ctx = {
  admin: SupabaseClient;
  anon: SupabaseClient;
  tA: string;
  tB: string;
  tC: string;
  ownerA: User;
  managerA: User;
  ownerB: User;
  ownerC: User;
  userIds: string[];
  storeA: string;
  storeB: string;
  credA: Cred;
  credB: Cred;
  tokenA: string;
  tokenB: string;
  customerB: string;
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function api(fn: string, args: Record<string, unknown>): Promise<Env> {
  const r = await rpc(ctx.anon, fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as Env;
}

async function token(cred: Cred, scope?: string): Promise<string> {
  const env = await api("api_token_issue", {
    p_client_id: cred.client_id,
    p_client_secret: cred.client_secret,
    p_scope: scope ?? null,
  });
  expect(env.status, JSON.stringify(env.body)).toBe(200);
  return env.body.access_token as string;
}

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function createCred(owner: User, name: string, scopes = ALL_SCOPES, limit = 600): Promise<Cred> {
  const r = await rpc(owner.client, "api_client_create", { p_name: name, p_scopes: scopes, p_rate_limit: limit });
  if (r.error) throw new Error(r.error.message);
  return r.data as Cred;
}

describe.skipIf(!enabled)("API pública v1 · aislamiento, alcances, plan y rendimiento", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `API A ${STAMP}`, slug: `aa-${STAMP}`, status: "active" },
        { name: `API B ${STAMP}`, slug: `ab-${STAMP}`, status: "active" },
        { name: `API C ${STAMP}`, slug: `ac-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `aa-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `ab-${STAMP}`)!.id;
    ctx.tC = rows.find((x) => x.slug === `ac-${STAMP}`)!.id;

    // Insert multi-fila: todas las claves en cada fila.
    const { error: aErr } = await admin.from("subscription_addons").insert(
      [ctx.tA, ctx.tB].map((tenant) => ({ tenant_id: tenant, addon_key: "api_publica", status: "active", source: "granted" })),
    );
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `owa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.managerA = await makeUser(admin, `mga-${STAMP}@test.local`, ctx.tA, "manager");
    ctx.ownerB = await makeUser(admin, `owb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `owc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.managerA.id, ctx.ownerB.id, ctx.ownerC.id);

    const sA = await ctx.ownerA.client.from("stores").insert({ name: "Centro A" } as never).select("id").single();
    if (sA.error || !sA.data) throw sA.error ?? new Error("store A");
    ctx.storeA = (sA.data as { id: string }).id;
    const sB = await ctx.ownerB.client.from("stores").insert({ name: "Centro B" } as never).select("id").single();
    if (sB.error || !sB.data) throw sB.error ?? new Error("store B");
    ctx.storeB = (sB.data as { id: string }).id;

    // Datos de B que A va a intentar tocar.
    const pB = await ctx.ownerB.client
      .from("products")
      .insert({ tenant_id: ctx.tB, sku: `B-ONLY-${STAMP}`, name: "Producto de B", price: 500 } as never);
    if (pB.error) throw pB.error;
    const pB2 = await ctx.ownerB.client
      .from("products")
      .insert({ tenant_id: ctx.tB, sku: `SHARED-${STAMP}`, name: "Compartido B", price: 777 } as never);
    if (pB2.error) throw pB2.error;
    const cB = await ctx.ownerB.client
      .from("customers")
      .insert({ tenant_id: ctx.tB, name: "Cliente de B", email: "b@test.local" } as never)
      .select("id")
      .single();
    if (cB.error || !cB.data) throw cB.error ?? new Error("customer B");
    ctx.customerB = (cB.data as { id: string }).id;

    ctx.credA = await createCred(ctx.ownerA, "ERP A");
    ctx.credB = await createCred(ctx.ownerB, "ERP B");
    ctx.tokenA = await token(ctx.credA);
    ctx.tokenB = await token(ctx.credB);
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB, ctx.tC]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── Credenciales ─────────────────────────────────────────────────────────
  it("sólo el dueño con la feature crea credenciales; el secreto no se lee por REST", async () => {
    expect(ctx.credA.client_secret).toMatch(/^nss_[0-9a-f]{64}$/);
    const byManager = await rpc(ctx.managerA.client, "api_client_create", { p_name: "x", p_scopes: ["products:read"] });
    expect(byManager.error?.message).toMatch(/forbidden/);
    const byC = await rpc(ctx.ownerC.client, "api_client_create", { p_name: "x", p_scopes: ["products:read"] });
    expect(byC.error?.message).toMatch(/feature_not_in_plan: api_publica/);
    const badScope = await rpc(ctx.ownerA.client, "api_client_create", { p_name: "x", p_scopes: ["admin:all"] });
    expect(badScope.error?.message).toMatch(/invalid_scope/);

    // El hash no se expone ni al dueño; los tokens no se leen por REST.
    const hash = await ctx.ownerA.client.from("api_clients").select("secret_hash");
    expect(hash.error).not.toBeNull();
    const list = await ctx.ownerA.client.from("api_clients").select("id, client_id, tenant_id");
    expect(list.error).toBeNull();
    expect((list.data as { tenant_id: string }[]).every((r) => r.tenant_id === ctx.tA)).toBe(true);
    const tokens = await ctx.ownerA.client.from("api_access_tokens").select("id");
    expect(tokens.error !== null || (tokens.data ?? []).length === 0).toBe(true);
    const fromB = await ctx.ownerB.client.from("api_clients").select("id").eq("id", ctx.credA.id);
    expect(fromB.data ?? []).toHaveLength(0);
    // Nadie escribe por REST.
    const direct = await ctx.ownerA.client.from("api_clients").update({ scopes: ALL_SCOPES } as never).eq("id", ctx.credA.id);
    expect(direct.error).not.toBeNull();

    // Auditado, sin el secreto.
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, after_data")
      .eq("entity_id", ctx.credA.id)
      .eq("action", "api_client_created");
    expect(logs ?? []).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(ctx.credA.client_secret);
  });

  it("token: secreto equivocado y alcance ajeno se rechazan", async () => {
    const wrong = await api("api_token_issue", {
      p_client_id: ctx.credA.client_id,
      p_client_secret: ctx.credB.client_secret,
      p_scope: null,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe("invalid_client");
    const limited = await createCred(ctx.ownerA, "Solo lectura", ["products:read"]);
    const scope = await api("api_token_issue", {
      p_client_id: limited.client_id,
      p_client_secret: limited.client_secret,
      p_scope: "products:read products:write",
    });
    expect(scope.status).toBe(400);
    expect(scope.body.error?.code).toBe("invalid_scope");
    const garbage = await api("api_v1_products_list", { p_token: "nsat_123" });
    expect(garbage.status).toBe(401);
  });

  // ── Aislamiento entre negocios ───────────────────────────────────────────
  it("la credencial de A jamás lee ni escribe datos de B, aunque mande ids o SKU de B", async () => {
    // Mismo SKU que un producto de B: se crea en A, el de B no cambia.
    const up = await api("api_v1_products_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ sku: `SHARED-${STAMP}`, name: "Compartido A", price: 1 }],
    });
    expect(up.status).toBe(200);
    const res = (up.body.results as { status: string }[])[0]!;
    expect(res.status).toBe("created");
    const { data: bProd } = await ctx.admin
      .from("products")
      .select("price, name")
      .eq("tenant_id", ctx.tB)
      .eq("sku", `SHARED-${STAMP}`)
      .single();
    expect(bProd).toEqual({ price: 777, name: "Compartido B" });

    // Precio de un SKU que sólo existe en B: no encontrado.
    const pr = await api("api_v1_prices_update", { p_token: ctx.tokenA, p_items: [{ sku: `B-ONLY-${STAMP}`, price: 1 }] });
    expect(pr.status).toBe(200);
    expect((pr.body.results as { error: string }[])[0]!.error).toBe("product_not_found");
    const { data: bOnly } = await ctx.admin.from("products").select("price").eq("sku", `B-ONLY-${STAMP}`).single();
    expect((bOnly as { price: number }).price).toBe(500);

    // Lectura: A no ve productos de B.
    const listA = await api("api_v1_products_list", { p_token: ctx.tokenA, p_sku: `B-ONLY-${STAMP}` });
    expect(listA.body.data).toEqual([]);
    const listAll = await api("api_v1_products_list", { p_token: ctx.tokenA, p_limit: 500 });
    const skus = (listAll.body.data as { sku: string; name: string }[]).map((p) => p.name);
    expect(skus).not.toContain("Producto de B");
    expect(skus).not.toContain("Compartido B");
    // Producto completo (ADR-168): con el id de un producto de B e include, nada.
    const { data: bRow } = await ctx.admin.from("products").select("id").eq("sku", `B-ONLY-${STAMP}`).single();
    const fullA = await api("api_v1_products_list", {
      p_token: ctx.tokenA,
      p_ids: [(bRow as { id: string }).id],
      p_include: ["attributes", "images", "price_lists", "variants", "stock"],
    });
    expect(fullA.status).toBe(200);
    expect(fullA.body.data).toEqual([]);
    const fullB = await api("api_v1_products_list", {
      p_token: ctx.tokenB,
      p_ids: [(bRow as { id: string }).id],
      p_include: ["price_lists", "stock"],
    });
    const rowB = (fullB.body.data as Record<string, unknown>[])[0]!;
    expect(rowB.price).toBe(500);
    expect(Array.isArray(rowB.price_lists)).toBe(true);
    expect(Array.isArray(rowB.stock_by_store)).toBe(true);
    const badInclude = await api("api_v1_products_list", { p_token: ctx.tokenA, p_include: ["foo"] });
    expect(badInclude.status).toBe(400);
    expect(badInclude.body.error?.code).toBe("invalid_include");

    // Stock en una sucursal de B.
    const st = await api("api_v1_stock_adjust", {
      p_token: ctx.tokenA,
      p_items: [{ sku: `SHARED-${STAMP}`, store_id: ctx.storeB, qty: 5, reason: "purchase" }],
    });
    expect((st.body.results as { error: string }[])[0]!.error).toBe("store_not_found");
    const stList = await api("api_v1_stock_list", { p_token: ctx.tokenA, p_store_id: ctx.storeB });
    expect(stList.status).toBe(404);
    const sales = await api("api_v1_sales_list", {
      p_token: ctx.tokenA,
      p_from: "2026-01-01T00:00:00Z",
      p_to: "2026-03-01T00:00:00Z",
      p_store_id: ctx.storeB,
    });
    expect(sales.status).toBe(404);

    // Cliente de B por id: no existe para A y no cambia.
    const cu = await api("api_v1_customers_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ id: ctx.customerB, name: "Robado" }],
    });
    expect((cu.body.results as { error: string }[])[0]!.error).toBe("customer_not_found");
    const { data: cB } = await ctx.admin.from("customers").select("name, tenant_id").eq("id", ctx.customerB).single();
    expect(cB).toEqual({ name: "Cliente de B", tenant_id: ctx.tB });
    const custA = await api("api_v1_customers_list", { p_token: ctx.tokenA, p_limit: 500 });
    expect((custA.body.data as { id: string }[]).some((c) => c.id === ctx.customerB)).toBe(false);

    // El negocio no se puede pasar como parámetro.
    const withTenant = await rpc(ctx.anon, "api_v1_products_list", { p_token: ctx.tokenA, p_tenant: ctx.tB });
    expect(withTenant.error).not.toBeNull();
    // Las funciones internas no son invocables.
    const internal = await rpc(ctx.anon, "_api_v1_products_list", {
      p_tenant: ctx.tB,
      p_limit: 10,
      p_after_updated: null,
      p_after_id: null,
      p_updated_since: null,
      p_sku: null,
      p_include_deleted: false,
      p_include: null,
      p_ids: null,
    });
    expect(internal.error).not.toBeNull();
    const internalAuthed = await rpc(ctx.ownerA.client, "_api_v1_products_upsert", {
      p_tenant: ctx.tB,
      p_client: ctx.credA.id,
      p_items: [{ sku: "x", name: "x" }],
      p_key: null,
    });
    expect(internalAuthed.error).not.toBeNull();
  });

  it("B con su token sólo ve lo suyo", async () => {
    const list = await api("api_v1_products_list", { p_token: ctx.tokenB, p_limit: 500 });
    const names = (list.body.data as { name: string }[]).map((p) => p.name);
    expect(names).toContain("Producto de B");
    expect(names).not.toContain("Compartido A");
  });

  // ── Alcance, revocación y plan ───────────────────────────────────────────
  it("alcance insuficiente se rechaza", async () => {
    const ro = await token(ctx.credA, "products:read");
    const w = await api("api_v1_products_upsert", { p_token: ro, p_items: [{ sku: "X", name: "X" }] });
    expect(w.status).toBe(403);
    expect(w.body.error?.code).toBe("insufficient_scope");
    const s = await api("api_v1_sales_list", { p_token: ro, p_from: "2026-01-01T00:00:00Z", p_to: "2026-01-02T00:00:00Z" });
    expect(s.body.error?.code).toBe("insufficient_scope");
  });

  it("credencial revocada y secreto rotado se rechazan", async () => {
    const tmp = await createCred(ctx.ownerA, "Temporal", ["products:read"]);
    const tk = await token(tmp);
    expect((await api("api_v1_products_list", { p_token: tk })).status).toBe(200);

    const rot = await rpc(ctx.ownerA.client, "api_client_rotate", { p_id: tmp.id });
    expect(rot.error).toBeNull();
    expect((await api("api_v1_products_list", { p_token: tk })).status).toBe(401);
    const old = await api("api_token_issue", { p_client_id: tmp.client_id, p_client_secret: tmp.client_secret, p_scope: null });
    expect(old.status).toBe(401);
    const fresh = await token({ ...tmp, client_secret: (rot.data as Cred).client_secret });

    const rev = await rpc(ctx.ownerA.client, "api_client_revoke", { p_id: tmp.id, p_reason: "test" });
    expect(rev.error).toBeNull();
    const after = await api("api_v1_products_list", { p_token: fresh });
    expect(after.status).toBe(401);
    expect(after.body.error?.code).toBe("invalid_token");
    const issue = await api("api_token_issue", {
      p_client_id: tmp.client_id,
      p_client_secret: (rot.data as Cred).client_secret,
      p_scope: null,
    });
    expect(issue.status).toBe(401);
    const { data: logs } = await ctx.admin.from("audit_logs").select("action").eq("entity_id", tmp.id);
    const actions = ((logs ?? []) as { action: string }[]).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["api_client_created", "api_client_rotated", "api_client_revoked"]));
  });

  it("feature apagada: el token vigente y uno nuevo se rechazan", async () => {
    const tk = await token(ctx.credB);
    await ctx.admin.from("subscription_addons").update({ status: "cancelled" } as never).eq("tenant_id", ctx.tB);
    const call = await api("api_v1_products_list", { p_token: tk });
    expect(call.status).toBe(403);
    expect(call.body.error?.code).toBe("feature_not_in_plan");
    const issue = await api("api_token_issue", {
      p_client_id: ctx.credB.client_id,
      p_client_secret: ctx.credB.client_secret,
      p_scope: null,
    });
    expect(issue.status).toBe(403);
    // Revocar sigue funcionando sin la feature.
    const rev = await rpc(ctx.ownerB.client, "api_client_revoke", { p_id: ctx.credB.id, p_reason: "baja de plan" });
    expect(rev.error).toBeNull();
  });

  // ── Operaciones ──────────────────────────────────────────────────────────
  it("upsert: unchanged sin cambios, updated con cambios y error por ítem", async () => {
    const sku = `U-${STAMP}`;
    const first = await api("api_v1_products_upsert", { p_token: ctx.tokenA, p_items: [{ sku, name: "Uno", price: 10 }] });
    expect((first.body.results as { status: string }[])[0]!.status).toBe("created");
    const same = await api("api_v1_products_upsert", { p_token: ctx.tokenA, p_items: [{ sku, price: 10 }] });
    expect((same.body.results as { status: string }[])[0]!.status).toBe("unchanged");
    const mixed = await api("api_v1_products_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ sku, price: 12 }, { sku: `SIN-NOMBRE-${STAMP}` }],
    });
    const r = mixed.body.results as { status: string; error?: string }[];
    expect(r[0]!.status).toBe("updated");
    expect(r[1]).toMatchObject({ status: "error", error: "name_required" });
    const bad = await api("api_v1_products_upsert", { p_token: ctx.tokenA, p_items: [{ sku: "", price: -1 }] });
    expect(bad.status).toBe(422);
    const tooMany = await api("api_v1_products_upsert", {
      p_token: ctx.tokenA,
      p_items: Array.from({ length: 501 }, (_, i) => ({ sku: `T${i}` })),
    });
    expect(tooMany.status).toBe(422);
  });

  it("idempotencia: misma clave y cuerpo repite la respuesta; otro cuerpo da 409", async () => {
    const key = `idem-${STAMP}`;
    const items = [{ sku: `I-${STAMP}`, name: "Idem", price: 5 }];
    const a = await api("api_v1_products_upsert", { p_token: ctx.tokenA, p_items: items, p_idempotency_key: key });
    expect((a.body.results as { status: string }[])[0]!.status).toBe("created");
    const b = await api("api_v1_products_upsert", { p_token: ctx.tokenA, p_items: items, p_idempotency_key: key });
    expect((b as unknown as { replayed: boolean }).replayed).toBe(true);
    expect((b.body.results as { status: string }[])[0]!.status).toBe("created");
    const c = await api("api_v1_products_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ sku: `I-${STAMP}`, price: 6 }],
      p_idempotency_key: key,
    });
    expect(c.status).toBe(409);
    expect(c.body.error?.code).toBe("idempotency_conflict");
  });

  it("stock: ajuste y conteo en la sucursal principal mueven el saldo y quedan auditados", async () => {
    const sku = `U-${STAMP}`;
    const set = await api("api_v1_stock_adjust", {
      p_token: ctx.tokenA,
      p_items: [{ sku, mode: "set", qty: 10, reason: "count", notes: "inventario" }],
    });
    expect((set.body.results as { status: string; qty: number }[])[0]).toMatchObject({ status: "adjusted", qty: 10 });
    const delta = await api("api_v1_stock_adjust", {
      p_token: ctx.tokenA,
      p_items: [{ sku, qty: -3, reason: "loss" }],
    });
    expect((delta.body.results as { qty: number }[])[0]!.qty).toBe(7);
    const list = await api("api_v1_stock_list", { p_token: ctx.tokenA, p_skus: [sku] });
    expect((list.body.data as { qty: number; store_id: string }[])[0]).toMatchObject({ qty: 7, store_id: ctx.storeA });
    const { data: p } = await ctx.admin.from("products").select("id, stock").eq("tenant_id", ctx.tA).eq("sku", sku).single();
    expect(Number((p as { stock: number }).stock)).toBe(7);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("entity_id", (p as { id: string }).id)
      .in("action", ["stock_count", "stock_adjust"]);
    expect((logs ?? []).length).toBe(2);
  });

  it("clientes: alta por external_id y edición idempotente", async () => {
    const ext = `EXT-${STAMP}`;
    const a = await api("api_v1_customers_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ external_id: ext, name: "Ana", document_type: "dni", document_number: "30123456" }],
    });
    expect((a.body.results as { status: string }[])[0]!.status).toBe("created");
    const b = await api("api_v1_customers_upsert", { p_token: ctx.tokenA, p_items: [{ external_id: ext, phone: "1144" }] });
    expect((b.body.results as { status: string }[])[0]!.status).toBe("updated");
    const bad = await api("api_v1_customers_upsert", {
      p_token: ctx.tokenA,
      p_items: [{ external_id: `X-${STAMP}`, name: "X", document_type: "cuit", document_number: "123" }],
    });
    expect(bad.status).toBe(422);
    const list = await api("api_v1_customers_list", { p_token: ctx.tokenA, p_external_id: ext });
    expect((list.body.data as { phone: string; tenant_id?: string }[])[0]).toMatchObject({ phone: "1144" });
  });

  it("ventas: rango obligatorio de hasta 93 días", async () => {
    const ok = await api("api_v1_sales_list", { p_token: ctx.tokenA, p_from: "2026-01-01T00:00:00Z", p_to: "2026-02-01T00:00:00Z" });
    expect(ok.status).toBe(200);
    const big = await api("api_v1_sales_list", { p_token: ctx.tokenA, p_from: "2026-01-01T00:00:00Z", p_to: "2026-06-01T00:00:00Z" });
    expect(big.status).toBe(422);
  });

  it("límite por cliente: pasado el tope responde 429", async () => {
    const lim = await createCred(ctx.ownerA, "Limitada", ["products:read"], 10);
    const tk = await token(lim); // 1 pedido
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await api("api_v1_products_list", { p_token: tk, p_limit: 1 })).status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(9);
    expect(statuses).toContain(429);
    const last = await api("api_v1_products_list", { p_token: tk, p_limit: 1 });
    expect(last.status).toBe(429);
    expect(last.body.error?.code).toBe("rate_limited");
  });

  // ── Rendimiento (criterio F5: 1000 productos en menos de 60 s) ───────────
  it("sincroniza 1000 productos en lotes de 500 en menos de 60 s y los pagina por cursor", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      sku: `PERF-${STAMP}-${String(i).padStart(4, "0")}`,
      name: `Producto ${i}`,
      barcode: `PB-${STAMP}-${i}`,
      price: 100 + i,
      cost: 50 + i,
      unit: "un",
    }));
    const t0 = performance.now();
    for (let i = 0; i < items.length; i += 500) {
      const r = await api("api_v1_products_upsert", {
        p_token: ctx.tokenA,
        p_items: items.slice(i, i + 500),
        p_idempotency_key: `perf-${STAMP}-${i}`,
      });
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect((r.body.summary as { created: number }).created).toBe(500);
    }
    const createMs = performance.now() - t0;

    // Segunda pasada: cambio de precio en todos (updated).
    const t1 = performance.now();
    for (let i = 0; i < items.length; i += 500) {
      const r = await api("api_v1_prices_update", {
        p_token: ctx.tokenA,
        p_items: items.slice(i, i + 500).map((it) => ({ sku: it.sku, price: it.price + 1 })),
      });
      expect((r.body.summary as { updated: number }).updated).toBe(500);
    }
    const updateMs = performance.now() - t1;
    console.info(`[api-publica] 1000 productos: alta ${Math.round(createMs)} ms, precios ${Math.round(updateMs)} ms`);
    expect(createMs).toBeLessThan(60_000);
    expect(updateMs).toBeLessThan(60_000);

    // Paginación por cursor: todo aparece una sola vez.
    const seen = new Set<string>();
    let after: { updated_at: string; id: string } | null = null;
    for (let page = 0; page < 20; page++) {
      const r: Env = await api("api_v1_products_list", {
        p_token: ctx.tokenA,
        p_limit: 300,
        p_after_updated: after?.updated_at ?? null,
        p_after_id: after?.id ?? null,
      });
      for (const p of r.body.data as { id: string }[]) {
        expect(seen.has(p.id)).toBe(false);
        seen.add(p.id);
      }
      after = r.body.next as { updated_at: string; id: string } | null;
      if (!after) break;
    }
    const { count } = await ctx.admin
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tA)
      .is("deleted_at", null);
    expect(seen.size).toBe(count);
    expect(seen.size).toBeGreaterThanOrEqual(1000);
  }, 120_000);
});
