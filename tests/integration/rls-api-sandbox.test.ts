// @vitest-environment node
// =============================================================================
// Sandbox de la API pública (ADR-159, migración 20261228100000): credenciales
// de prueba, escrituras en dry_run (nada persiste), lecturas reales,
// aislamiento entre negocios, ambiente fijo y auditoría.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `sbx-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const SCOPES = ["products:read", "products:write", "prices:write", "stock:read", "stock:write", "customers:write"];

type User = { id: string; client: SupabaseClient };
type Env = { status: number; sandbox?: boolean; body: Record<string, unknown> & { error?: { code: string } } };
type Cred = { id: string; client_id: string; client_secret: string; environment: string };
type RpcRes = { data: unknown; error: { message: string } | null };

const ctx = {} as {
  admin: SupabaseClient;
  anon: SupabaseClient;
  tA: string;
  tB: string;
  ownerA: User;
  managerA: User;
  ownerB: User;
  userIds: string[];
  testA: Cred;
  liveA: Cred;
};

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function api(fn: string, args: Record<string, unknown>): Promise<Env> {
  const r = await rpc(ctx.anon, fn, args);
  if (r.error) throw new Error(`${fn}: ${r.error.message}`);
  return r.data as Env;
}

async function token(cred: Cred): Promise<string> {
  const env = await api("api_token_issue", { p_client_id: cred.client_id, p_client_secret: cred.client_secret, p_scope: null });
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

async function createCred(owner: User, name: string, environment: "live" | "test"): Promise<Cred> {
  const r = await rpc(owner.client, "api_client_create", {
    p_name: name,
    p_scopes: SCOPES,
    p_rate_limit: 600,
    p_environment: environment,
  });
  if (r.error) throw new Error(r.error.message);
  return r.data as Cred;
}

describe.skipIf(!enabled)("API pública · sandbox (dry_run)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `SBX A ${STAMP}`, slug: `sa-${STAMP}`, status: "active" },
        { name: `SBX B ${STAMP}`, slug: `sb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `sa-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `sb-${STAMP}`)!.id;
    const { error: aErr } = await admin
      .from("subscription_addons")
      .insert([{ tenant_id: ctx.tA, addon_key: "api_publica", status: "active", source: "granted" }]);
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `osa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.managerA = await makeUser(admin, `msa-${STAMP}@test.local`, ctx.tA, "manager");
    ctx.ownerB = await makeUser(admin, `osb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.managerA.id, ctx.ownerB.id);

    const s = await ctx.ownerA.client.from("stores").insert({ name: "Centro SBX" } as never).select("id").single();
    if (s.error) throw s.error;
    const p = await ctx.ownerA.client
      .from("products")
      .insert({ tenant_id: ctx.tA, sku: `SBX-EXIST-${STAMP}`, name: "Existente", price: 100 } as never);
    if (p.error) throw p.error;

    ctx.testA = await createCred(ctx.ownerA, "Desarrollo", "test");
    ctx.liveA = await createCred(ctx.ownerA, "Producción", "live");
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB]) {
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("credencial de prueba con prefijos propios; el ambiente se lee y el secreto no", async () => {
    expect(ctx.testA.environment).toBe("test");
    expect(ctx.testA.client_id).toMatch(/^nsc_test_[0-9a-f]{24}$/);
    expect(ctx.testA.client_secret).toMatch(/^nss_test_[0-9a-f]{64}$/);
    expect(ctx.liveA.client_id).toMatch(/^nsc_[0-9a-f]{24}$/);
    const own = await ctx.ownerA.client.from("api_clients").select("id, environment").eq("id", ctx.testA.id);
    expect(own.error).toBeNull();
    expect((own.data as { environment: string }[])[0]!.environment).toBe("test");
    const hash = await ctx.ownerA.client.from("api_clients").select("secret_hash");
    expect(hash.error).not.toBeNull();
    const fromB = await ctx.ownerB.client.from("api_clients").select("id").eq("id", ctx.testA.id);
    expect(fromB.data ?? []).toHaveLength(0);
  });

  it("sólo el dueño con la feature crea credenciales de prueba", async () => {
    const byManager = await rpc(ctx.managerA.client, "api_client_create", {
      p_name: "x",
      p_scopes: ["products:read"],
      p_environment: "test",
    });
    expect(byManager.error?.message).toMatch(/forbidden/);
    const byB = await rpc(ctx.ownerB.client, "api_client_create", { p_name: "x", p_scopes: ["products:read"], p_environment: "test" });
    expect(byB.error?.message).toMatch(/feature_not_in_plan: api_publica/);
    const bad = await rpc(ctx.ownerA.client, "api_client_create", { p_name: "x", p_scopes: ["products:read"], p_environment: "staging" });
    expect(bad.error?.message).toMatch(/invalid_environment/);
  });

  it("el ambiente no se puede cambiar por REST", async () => {
    const upd = await ctx.ownerA.client.from("api_clients").update({ environment: "live" } as never).eq("id", ctx.testA.id);
    const after = await ctx.admin.from("api_clients").select("environment").eq("id", ctx.testA.id).single();
    expect(upd.error !== null || (after.data as { environment: string }).environment === "test").toBe(true);
    expect((after.data as { environment: string }).environment).toBe("test");
  });

  it("token de prueba y escrituras en dry_run: responden igual y no persisten", async () => {
    const tok = await token(ctx.testA);
    expect(tok).toMatch(/^nsat_test_[0-9a-f]{64}$/);
    const sku = `SBX-NEW-${STAMP}`;

    const prod = await api("api_v1_products_upsert", {
      p_token: tok,
      p_items: [{ sku, name: "Nuevo", price: 10 }],
      p_idempotency_key: `idem-${STAMP}`,
    });
    expect(prod.status).toBe(200);
    expect(prod.sandbox).toBe(true);
    expect(prod.body.dry_run).toBe(true);
    expect((prod.body.summary as { created: number }).created).toBe(1);

    const price = await api("api_v1_prices_update", { p_token: tok, p_items: [{ sku: `SBX-EXIST-${STAMP}`, price: 999 }] });
    expect((price.body.summary as { updated: number }).updated).toBe(1);

    const stock = await api("api_v1_stock_adjust", {
      p_token: tok,
      p_items: [{ sku: `SBX-EXIST-${STAMP}`, qty: 5, reason: "purchase" }],
    });
    // Ajustado o con error por ítem según la sucursal predeterminada del negocio de prueba:
    // en los dos casos responde 200 en dry_run y no deja movimientos.
    expect(stock.status).toBe(200);
    expect(stock.body.dry_run).toBe(true);

    const cust = await api("api_v1_customers_upsert", { p_token: tok, p_items: [{ external_id: `x-${STAMP}`, name: "Cliente" }] });
    expect((cust.body.summary as { created: number }).created).toBe(1);

    // Nada quedó.
    const p = await ctx.admin.from("products").select("id, price, stock").eq("tenant_id", ctx.tA);
    const rows = p.data as { id: string; price: number; stock: number }[];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.price)).toBe(100);
    expect(Number(rows[0]!.stock)).toBe(0);
    const c = await ctx.admin.from("customers").select("id").eq("tenant_id", ctx.tA).eq("external_id", `x-${STAMP}`);
    expect(c.data ?? []).toHaveLength(0);
    const mv = await ctx.admin.from("stock_movements").select("id").eq("tenant_id", ctx.tA);
    expect(mv.data ?? []).toHaveLength(0);
    const idem = await ctx.admin.from("api_idempotency_keys").select("id").eq("key", `idem-${STAMP}`);
    expect(idem.data ?? []).toHaveLength(0);
    const audit = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tA)
      .in("action", ["api_products_upserted", "api_prices_updated", "api_stock_adjusted", "api_customers_upserted"]);
    expect(audit.data ?? []).toHaveLength(0);
  });

  it("los errores de validación también llegan en sandbox", async () => {
    const tok = await token(ctx.testA);
    const bad = await api("api_v1_products_upsert", { p_token: tok, p_items: [{ sku: "" }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.code).toBe("validation_error");
  });

  it("lecturas con token de prueba: datos reales, sólo de su negocio", async () => {
    const tok = await token(ctx.testA);
    const list = await api("api_v1_products_list", { p_token: tok });
    expect(list.status).toBe(200);
    const data = list.body.data as { sku: string }[];
    expect(data.map((d) => d.sku)).toEqual([`SBX-EXIST-${STAMP}`]);
  });

  it("la credencial live sigue escribiendo de verdad", async () => {
    const tok = await token(ctx.liveA);
    expect(tok).toMatch(/^nsat_[0-9a-f]{64}$/);
    const sku = `SBX-LIVE-${STAMP}`;
    const env = await api("api_v1_products_upsert", { p_token: tok, p_items: [{ sku, name: "Live", price: 1 }] });
    expect(env.sandbox).toBeUndefined();
    expect(env.body.dry_run).toBeUndefined();
    const p = await ctx.admin.from("products").select("id").eq("tenant_id", ctx.tA).eq("sku", sku);
    expect(p.data ?? []).toHaveLength(1);
  });

  it("rotar conserva el prefijo de prueba y queda auditado con el ambiente", async () => {
    const r = await rpc(ctx.ownerA.client, "api_client_rotate", { p_id: ctx.testA.id });
    expect(r.error).toBeNull();
    expect((r.data as Cred).client_secret).toMatch(/^nss_test_[0-9a-f]{64}$/);
    const a = await ctx.admin
      .from("audit_logs")
      .select("action, after_data")
      .eq("tenant_id", ctx.tA)
      .eq("entity_id", ctx.testA.id)
      .in("action", ["api_client_created", "api_client_rotated"]);
    const rows = (a.data ?? []) as { action: string; after_data: Record<string, unknown> }[];
    expect(rows.map((x) => x.action).sort()).toEqual(["api_client_created", "api_client_rotated"]);
    for (const x of rows) {
      expect(x.after_data.environment).toBe("test");
      expect(JSON.stringify(x.after_data)).not.toMatch(/nss_test_[0-9a-f]{64}|secret_hash/);
    }
  });
});
