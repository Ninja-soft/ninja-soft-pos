// @vitest-environment node
// =============================================================================
// ADR-136: depósitos vendibles por sucursal, venta de stock de otra sucursal y
// entregas partidas, con el create_sale real.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// Las fechas se comparan en hora de Argentina (America/Argentina/Buenos_Aires).
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `adr136-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const AR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  cashierNorte: SupabaseClient;
  viewer: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  centro: string;
  norte: string;
  shift: string;
  campera: string;
  depNorte: string;
  saleId: string;
  partNorte: string;
  pickupCode: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const storeQty = async (store: string) => {
  const { data } = await ctx.admin
    .from("product_stock" as never)
    .select("qty")
    .eq("store_id", store)
    .eq("product_id", ctx.campera)
    .is("variant_id", null)
    .maybeSingle();
  return Number((data as { qty?: number } | null)?.qty ?? 0);
};

describe.skipIf(!enabled)("ADR-136 · venta de otra sucursal y entregas partidas (RLS + create_sale real)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `ADR136 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `ADR136 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["depositos", "multi_sucursal", "stock_sucursales", "pedidos_despacho", "entregas_remitos"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const cashierNorte = await makeUser(admin, `norte-${STAMP}@test.local`, ctx.tenant, "cashier");
    const viewer = await makeUser(admin, `viewer-${STAMP}@test.local`, ctx.tenant, "viewer");
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, cashierNorte: cashierNorte.client, viewer: viewer.client, stranger: stranger.client });
    ctx.userIds.push(owner.id, cashier.id, cashierNorte.id, viewer.id, stranger.id);

    for (const [k, name] of [["centro", "Centro"], ["norte", "Norte"]] as const) {
      const st = await owner.client.from("stores").insert({ name } as never).select("id").single();
      if (st.error || !st.data) throw st.error ?? new Error("store");
      ctx[k] = (st.data as unknown as { id: string }).id;
    }
    const ps = await admin.from("pos_settings").upsert({ tenant_id: ctx.tenant, allow_negative_stock: false } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, cost: 50, stock: 0, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.campera = (prod.data as { id: string }).id;
    for (const [store, qty] of [[ctx.centro, 2], [ctx.norte, 10]] as const) {
      const adj = await rpc(owner.client, "adjust_store_stock", {
        p_store_id: store,
        p_product_id: ctx.campera,
        p_variant_id: null,
        p_qty: qty,
        p_mode: "set",
        p_reason: "Inventario inicial",
        p_notes: null,
      });
      if (adj.error) throw new Error(adj.error.message);
    }

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.centro, name: "Caja Centro" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("dispatch_items" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("dispatches" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("warehouse_store_links" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("warehouse_stock" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("warehouses" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("la dueña arma el Depósito Norte y lo habilita para Centro; el cajero no puede", async () => {
    const w = await rpc(ctx.owner, "warehouse_save", { p_id: null, p_store_id: ctx.norte, p_name: "Depósito Norte", p_kind: "reserva" });
    expect(w.error).toBeNull();
    ctx.depNorte = w.data as string;
    expect((await rpc(ctx.owner, "warehouse_stock_set", { p_warehouse_id: ctx.depNorte, p_product_id: ctx.campera, p_variant_id: null, p_qty: 6, p_notes: null })).error).toBeNull();
    const denied = await rpc(ctx.cashier, "warehouse_config_save", { p_id: ctx.depNorte, p_sellable: true, p_priority: 10, p_store_ids: [ctx.centro] });
    expect(denied.error?.message).toMatch(/forbidden/);
    const cfg = await rpc(ctx.owner, "warehouse_config_save", { p_id: ctx.depNorte, p_sellable: true, p_priority: 10, p_store_ids: [ctx.centro] });
    expect(cfg.error).toBeNull();
    const { error } = await ctx.owner.from("warehouse_store_links" as never).insert({ tenant_id: ctx.tenant, warehouse_id: ctx.depNorte, store_id: ctx.norte } as never);
    expect(error).not.toBeNull();
  });

  it("el POS de Centro ve el Depósito Norte como origen", async () => {
    const r = await rpc(ctx.cashier, "warehouse_sources", { p_store_id: ctx.centro, p_items: [{ product_id: ctx.campera, variant_id: null }] });
    expect(r.error).toBeNull();
    const rows = r.data as { warehouse_id: string | null; own_store: boolean; available: number }[];
    expect(rows.find((s) => s.own_store)?.available).toBe(2);
    expect(rows.find((s) => s.warehouse_id === ctx.depNorte)?.available).toBe(6);
    const v = await rpc(ctx.viewer, "warehouse_sources", { p_store_id: ctx.centro, p_items: [] });
    expect(v.error?.message).toMatch(/forbidden/);
  });

  it("vende 5: 2 se lleva ahora y 3 retira en Norte, en una sola transacción", async () => {
    const before = { centro: await storeQty(ctx.centro), norte: await storeQty(ctx.norte) };
    const r = await rpc(ctx.cashier, "pos_sale_create_fulfilled", {
      p_sale: {
        p_items: [{ product_id: ctx.campera, quantity: 5, unit_price: 100, discount: 0 }],
        p_payments: [{ method: "cash", amount: 500 }],
        p_cash_shift_id: ctx.shift,
      },
      p_plan: {
        deliveries: [
          { mode: "ahora", items: [{ product_id: ctx.campera, variant_id: null, qty: 2 }] },
          {
            mode: "retiro",
            fulfillment_store_id: ctx.norte,
            pickup_name: "Ana Pérez",
            items: [{ product_id: ctx.campera, variant_id: null, qty: 3, source_store_id: ctx.norte, source_warehouse_id: ctx.depNorte }],
          },
        ],
      },
    });
    expect(r.error).toBeNull();
    const out = r.data as { sale_id: string; deliveries: { id: string; mode: string; pickup_code: string | null }[] };
    ctx.saleId = out.sale_id;
    expect(out.deliveries).toHaveLength(2);
    const norte = out.deliveries.find((d) => d.mode === "retiro")!;
    ctx.partNorte = norte.id;
    ctx.pickupCode = norte.pickup_code ?? "";
    expect(await storeQty(ctx.centro)).toBe(before.centro - 2);
    expect(await storeQty(ctx.norte)).toBe(before.norte - 3);
    const mm = await rpc(ctx.admin, "product_stock_mismatches", { p_tenant: ctx.tenant });
    expect((mm.data as unknown[] | null) ?? []).toHaveLength(0);

    const { data: parts } = await ctx.cashier
      .from("dispatches" as never)
      .select("part, parts_total, status, store_id, sale_store_id, created_at")
      .eq("sale_id", ctx.saleId)
      .order("part");
    const list = (parts ?? []) as unknown as { part: number; status: string; store_id: string; sale_store_id: string; created_at: string }[];
    expect(list.map((p) => p.status)).toEqual(["entregado", "pendiente"]);
    expect(list[1]!.store_id).toBe(ctx.norte);
    expect(list[1]!.sale_store_id).toBe(ctx.centro);
    expect(AR_DAY.format(new Date(list[0]!.created_at))).toBe(AR_DAY.format(new Date()));
  });

  it("si no alcanza en el origen, no se vende nada", async () => {
    const before = await storeQty(ctx.norte);
    const r = await rpc(ctx.cashier, "pos_sale_create_fulfilled", {
      p_sale: { p_items: [{ product_id: ctx.campera, quantity: 9, unit_price: 100, discount: 0 }], p_payments: [{ method: "cash", amount: 900 }], p_cash_shift_id: ctx.shift },
      p_plan: { deliveries: [{ mode: "retiro", items: [{ product_id: ctx.campera, variant_id: null, qty: 9, source_store_id: ctx.norte, source_warehouse_id: ctx.depNorte }] }] },
    });
    expect(r.error?.message).toMatch(/insufficient_source_stock/);
    expect(await storeQty(ctx.norte)).toBe(before);
  });

  it("Norte arma y entrega su parte con el código", async () => {
    for (const to of ["armando", "listo"]) {
      expect((await rpc(ctx.owner, "dispatch_advance", { p_id: ctx.partNorte, p_to: to })).error).toBeNull();
    }
    const d = await rpc(ctx.owner, "dispatch_deliver", { p_id: ctx.partNorte, p_code: ctx.pickupCode, p_delivered_to: "Ana Pérez", p_override_reason: null });
    expect((d.data as { ok: boolean }).ok).toBe(true);
  });

  it("otro negocio no ve entregas, renglones ni vínculos; nadie escribe por REST", async () => {
    for (const t of ["dispatch_items", "dispatches", "warehouse_store_links"]) {
      const { data } = await ctx.stranger.from(t as never).select("id");
      expect(data ?? []).toHaveLength(0);
    }
    const { error } = await ctx.cashier.from("dispatch_items" as never).insert({ tenant_id: ctx.tenant } as never);
    expect(error).not.toBeNull();
  });
});
