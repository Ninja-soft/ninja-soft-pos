// @vitest-environment node
// =============================================================================
// F11 (ADR-085): depósitos internos (H33), importación de depósitos (H34) e
// ítems vendidos en el Cierre Z (H30b).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: un negocio con la feature `depositos` (dueño, cajero y solo
// lectura) y otro negocio sin la feature. El cajero vende en SU turno, abierto
// por él. audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `dep-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  tenantB: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  viewer: SupabaseClient;
  ownerB: SupabaseClient;
  userIds: string[];
  store: string;
  storeB: string;
  product: string;
  productB: string;
  principal: string;
  reserva: string;
  register: string;
  shiftCashier: string;
};
const ctx = {} as Ctx;

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string) {
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

const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;

async function principalQty(): Promise<number> {
  const { data, error } = await rpc(ctx.owner, "warehouse_stock_overview", { p_store_id: ctx.store });
  if (error) throw new Error(error.message);
  const row = (data as { product_id: string; principal_qty: number }[]).find((r) => r.product_id === ctx.product);
  return Number(row?.principal_qty ?? 0);
}

describe.skipIf(!enabled)("F11 · depósitos internos y Z con ítems (ADR-085)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const tenants = await admin
      .from("tenants")
      .insert([
        { name: `Dep ${STAMP}`, slug: `d-${STAMP}`, status: "active" },
        { name: `DepB ${STAMP}`, slug: `db-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (tenants.error || !tenants.data) throw tenants.error ?? new Error("tenants");
    ctx.tenant = tenants.data.find((t) => t.slug === `d-${STAMP}`)!.id;
    ctx.tenantB = tenants.data.find((t) => t.slug === `db-${STAMP}`)!.id;

    // Sólo el negocio A tiene depósitos (e importación). Todas las claves en
    // cada fila del insert múltiple.
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["depositos", "importacion_excel"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajero-${STAMP}@test.local`, ctx.tenant, "cashier");
    const viewer = await makeUser(admin, `lector-${STAMP}@test.local`, ctx.tenant, "viewer");
    const ownerB = await makeUser(admin, `ownerb-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.owner = owner.client;
    ctx.cashier = cashier.client;
    ctx.viewer = viewer.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(owner.id, cashier.id, viewer.id, ownerB.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;
    const stB = await ownerB.client.from("stores").insert({ name: "Otra" } as never).select("id").single();
    if (stB.error || !stB.data) throw stB.error ?? new Error("storeB");
    ctx.storeB = (stB.data as unknown as { id: string }).id;

    const prods = await admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenant, name: `Remera ${STAMP}`, sku: `REM-${STAMP}`, price: 100, cost: 50, stock: 20 },
        { tenant_id: ctx.tenantB, name: `Otro ${STAMP}`, sku: `OTR-${STAMP}`, price: 100, cost: 50, stock: 5 },
      ])
      .select("id, tenant_id");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    ctx.product = prods.data.find((p) => p.tenant_id === ctx.tenant)!.id;
    ctx.productB = prods.data.find((p) => p.tenant_id === ctx.tenantB)!.id;

    const reg = await owner.client
      .from("cash_registers")
      .insert({ store_id: ctx.store, name: "Caja 1" } as never)
      .select("id")
      .single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    ctx.register = (reg.data as unknown as { id: string }).id;

    // El cajero abre SU turno.
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shiftCashier = sh.data as string;
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    for (const t of [ctx.tenant, ctx.tenantB]) {
      await admin.from("warehouse_moves" as never).delete().eq("tenant_id", t);
      await admin.from("warehouse_stock" as never).delete().eq("tenant_id", t);
      await admin.from("warehouses" as never).delete().eq("tenant_id", t);
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

  it("el dueño crea un depósito y el salón se crea solo", async () => {
    const r = await rpc(ctx.owner, "warehouse_save", { p_id: null, p_store_id: ctx.store, p_name: "Reserva", p_kind: "reserva" });
    expect(r.error).toBeNull();
    ctx.reserva = r.data as string;
    const { data } = await ctx.owner.from("warehouses" as never).select("id, kind").eq("store_id", ctx.store);
    const list = (data ?? []) as unknown as { id: string; kind: string }[];
    expect(list.map((w) => w.kind).sort()).toEqual(["principal", "reserva"]);
    ctx.principal = list.find((w) => w.kind === "principal")!.id;
  });

  it("el cajero y solo lectura no crean depósitos ni cuentan", async () => {
    for (const c of [ctx.cashier, ctx.viewer]) {
      const r = await rpc(c, "warehouse_save", { p_id: null, p_store_id: ctx.store, p_name: "X", p_kind: "otro" });
      expect(r.error?.message).toMatch(/forbidden/);
      const s = await rpc(c, "warehouse_stock_set", {
        p_warehouse_id: ctx.reserva,
        p_product_id: ctx.product,
        p_variant_id: null,
        p_qty: 1,
      });
      expect(s.error?.message).toMatch(/forbidden/);
    }
  });

  it("nadie escribe las tablas por REST (sólo RPC)", async () => {
    const { error } = await ctx.owner.from("warehouse_stock" as never).insert({
      tenant_id: ctx.tenant,
      warehouse_id: ctx.reserva,
      store_id: ctx.store,
      product_id: ctx.product,
      variant_id: null,
      qty: 99,
    } as never);
    expect(error).not.toBeNull();
    const { error: e2 } = await ctx.cashier.from("warehouses" as never).insert({
      tenant_id: ctx.tenant,
      store_id: ctx.store,
      name: "Trucho",
      kind: "otro",
    } as never);
    expect(e2).not.toBeNull();
  });

  it("conteo de la reserva: mueve desde el salón sin cambiar la sucursal", async () => {
    const r = await rpc(ctx.owner, "warehouse_stock_set", {
      p_warehouse_id: ctx.reserva,
      p_product_id: ctx.product,
      p_variant_id: null,
      p_qty: 12,
    });
    expect(r.error).toBeNull();
    expect(await principalQty()).toBe(8);
    const { data: ps } = await ctx.owner
      .from("product_stock" as never)
      .select("qty")
      .eq("store_id", ctx.store)
      .eq("product_id", ctx.product)
      .single();
    expect(Number((ps as unknown as { qty: number }).qty)).toBe(20);
  });

  it("movimiento en tránsito: el cajero recibe en parte pero no cierra con diferencias", async () => {
    const mv = await rpc(ctx.owner, "warehouse_move_create", {
      p_origin: ctx.reserva,
      p_dest: ctx.principal,
      p_items: [{ product_id: ctx.product, variant_id: null, qty: 5 }],
      p_reason: "reposicion",
    });
    expect(mv.error).toBeNull();
    const moveId = mv.data as string;
    const { data: items } = await ctx.cashier.from("warehouse_move_items" as never).select("id").eq("move_id", moveId);
    const itemId = ((items ?? []) as unknown as { id: string }[])[0]!.id;

    const part = await rpc(ctx.cashier, "warehouse_move_receive", {
      p_move_id: moveId,
      p_items: [{ item_id: itemId, qty: 3 }],
      p_close: false,
    });
    expect(part.error).toBeNull();
    expect(part.data).toBe("partially_received");

    const bad = await rpc(ctx.cashier, "warehouse_move_receive", {
      p_move_id: moveId,
      p_items: [{ item_id: itemId, qty: 0, reason: "faltante" }],
      p_close: true,
    });
    expect(bad.error?.message).toMatch(/forbidden_differences/);

    const view = await rpc(ctx.viewer, "warehouse_move_receive", { p_move_id: moveId, p_items: [], p_close: false });
    expect(view.error?.message).toMatch(/forbidden/);

    const close = await rpc(ctx.owner, "warehouse_move_receive", {
      p_move_id: moveId,
      p_items: [{ item_id: itemId, qty: 0, reason: "faltante" }],
      p_close: true,
    });
    expect(close.error).toBeNull();
    // Faltante de 2: sale de la sucursal como merma; el salón queda en 11.
    expect(await principalQty()).toBe(11);
    const mm = await rpc(ctx.admin, "product_stock_mismatches", { p_tenant: ctx.tenant });
    expect(mm.error).toBeNull();
    expect(mm.data ?? []).toEqual([]);
  });

  it("la venta del cajero en su turno descuenta del salón", async () => {
    const before = await principalQty();
    const s = await rpc(ctx.cashier, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 2, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 200 }],
      p_cash_shift_id: ctx.shiftCashier,
    });
    expect(s.error).toBeNull();
    expect(await principalQty()).toBe(before - 2);
  });

  it("H30b: el Z del turno guarda los ítems vendidos resumidos", async () => {
    const c = await rpc(ctx.cashier, "close_cash_shift", { p_shift_id: ctx.shiftCashier, p_closing_amount: 200 });
    expect(c.error).toBeNull();
    const { data } = await ctx.cashier
      .from("cash_z_closures")
      .select("items_summary")
      .eq("cash_shift_id", ctx.shiftCashier)
      .single();
    const items = (data as unknown as { items_summary: { product_id: string; qty: number; total: number }[] })
      .items_summary;
    expect(items).toEqual([expect.objectContaining({ product_id: ctx.product, qty: 2, total: 200 })]);
  });

  it("aislamiento: otro negocio no ve los depósitos y sin la feature el servidor rechaza", async () => {
    const { data } = await ctx.ownerB.from("warehouses" as never).select("id").eq("store_id", ctx.store);
    expect(data ?? []).toEqual([]);
    const r = await rpc(ctx.ownerB, "warehouse_save", { p_id: null, p_store_id: ctx.storeB, p_name: "Reserva", p_kind: "reserva" });
    expect(r.error?.message).toMatch(/feature_not_in_plan: depositos/);
    const x = await rpc(ctx.ownerB, "warehouse_stock_overview", { p_store_id: ctx.store });
    expect(x.error).not.toBeNull();
  });

  it("H34: importación de depósitos en seco no escribe y aplicada audita", async () => {
    const rows = [{ _row: 2, name: "Fondo", code: `F-${STAMP}`.slice(0, 20), kind: "otro" }];
    const dry = await rpc(ctx.owner, "import_warehouses", { p_rows: rows, p_apply: false });
    expect(dry.error).toBeNull();
    expect((dry.data as { created: number }).created).toBe(1);
    const { data: none } = await ctx.owner.from("warehouses" as never).select("id").eq("name", "Fondo");
    expect(none ?? []).toEqual([]);

    const ok = await rpc(ctx.owner, "import_warehouses", { p_rows: rows, p_apply: true, p_file_name: "dep.xlsx" });
    expect(ok.error).toBeNull();
    const { data: one } = await ctx.owner.from("warehouses" as never).select("id").eq("name", "Fondo");
    expect(one ?? []).toHaveLength(1);

    const cajero = await rpc(ctx.cashier, "import_warehouses", { p_rows: rows, p_apply: false });
    expect(cajero.error?.message).toMatch(/forbidden/);
  });
});
