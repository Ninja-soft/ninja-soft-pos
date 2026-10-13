// @vitest-environment node
// =============================================================================
// Permisos por rol a nivel base (ADR-071, migración 20261031200000): lo que
// cada rol del negocio PUEDE y NO PUEDE hacer aunque la UI no lo muestre.
// Matriz en docs/06-permissions-roles.md §4.7.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio de UNA sucursal con tres cajas (multi_caja por addon),
// dueño, encargado, cajero y solo lectura.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `roles-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: User;
  manager: User;
  cashier: User;
  viewer: User;
  catalogProduct: string;
  saleProduct: string;
  regs: string[];
  shiftOwner: string;
  shiftCashier: string;
  customer: string;
  saleToday: string;
  saleOld: string;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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
  const { error: tuErr } = await admin
    .from("tenant_users")
    .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

const saleItems = () => [{ product_id: ctx.saleProduct, quantity: 1, unit_price: 100, discount: 0 }];

describe.skipIf(!enabled)("permisos por rol · owner, manager, cashier, viewer", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Roles ${STAMP}`, slug: `ro-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id;

    // Features opcionales que la suite necesita prendidas para probar el
    // ROL (no el plan): varias cajas, listas de precios y contabilidad.
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["multi_caja", "listas_precios", "contabilidad"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenant, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenant, "cashier");
    ctx.viewer = await makeUser(admin, `ver-${STAMP}@test.local`, ctx.tenant, "viewer");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.viewer.id);

    const { data: prods, error: pErr } = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Catalogo ${STAMP}`, price: 100, stock: 10 },
        { tenant_id: ctx.tenant, name: `Venta ${STAMP}`, price: 100, stock: 50 },
      ])
      .select("id, name");
    if (pErr || !prods) throw pErr ?? new Error("products");
    const rows = prods as { id: string; name: string }[];
    ctx.catalogProduct = rows.find((p) => p.name.startsWith("Catalogo"))!.id;
    ctx.saleProduct = rows.find((p) => p.name.startsWith("Venta"))!.id;

    const { data: store, error: sErr } = await ctx.owner.client
      .from("stores")
      .insert({ name: "Centro" } as never)
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: regs, error: rErr } = await ctx.owner.client
      .from("cash_registers")
      .insert([1, 2, 3].map((n) => ({ store_id: (store as { id: string }).id, name: `Caja ${n}` })) as never)
      .select("id");
    if (rErr || !regs) throw rErr ?? new Error("registers");
    ctx.regs = (regs as { id: string }[]).map((r) => r.id);
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("audit_logs").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Productos y precios
  // ---------------------------------------------------------------------------

  it("productos: owner y manager crean y cambian precio", async () => {
    const created = await ctx.manager.client
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Del encargado ${STAMP}`, price: 10 } as never)
      .select("id")
      .single();
    expect(created.error).toBeNull();

    const price = await ctx.manager.client
      .from("products")
      .update({ price: 150 } as never)
      .eq("id", ctx.catalogProduct)
      .select("price")
      .single();
    expect(price.error).toBeNull();
    expect(Number((price.data as { price: number }).price)).toBe(150);

    const own = await ctx.owner.client
      .from("products")
      .update({ price: 120 } as never)
      .eq("id", ctx.catalogProduct);
    expect(own.error).toBeNull();
  });

  it("productos: cashier y viewer leen pero no crean, no editan ni cambian precio", async () => {
    for (const u of [ctx.cashier, ctx.viewer]) {
      const read = await u.client.from("products").select("id").eq("id", ctx.catalogProduct);
      expect(read.error).toBeNull();
      expect(read.data).toHaveLength(1);

      const ins = await u.client
        .from("products")
        .insert({ tenant_id: ctx.tenant, name: `Intruso ${STAMP}`, price: 1 } as never);
      expect(ins.error?.message).toMatch(/forbidden/);

      const upd = await u.client
        .from("products")
        .update({ price: 1 } as never)
        .eq("id", ctx.catalogProduct);
      expect(upd.error?.message).toMatch(/forbidden/);

      const del = await u.client
        .from("products")
        .update({ deleted_at: new Date().toISOString() } as never)
        .eq("id", ctx.catalogProduct);
      expect(del.error?.message).toMatch(/forbidden/);
    }
    const { data } = await ctx.admin.from("products").select("price, deleted_at").eq("id", ctx.catalogProduct).single();
    expect(Number((data as { price: number }).price)).toBe(120);
    expect((data as { deleted_at: string | null }).deleted_at).toBeNull();
  });

  it("categorías y marcas: sólo owner y manager", async () => {
    const ok = await ctx.manager.client.from("categories").insert({ name: `Cat ${STAMP}` } as never);
    expect(ok.error).toBeNull();
    for (const u of [ctx.cashier, ctx.viewer]) {
      const cat = await u.client.from("categories").insert({ name: `Cat x ${STAMP}` } as never);
      expect(cat.error?.message).toMatch(/forbidden/);
      const brand = await u.client.from("brands").insert({ name: `Marca x ${STAMP}` } as never);
      expect(brand.error?.message).toMatch(/forbidden/);
    }
  });

  // ---------------------------------------------------------------------------
  // Stock manual
  // ---------------------------------------------------------------------------

  it("ajuste manual de stock: manager sí; cashier y viewer no por ninguna vía", async () => {
    const ok = await rpc(ctx.manager.client, "adjust_product_stock", {
      p_product_id: ctx.catalogProduct,
      p_delta: 5,
      p_reason: "adjustment",
    });
    expect(ok.error).toBeNull();
    expect(Number(ok.data)).toBe(15);

    for (const u of [ctx.cashier, ctx.viewer]) {
      const adj = await rpc(u.client, "adjust_product_stock", {
        p_product_id: ctx.catalogProduct,
        p_delta: 100,
        p_reason: "adjustment",
      });
      expect(adj.error?.message).toMatch(/forbidden/);

      const waste = await rpc(u.client, "register_stock_waste", {
        p_product_id: ctx.catalogProduct,
        p_qty: 1,
        p_loss_reason: "roto",
      });
      expect(waste.error?.message).toMatch(/forbidden/);

      const mov = await u.client
        .from("stock_movements")
        .insert({ tenant_id: ctx.tenant, product_id: ctx.catalogProduct, delta: 100, reason: "adjustment" } as never);
      expect(mov.error?.message).toMatch(/forbidden/);

      const direct = await u.client
        .from("products")
        .update({ stock: 999 } as never)
        .eq("id", ctx.catalogProduct);
      expect(direct.error?.message).toMatch(/forbidden/);
    }
    const { data } = await ctx.admin.from("products").select("stock").eq("id", ctx.catalogProduct).single();
    expect(Number((data as { stock: number }).stock)).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // Clientes
  // ---------------------------------------------------------------------------

  it("clientes: cashier da de alta y edita contacto, no da de baja; viewer nada", async () => {
    const a = await ctx.cashier.client
      .from("customers")
      .insert({ name: `Cliente ${STAMP}` } as never)
      .select("id")
      .single();
    expect(a.error).toBeNull();
    ctx.customer = (a.data as { id: string }).id;

    const edit = await ctx.cashier.client
      .from("customers")
      .update({ phone: "1144445555" } as never)
      .eq("id", ctx.customer);
    expect(edit.error).toBeNull();

    const soft = await ctx.cashier.client
      .from("customers")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", ctx.customer);
    expect(soft.error?.message).toMatch(/forbidden/);
    const hard = await ctx.cashier.client.from("customers").delete().eq("id", ctx.customer);
    expect(hard.error?.message).toMatch(/forbidden/);

    const vIns = await ctx.viewer.client.from("customers").insert({ name: `Viewer ${STAMP}` } as never);
    expect(vIns.error?.message).toMatch(/forbidden/);
    const vUpd = await ctx.viewer.client
      .from("customers")
      .update({ phone: "1" } as never)
      .eq("id", ctx.customer);
    expect(vUpd.error?.message).toMatch(/forbidden/);

    const { data } = await ctx.admin.from("customers").select("deleted_at, phone").eq("id", ctx.customer).single();
    expect((data as { deleted_at: string | null }).deleted_at).toBeNull();
    expect((data as { phone: string }).phone).toBe("1144445555");
  });

  it("clientes: manager da de baja", async () => {
    const { data: c } = await ctx.manager.client
      .from("customers")
      .insert({ name: `Baja ${STAMP}` } as never)
      .select("id")
      .single();
    const id = (c as { id: string }).id;
    const soft = await ctx.manager.client
      .from("customers")
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    expect(soft.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Caja y ventas
  // ---------------------------------------------------------------------------

  it("caja: owner y cashier abren su turno; viewer no abre ni mueve caja", async () => {
    const a = await rpc(ctx.owner.client, "open_cash_shift", { p_register_id: ctx.regs[0], p_opening_amount: 1000 });
    expect(a.error).toBeNull();
    ctx.shiftOwner = a.data as string;

    const b = await rpc(ctx.cashier.client, "open_cash_shift", { p_register_id: ctx.regs[1], p_opening_amount: 500 });
    expect(b.error).toBeNull();
    ctx.shiftCashier = b.data as string;

    const v = await rpc(ctx.viewer.client, "open_cash_shift", { p_register_id: ctx.regs[2], p_opening_amount: 0 });
    expect(v.error?.message).toMatch(/forbidden/);

    const mov = await ctx.viewer.client
      .from("cash_movements")
      .insert({ cash_shift_id: ctx.shiftCashier, type: "income", amount: 10, reason: "x" } as never);
    expect(mov.error).not.toBeNull();
  });

  it("caja: cashier no cierra el turno de otro", async () => {
    const close = await rpc(ctx.cashier.client, "close_cash_shift", {
      p_shift_id: ctx.shiftOwner,
      p_closing_amount: 1000,
    });
    expect(close.error?.message).toMatch(/shift_not_owned|shift_not_open/);
  });

  it("ventas: cashier vende en su turno; viewer no vende", async () => {
    const s1 = await rpc(ctx.cashier.client, "create_sale", {
      p_items: saleItems(),
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(s1.error).toBeNull();
    ctx.saleToday = (s1.data as { sale_id: string }).sale_id;

    const s2 = await rpc(ctx.cashier.client, "create_sale", {
      p_items: saleItems(),
      p_payments: [{ method: "cash", amount: 100 }],
    });
    expect(s2.error).toBeNull();
    ctx.saleOld = (s2.data as { sale_id: string }).sale_id;

    const v = await rpc(ctx.viewer.client, "create_sale", {
      p_items: saleItems(),
      p_payments: [{ method: "cash", amount: 100 }],
      p_cash_shift_id: ctx.shiftCashier,
    });
    expect(v.error).not.toBeNull();

    // Lectura de ventas: viewer sí (solo lectura del negocio).
    const read = await ctx.viewer.client.from("sales").select("id").eq("id", ctx.saleToday);
    expect(read.data).toHaveLength(1);
  });

  it("anulación: nadie cambia el estado de una venta por REST", async () => {
    for (const u of [ctx.cashier, ctx.owner]) {
      const r = await u.client
        .from("sales")
        .update({ status: "voided" } as never)
        .eq("id", ctx.saleToday);
      expect(r.error?.message).toMatch(/use_void_sale/);
    }
  });

  it("anulación: viewer no anula; cashier anula sólo ventas del día; manager cualquier día", async () => {
    const v = await rpc(ctx.viewer.client, "void_sale", { p_sale_id: ctx.saleToday, p_reason: "test" });
    expect(v.error?.message).toMatch(/forbidden/);

    // Venta de hace dos días (fecha corrida con service_role).
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { error: bdErr } = await ctx.admin.from("sales").update({ created_at: old } as never).eq("id", ctx.saleOld);
    expect(bdErr).toBeNull();

    const past = await rpc(ctx.cashier.client, "void_sale", { p_sale_id: ctx.saleOld, p_reason: "test" });
    expect(past.error?.message).toMatch(/forbidden_void_past_day/);

    const today = await rpc(ctx.cashier.client, "void_sale", { p_sale_id: ctx.saleToday, p_reason: "test" });
    expect(today.error).toBeNull();

    const mgr = await rpc(ctx.manager.client, "void_sale", { p_sale_id: ctx.saleOld, p_reason: "test" });
    expect(mgr.error).toBeNull();

    const { data } = await ctx.admin.from("sales").select("id, status").in("id", [ctx.saleToday, ctx.saleOld]);
    expect((data as { status: string }[]).every((s) => s.status === "voided")).toBe(true);

    // La anulación (RPC DEFINER) revierte stock aunque el cajero no pueda tocarlo a mano.
    const { data: p } = await ctx.admin.from("products").select("stock").eq("id", ctx.saleProduct).single();
    expect(Number((p as { stock: number }).stock)).toBe(50);
  });

  // ---------------------------------------------------------------------------
  // Configuración comercial, medios de pago, impuestos y contabilidad
  // ---------------------------------------------------------------------------

  it("configuración: cashier y viewer no tocan listas, cuotas, POS, seguridad ni contabilidad", async () => {
    const mgr = await ctx.manager.client
      .from("price_lists")
      .insert({ tenant_id: ctx.tenant, name: `Lista ${STAMP}`, channel: "custom" } as never);
    expect(mgr.error).toBeNull();

    for (const u of [ctx.cashier, ctx.viewer]) {
      const list = await u.client
        .from("price_lists")
        .insert({ tenant_id: ctx.tenant, name: `Lista x ${STAMP}`, channel: "custom" } as never);
      expect(list.error).not.toBeNull();

      const plan = await u.client
        .from("payment_plans")
        .insert({ tenant_id: ctx.tenant, label: `Plan x ${STAMP}`, surcharge_pct: 5 } as never);
      expect(plan.error).not.toBeNull();

      const pos = await u.client.from("pos_settings").upsert({ tenant_id: ctx.tenant } as never);
      expect(pos.error).not.toBeNull();

      const sec = await rpc(u.client, "security_settings_save", { p: { shared_shift: true } });
      expect(sec.error?.message).toMatch(/forbidden/);

      const acc = await rpc(u.client, "acc_setup", { p: {} });
      expect(acc.error?.message).toMatch(/forbidden/);
    }
  });
});
