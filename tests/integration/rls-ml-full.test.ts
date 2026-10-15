// @vitest-environment node
// =============================================================================
// Mercado Libre Full (ADR-142, migraciones 20261209100000 a 20261209100200):
// aislamiento entre negocios, gating de mercadolibre_full, envío a Full con
// tránsito y conciliación, venta por Full que no toca el stock propio y
// auditoría.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// Las fechas se comparan en hora de Argentina (America/Argentina/Buenos_Aires).
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mlf-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ML_USER_A = 600000000 + Math.floor(Math.random() * 90_000_000);
const ML_USER_B = ML_USER_A + 1;
const ITEM_ID = `MLA${ML_USER_A}`;
const INV = `FULL${String(ML_USER_A).slice(-5)}`;
const ORDER_ID = String(3_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
const AR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

type User = { id: string; client: SupabaseClient };
const ctx = {} as {
  admin: SupabaseClient;
  tA: string;
  tB: string;
  tC: string;
  ownerA: User;
  cashierA: User;
  viewerA: User;
  ownerB: User;
  ownerC: User;
  userIds: string[];
  storeA: string;
  productA: string;
  accA: string;
  accB: string;
  inbound: string;
};

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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

async function ownQty(): Promise<number> {
  const { data } = await ctx.admin
    .from("product_stock")
    .select("qty")
    .eq("store_id", ctx.storeA)
    .eq("product_id", ctx.productA)
    .is("variant_id", null)
    .maybeSingle();
  return Number((data as { qty: number } | null)?.qty ?? 0);
}

describe.skipIf(!enabled)("Mercado Libre Full · depósito virtual, envíos y gating", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: t, error } = await admin
      .from("tenants")
      .insert([
        { name: `MLF A ${STAMP}`, slug: `mlfa-${STAMP}`, status: "active" },
        { name: `MLF B ${STAMP}`, slug: `mlfb-${STAMP}`, status: "active" },
        { name: `MLF C ${STAMP}`, slug: `mlfc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !t) throw error ?? new Error("tenants");
    const rows = t as { id: string; slug: string }[];
    ctx.tA = rows.find((x) => x.slug === `mlfa-${STAMP}`)!.id;
    ctx.tB = rows.find((x) => x.slug === `mlfb-${STAMP}`)!.id;
    ctx.tC = rows.find((x) => x.slug === `mlfc-${STAMP}`)!.id;

    // A y B con Mercado Libre y Full; C sólo con Mercado Libre (sin Full).
    const addons = [ctx.tA, ctx.tB].flatMap((tenant) =>
      ["mercadolibre", "mercadolibre_full"].map((k) => ({ tenant_id: tenant, addon_key: k, status: "active", source: "granted" })),
    );
    addons.push({ tenant_id: ctx.tC, addon_key: "mercadolibre", status: "active", source: "granted" });
    const { error: aErr } = await admin.from("subscription_addons").insert(addons);
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `mlfowa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.cashierA = await makeUser(admin, `mlfcja-${STAMP}@test.local`, ctx.tA, "cashier");
    ctx.viewerA = await makeUser(admin, `mlfvwa-${STAMP}@test.local`, ctx.tA, "viewer");
    ctx.ownerB = await makeUser(admin, `mlfowb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `mlfowc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.cashierA.id, ctx.viewerA.id, ctx.ownerB.id, ctx.ownerC.id);

    const sA = await ctx.ownerA.client.from("stores").insert({ name: "Centro Full" } as never).select("id").single();
    if (sA.error || !sA.data) throw sA.error ?? new Error("store A");
    ctx.storeA = (sA.data as { id: string }).id;
    const prods = await admin
      .from("products")
      .insert([{ tenant_id: ctx.tA, name: `Remera Full ${STAMP}`, sku: `RF-${STAMP}`, price: 1500, cost: 700, stock: 0 }])
      .select("id");
    if (prods.error || !prods.data) throw prods.error ?? new Error("products");
    ctx.productA = (prods.data[0] as { id: string }).id;
    const mv = await admin.from("stock_movements").insert({
      tenant_id: ctx.tA, product_id: ctx.productA, store_id: ctx.storeA, delta: 30, reason: "adjustment", notes: "inicial",
    });
    if (mv.error) throw mv.error;
    await admin.from("products").update({ stock: 30 }).eq("id", ctx.productA);

    const accs = await admin
      .from("ml_accounts")
      .insert([
        { tenant_id: ctx.tA, ml_user_id: ML_USER_A, nickname: "FULL_A", site_id: "MLA", invoice_mode: "manual" },
        { tenant_id: ctx.tB, ml_user_id: ML_USER_B, nickname: "FULL_B", site_id: "MLA", invoice_mode: "manual" },
      ])
      .select("id, tenant_id");
    if (accs.error || !accs.data) throw accs.error ?? new Error("accounts");
    ctx.accA = (accs.data as { id: string; tenant_id: string }[]).find((a) => a.tenant_id === ctx.tA)!.id;
    ctx.accB = (accs.data as { id: string; tenant_id: string }[]).find((a) => a.tenant_id === ctx.tB)!.id;
    await admin.from("ml_location_map").insert([{ tenant_id: ctx.tA, account_id: ctx.accA, location_type: "item_stock", store_id: ctx.storeA }]);

    const item = await rpc(admin, "ml_item_upsert", {
      p_account: ctx.accA,
      p: { ml_item_id: ITEM_ID, title: "Remera Full", status: "active", price: 1500, logistic_type: "fulfillment", stock_mode: "full_only" },
    });
    if (item.error) throw new Error(item.error.message);
    const link = await rpc(ctx.ownerA.client, "ml_item_link", { p_item: item.data, p_variation: null, p_product: ctx.productA, p_variant: null });
    if (link.error) throw new Error(link.error.message);
    // Lo que deja la Edge ml_full al sincronizar (service_role).
    const up = await rpc(admin, "ml_full_inventory_upsert", {
      p_account: ctx.accA,
      p: {
        complete: true,
        rows: [{ inventory_id: INV, ml_item_id: ITEM_ID, title: "Remera Full", total: 6, available_quantity: 4, not_available_quantity: 2, buckets: { damaged: 2 } }],
      },
    });
    if (up.error) throw new Error(up.error.message);
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tA) return;
    for (const t of [ctx.tA, ctx.tB, ctx.tC]) {
      await admin.from("ml_accounts").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el depósito Full se ve sólo en su negocio y nadie lo escribe por REST", async () => {
    const a = await ctx.ownerA.client.from("ml_full_inventory").select("inventory_id, available_quantity, damaged_qty, product_id");
    expect(a.data).toEqual([{ inventory_id: INV, available_quantity: 4, damaged_qty: 2, product_id: ctx.productA }]);
    const b = await ctx.ownerB.client.from("ml_full_inventory").select("id");
    expect(b.data).toEqual([]);
    const ins = await ctx.ownerA.client.from("ml_full_inbounds").insert({ tenant_id: ctx.tA, account_id: ctx.accA, number: 1, store_id: ctx.storeA } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.ownerA.client.from("ml_full_inventory").update({ available_quantity: 999 } as never).eq("inventory_id", INV);
    expect(upd.error).not.toBeNull();
  });

  it("gating: sin mercadolibre_full no se usa; solo lectura tampoco; otro negocio no ve la cuenta", async () => {
    expect((await rpc(ctx.ownerC.client, "ml_full_overview", { p_account: ctx.accA })).error?.message).toMatch(/feature_not_in_plan: mercadolibre_full/);
    expect((await rpc(ctx.viewerA.client, "ml_full_overview", { p_account: ctx.accA })).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.ownerB.client, "ml_full_overview", { p_account: ctx.accA })).error?.message).toMatch(/account_not_found/);
    const ok = await rpc(ctx.cashierA.client, "ml_full_overview", { p_account: ctx.accA });
    expect(ok.error).toBeNull();
    const r = (ok.data as { rows: Array<{ available: number; own_qty: number }> }).rows[0]!;
    expect(r).toMatchObject({ available: 4, own_qty: 30 });
  });

  it("envío a Full: borrador, despacho con tránsito, conciliación con faltante que vuelve", async () => {
    const save = await rpc(ctx.ownerA.client, "ml_full_inbound_save", {
      p_id: null,
      p: { account_id: ctx.accA, store_id: ctx.storeA, ml_inbound_id: `${ML_USER_A}`, boxes: 2, items: [{ product_id: ctx.productA, qty: 10 }] },
    });
    expect(save.error).toBeNull();
    ctx.inbound = save.data as string;
    expect((await rpc(ctx.cashierA.client, "ml_full_inbound_dispatch", { p_id: ctx.inbound })).error?.message).toMatch(/forbidden/);
    const d = await rpc(ctx.ownerA.client, "ml_full_inbound_dispatch", { p_id: ctx.inbound });
    expect(d.error).toBeNull();
    expect(await ownQty()).toBe(20);
    const ov = await rpc(ctx.ownerA.client, "ml_full_overview", { p_account: ctx.accA });
    expect((ov.data as { rows: Array<{ in_transit: number }> }).rows[0]!.in_transit).toBe(10);

    const { data: items } = await ctx.ownerA.client.from("ml_full_inbound_items").select("id").eq("inbound_id", ctx.inbound);
    const itemId = (items as { id: string }[])[0]!.id;
    const part = await rpc(ctx.cashierA.client, "ml_full_inbound_receive", { p_id: ctx.inbound, p_lines: [{ item_id: itemId, received: 8, damaged: 1 }], p_close: false });
    expect(part.error).toBeNull();
    expect((await rpc(ctx.cashierA.client, "ml_full_inbound_receive", { p_id: ctx.inbound, p_lines: [], p_close: true })).error?.message).toMatch(/forbidden/);
    const close = await rpc(ctx.ownerA.client, "ml_full_inbound_receive", {
      p_id: ctx.inbound,
      p_lines: [{ item_id: itemId, missing_action: "returned", missing_reason: "Quedó en el depósito" }],
      p_close: true,
    });
    expect(close.error).toBeNull();
    expect((close.data as { status: string }).status).toBe("closed_with_diff");
    expect(await ownQty()).toBe(21);

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, created_at")
      .eq("entity_id", ctx.inbound)
      .order("created_at");
    const actions = (logs as { action: string; created_at: string }[]).map((l) => l.action);
    expect(actions).toEqual([
      "ml_full_inbound_created",
      "ml_full_inbound_dispatched",
      "ml_full_inbound_counted",
      "ml_full_inbound_closed_with_diff",
    ]);
    // Auditado hoy en hora de Argentina.
    expect(AR_DAY.format(new Date((logs as { created_at: string }[]).at(-1)!.created_at))).toBe(AR_DAY.format(new Date()));
  });

  it("una venta despachada por Full no toca el stock propio y descuenta el depósito Full", async () => {
    const before = await ownQty();
    const res = await rpc(ctx.admin, "ml_ingest_pack", {
      p_account: ctx.accA,
      p: {
        pack_key: ORDER_ID,
        pack_id: null,
        orders: [{
          ml_order_id: ORDER_ID, status: "paid", tags: ["paid"], date_created: new Date().toISOString(), last_updated: new Date().toISOString(),
          total_amount: 3000, paid_amount: 3000, currency: "ARS", fraud_risk: false, buyer: { id: "1", nickname: "B" }, shipment_id: null,
          sale_fee_total: 300,
          lines: [{ ml_order_id: ORDER_ID, ml_item_id: ITEM_ID, ml_variation_id: null, title: "Remera Full", quantity: 2, unit_price: 1500 }],
        }],
        shipment: { shipment_id: 1, logistic_type: "fulfillment", mode: "me2", status: "ready_to_ship" },
        billing: null,
      },
    });
    expect(res.error).toBeNull();
    expect((res.data as { decision: string }).decision).toBe("create_sale");
    expect(await ownQty()).toBe(before);
    const { data: inv } = await ctx.admin.from("ml_full_inventory").select("pending_sales, stale_at").eq("inventory_id", INV).single();
    expect(inv).toMatchObject({ pending_sales: 2 });
    expect((inv as { stale_at: string | null }).stale_at).not.toBeNull();
  });

  it("los costos de Full sólo los ve dueño o encargado", async () => {
    const s = await rpc(ctx.admin, "ml_full_costs_save", {
      p_account: ctx.accA,
      p_period: `${AR_DAY.format(new Date()).slice(0, 7)}-01`,
      p: [{ charge_type: "CFS", label: "Cargo por almacenamiento en Full", amount: 1000 }],
    });
    expect(s.error).toBeNull();
    const c = await ctx.cashierA.client.from("ml_full_costs").select("id");
    expect(c.data).toEqual([]);
    const o = await ctx.ownerA.client.from("ml_full_costs").select("amount");
    expect(o.data).toHaveLength(1);
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const r = await rpc(ctx.admin, fn);
      expect(r.error).toBeNull();
      const mine = ((r.data ?? []) as { tablename: string }[]).filter((x) => x.tablename.startsWith("ml_full"));
      expect(mine).toEqual([]);
    }
  });
});
