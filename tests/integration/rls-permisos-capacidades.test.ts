// @vitest-environment node
// =============================================================================
// Permisos por capacidad (ADR-138, migración 20261204100100): la base hace
// cumplir las capacidades y, con los roles de sistema, da lo mismo que antes
// (tests/integration/roles.test.ts sigue igual).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { argentinaDay } from "@/lib/permissions/roles";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `caps-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type RpcRes = { data: unknown; error: { message: string; details?: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const ctx = {} as {
  admin: SupabaseClient;
  tenant: string;
  store: string;
  owner: User;
  manager: User;
  cashier: User;
  plus: User;
  viewer: User;
  product: string;
  role: string;
  userIds: string[];
};

async function makeUser(email: string, role: string): Promise<User> {
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: ctx.tenant },
  });
  if (error) throw error;
  const id = data.user!.id;
  ctx.userIds.push(id);
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await ctx.admin.from("tenant_users").insert({ tenant_id: ctx.tenant, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

// Venta del cajero en su turno, con la fecha que se le pida (hora de Argentina).
async function saleAt(u: User, at: Date | null): Promise<string> {
  const s = await rpc(u.client, "create_sale", {
    p_items: [{ product_id: ctx.product, quantity: 1, unit_price: 100, discount: 0 }],
    p_payments: [{ method: "cash", amount: 100 }],
  });
  if (s.error) throw new Error(s.error.message);
  const id = (s.data as { sale_id: string }).sale_id;
  if (at) {
    const { error } = await ctx.admin.from("sales").update({ created_at: at.toISOString() } as never).eq("id", id);
    if (error) throw error;
  }
  return id;
}

describe.skipIf(!enabled)("permisos por capacidad (ADR-138)", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await ctx.admin
      .from("tenants")
      .insert({ name: `Caps ${STAMP}`, slug: `cp-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (error || !t) throw error ?? new Error("tenant");
    ctx.tenant = (t as { id: string }).id;
    // Roles personalizados y permisos puntuales (Business) + varias cajas.
    await ctx.admin.from("subscription_addons").insert(
      ["multi_caja", "roles_permisos"].map((key) => ({ tenant_id: ctx.tenant, addon_key: key, status: "active", source: "granted" })),
    );
    ctx.owner = await makeUser(`owner-${STAMP}@test.local`, "owner");
    ctx.manager = await makeUser(`enc-${STAMP}@test.local`, "manager");
    ctx.cashier = await makeUser(`caj-${STAMP}@test.local`, "cashier");
    ctx.plus = await makeUser(`plus-${STAMP}@test.local`, "cashier");
    ctx.viewer = await makeUser(`ver-${STAMP}@test.local`, "viewer");

    const { data: p } = await ctx.admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Alfajor ${STAMP}`, price: 100, stock: 100 })
      .select("id")
      .single();
    ctx.product = (p as { id: string }).id;
    const { data: store } = await ctx.owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    ctx.store = (store as { id: string }).id;
    const { data: regs } = await ctx.owner.client
      .from("cash_registers")
      .insert([1, 2].map((n) => ({ store_id: ctx.store, name: `Caja ${n}` })) as never)
      .select("id");
    const ids = (regs as { id: string }[]).map((r) => r.id);
    for (const [u, reg] of [[ctx.cashier, ids[0]], [ctx.plus, ids[1]]] as const) {
      const o = await rpc(u.client, "open_cash_shift", { p_register_id: reg, p_opening_amount: 0 });
      if (o.error) throw new Error(o.error.message);
    }

    // Rol personalizado "Cajero plus": cajero + anular días anteriores + precios.
    const { data: role, error: rErr } = await ctx.admin
      .from("permission_roles")
      .insert({ tenant_id: ctx.tenant, key: "cajero_plus", name: "Cajero plus", base_role: "cashier", color: "teal", icon: "store" } as never)
      .select("id")
      .single();
    if (rErr) throw rErr;
    ctx.role = (role as { id: string }).id;
    const { data: sys } = await ctx.admin
      .from("permission_role_capabilities")
      .select("capability")
      .eq("role_id", "00000000-0000-4000-8000-0000000000a3");
    const capsList = [...(sys as { capability: string }[]).map((r) => r.capability), "sales.void.past_days", "products.edit", "products.price"];
    await ctx.admin
      .from("permission_role_capabilities")
      .insert(capsList.map((c) => ({ role_id: ctx.role, capability: c, tenant_id: ctx.tenant })) as never);
    await ctx.admin.from("tenant_users").update({ role_id: ctx.role } as never).eq("tenant_id", ctx.tenant).eq("user_id", ctx.plus.id);
  }, 120_000);

  afterAll(async () => {
    if (!ctx.admin || !ctx.tenant) return;
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await ctx.admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await ctx.admin.from("users").delete().eq("id", id);
      await ctx.admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("roles de sistema: capacidades del cajero y del encargado", async () => {
    const c = await rpc(ctx.cashier.client, "my_capabilities");
    expect(c.error).toBeNull();
    const caps = (c.data as { capabilities: string[] }).capabilities;
    expect(caps).toEqual(expect.arrayContaining(["sales.create", "sales.void", "sales.return", "cash.open"]));
    expect(caps).not.toContain("sales.void.past_days");
    const m = await rpc(ctx.manager.client, "my_capabilities");
    expect((m.data as { capabilities: string[] }).capabilities).toContain("sales.void.past_days");
  });

  it("un cajero no anula ventas de días anteriores (fecha de Argentina)", async () => {
    // 23:30 de ayer en Argentina: en UTC puede ser "hoy", igual es otro día.
    const arMidnight = Date.parse(`${argentinaDay(Date.now())}T03:00:00Z`);
    const lastNight = await saleAt(ctx.cashier, new Date(arMidnight - 30 * 60_000));
    const old = await saleAt(ctx.cashier, new Date(Date.now() - 3 * 86_400_000));
    for (const id of [lastNight, old]) {
      const v = await rpc(ctx.cashier.client, "void_sale", { p_sale_id: id, p_reason: "prueba" });
      expect(v.error?.message).toMatch(/forbidden_void_past_day/);
    }
    const today = await saleAt(ctx.cashier, null);
    const ok = await rpc(ctx.cashier.client, "void_sale", { p_sale_id: today, p_reason: "prueba" });
    expect(ok.error).toBeNull();
  });

  it("un rol personalizado concede anular días anteriores y cambiar precios", async () => {
    const old = await saleAt(ctx.plus, new Date(Date.now() - 3 * 86_400_000));
    const v = await rpc(ctx.plus.client, "void_sale", { p_sale_id: old, p_reason: "prueba" });
    expect(v.error).toBeNull();
    const price = await ctx.plus.client.from("products").update({ price: 120 } as never).eq("id", ctx.product);
    expect(price.error).toBeNull();
    const stock = await ctx.plus.client.from("products").update({ stock: 1 } as never).eq("id", ctx.product);
    expect(stock.error?.message).toMatch(/forbidden_role/);
    expect(`${stock.error?.details ?? ""}`).toContain("capability:stock.adjust");
  });

  it("sin la feature, el rol personalizado vuelve a ser Cajero", async () => {
    await ctx.admin.from("subscription_addons").update({ status: "cancelled" } as never).eq("tenant_id", ctx.tenant).eq("addon_key", "roles_permisos");
    try {
      const old = await saleAt(ctx.plus, new Date(Date.now() - 3 * 86_400_000));
      const v = await rpc(ctx.plus.client, "void_sale", { p_sale_id: old, p_reason: "prueba" });
      expect(v.error?.message).toMatch(/forbidden_void_past_day/);
    } finally {
      await ctx.admin.from("subscription_addons").update({ status: "active" } as never).eq("tenant_id", ctx.tenant).eq("addon_key", "roles_permisos");
    }
  });

  it("quitar un permiso puntual a un encargado lo frena en la base", async () => {
    await ctx.admin
      .from("permission_user_overrides")
      .insert({ tenant_id: ctx.tenant, user_id: ctx.manager.id, capability: "products.price", effect: "revoke" } as never);
    const r = await ctx.manager.client.from("products").update({ price: 130 } as never).eq("id", ctx.product);
    expect(r.error?.message).toMatch(/forbidden_role/);
    const name = await ctx.manager.client.from("products").update({ name: `Alfajor triple ${STAMP}` } as never).eq("id", ctx.product);
    expect(name.error).toBeNull();
    await ctx.admin.from("permission_user_overrides").delete().eq("tenant_id", ctx.tenant).eq("user_id", ctx.manager.id);
  });

  it("solo lectura sigue sin escribir y nadie escribe las tablas de permisos por REST", async () => {
    const v = await ctx.viewer.client.from("customers").insert({ name: `X ${STAMP}` } as never);
    expect(v.error?.message).toMatch(/forbidden_read_only/);
    const w = await ctx.owner.client
      .from("permission_roles")
      .insert({ tenant_id: ctx.tenant, key: "intruso", name: "Intruso", base_role: "manager" } as never);
    expect(w.error).not.toBeNull();
    const o = await ctx.owner.client
      .from("permission_user_overrides")
      .insert({ tenant_id: ctx.tenant, user_id: ctx.cashier.id, capability: "products.edit", effect: "grant" } as never);
    expect(o.error).not.toBeNull();
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const r = await rpc(ctx.admin, fn);
      expect(r.error, fn).toBeNull();
      expect(r.data, fn).toEqual([]);
    }
  });
});
