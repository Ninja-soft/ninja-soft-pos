// @vitest-environment node
// =============================================================================
// ADR-149 · F22 · H143 (L0): circuito venta repartida → agregar entrega →
// cancelar la parte cruzada → anular, con el stock correcto en cada sucursal y
// depósito; la sucursal que vendió opera; modo de entrega de la venta; un
// remito activo por venta y producto; aislamiento entre negocios.
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

const STAMP = `adr149-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const AR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  cashierNorte: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  centro: string;
  norte: string;
  shift: string;
  mesa: string;
  depNorte: string;
  saleId: string;
  partNorte: string;
  /** ADR-157: el envío exige cliente en la venta. */
  customer: string;
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
    .eq("product_id", ctx.mesa)
    .is("variant_id", null)
    .maybeSingle();
  return Number((data as { qty?: number } | null)?.qty ?? 0);
};
const depQty = async () => {
  const { data } = await ctx.admin
    .from("warehouse_stock" as never)
    .select("qty")
    .eq("warehouse_id", ctx.depNorte)
    .eq("product_id", ctx.mesa)
    .maybeSingle();
  return Number((data as { qty?: number } | null)?.qty ?? 0);
};
const saleMode = async (saleId: string) => {
  const { data } = await ctx.owner.from("sales").select("fulfillment_mode" as never).eq("id", saleId).maybeSingle();
  return (data as { fulfillment_mode?: string } | null)?.fulfillment_mode;
};

describe.skipIf(!enabled)("ADR-149 · L0: entregas, anulación y stock por sucursal (RLS + RPC reales)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `ADR149 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `ADR149 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
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
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, cashierNorte: cashierNorte.client, stranger: stranger.client });
    ctx.userIds.push(owner.id, cashier.id, cashierNorte.id, stranger.id);

    for (const [k, name] of [["centro", "Centro"], ["norte", "Norte"]] as const) {
      const st = await owner.client.from("stores").insert({ name } as never).select("id").single();
      if (st.error || !st.data) throw st.error ?? new Error("store");
      ctx[k] = (st.data as unknown as { id: string }).id;
    }
    const ps = await admin.from("pos_settings").upsert({ tenant_id: ctx.tenant, allow_negative_stock: true } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Mesa ${STAMP}`, price: 1000, cost: 500, stock: 0, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.mesa = (prod.data as { id: string }).id;
    const cust = await admin.from("customers").insert({ tenant_id: ctx.tenant, name: `Juan ${STAMP}` }).select("id").single();
    if (cust.error || !cust.data) throw cust.error ?? new Error("customer");
    ctx.customer = (cust.data as { id: string }).id;
    for (const store of [ctx.centro, ctx.norte]) {
      const adj = await rpc(owner.client, "adjust_store_stock", {
        p_store_id: store,
        p_product_id: ctx.mesa,
        p_variant_id: null,
        p_qty: 5,
        p_mode: "set",
        p_reason: "adjustment",
        p_notes: null,
      });
      if (adj.error) throw new Error(adj.error.message);
    }
    const w = await rpc(owner.client, "warehouse_save", { p_id: null, p_store_id: ctx.norte, p_name: "Depósito Norte", p_kind: "reserva" });
    if (w.error) throw new Error(w.error.message);
    ctx.depNorte = w.data as string;
    const ws = await rpc(owner.client, "warehouse_stock_set", { p_warehouse_id: ctx.depNorte, p_product_id: ctx.mesa, p_variant_id: null, p_qty: 3, p_notes: null });
    if (ws.error) throw new Error(ws.error.message);
    const cfg = await rpc(owner.client, "warehouse_config_save", { p_id: ctx.depNorte, p_sellable: true, p_priority: 10, p_store_ids: [ctx.centro] });
    if (cfg.error) throw new Error(cfg.error.message);

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.centro, name: "Caja Centro" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("remito_items" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("remitos" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("remito_points" as never).delete().eq("tenant_id", ctx.tenant);
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

  it("vende 6 repartidas: 3 se lleva en Centro y 3 retira en Norte desde su depósito", async () => {
    const r = await rpc(ctx.cashier, "pos_sale_create_fulfilled", {
      p_sale: {
        p_items: [{ product_id: ctx.mesa, quantity: 6, unit_price: 1000, discount: 0 }],
        p_payments: [{ method: "cash", amount: 6000 }],
        p_cash_shift_id: ctx.shift,
        // ADR-157: la entrega por envío que se agrega después pide cliente.
        p_customer_id: ctx.customer,
      },
      p_plan: {
        deliveries: [
          { mode: "ahora", items: [{ product_id: ctx.mesa, variant_id: null, qty: 3 }] },
          {
            mode: "retiro",
            fulfillment_store_id: ctx.norte,
            pickup_name: "Ana Pérez",
            items: [{ product_id: ctx.mesa, variant_id: null, qty: 3, source_store_id: ctx.norte, source_warehouse_id: ctx.depNorte }],
          },
        ],
      },
    });
    expect(r.error).toBeNull();
    const out = r.data as { sale_id: string; deliveries: { id: string; mode: string }[] };
    ctx.saleId = out.sale_id;
    ctx.partNorte = out.deliveries.find((d) => d.mode === "retiro")!.id;
    expect(await storeQty(ctx.centro)).toBe(2);
    expect(await storeQty(ctx.norte)).toBe(2);
    expect(await depQty()).toBe(0);
    expect(await saleMode(ctx.saleId)).toBe("retiro");
  });

  it("A1: con todo repartido no se puede agregar otra entrega", async () => {
    const r = await rpc(ctx.cashier, "dispatch_create_for_sale", {
      p_sale_id: ctx.saleId,
      p_delivery: { delivery_type: "envio", ship_address: "Calle 9 100, Tigre" },
    });
    expect(r.error?.message).toMatch(/nothing_pending/);
    const p = await rpc(ctx.cashier, "dispatch_sale_pending", { p_sale_id: ctx.saleId });
    expect(Number((p.data as { items: { pending: number }[] }).items[0]!.pending)).toBe(0);
  });

  it("A4: Centro (vendió) ve y opera la parte de Norte", async () => {
    const { data } = await ctx.cashier.from("dispatches" as never).select("id").eq("id", ctx.partNorte);
    expect(data ?? []).toHaveLength(1);
    expect((await rpc(ctx.cashier, "dispatch_advance", { p_id: ctx.partNorte, p_to: "armando" })).error).toBeNull();
  });

  it("A3: cancelar la parte cruzada devuelve el stock al depósito de Norte", async () => {
    const c = await rpc(ctx.owner, "dispatch_cancel", { p_id: ctx.partNorte, p_reason: "El cliente cambió de idea" });
    expect(c.error).toBeNull();
    expect(await depQty()).toBe(3);
    expect(await storeQty(ctx.norte)).toBe(5);
    expect(await storeQty(ctx.centro)).toBe(-1);
    expect(await saleMode(ctx.saleId)).toBe("en_mostrador");
  });

  it("A1: ahora sí suma una entrega con lo que falta, de 3 de 3", async () => {
    const r = await rpc(ctx.cashier, "dispatch_create_for_sale", {
      p_sale_id: ctx.saleId,
      p_delivery: { delivery_type: "envio", ship_address: "Calle 9 100, Tigre" },
    });
    expect(r.error).toBeNull();
    const { data } = await ctx.cashier
      .from("dispatches" as never)
      .select("part, parts_total, status, created_at")
      .eq("id", (r.data as { id: string }).id)
      .single();
    const row = data as unknown as { part: number; parts_total: number; status: string; created_at: string };
    expect([row.part, row.parts_total, row.status]).toEqual([3, 3, "pendiente"]);
    expect(AR_DAY.format(new Date(row.created_at))).toBe(AR_DAY.format(new Date()));
    expect(await saleMode(ctx.saleId)).toBe("envio");
  });

  it("A13: un remito por venta y producto", async () => {
    const id1 = crypto.randomUUID();
    const r1 = await rpc(ctx.cashier, "remito_issue", { p_id: id1, p_data: { sale_id: ctx.saleId, receiver_name: "Juan Pérez" } });
    expect(r1.error).toBeNull();
    const pv = await rpc(ctx.cashier, "remito_preview", { p_data: { sale_id: ctx.saleId } });
    expect((pv.data as { items: unknown[] }).items).toHaveLength(0);
    const r2 = await rpc(ctx.cashier, "remito_issue", { p_id: crypto.randomUUID(), p_data: { sale_id: ctx.saleId, receiver_name: "Juan Pérez" } });
    expect(r2.error?.message).toMatch(/remito_already_covered/);
    const v = await rpc(ctx.owner, "remito_void", { p_id: id1, p_reason: "Prueba de L0" });
    expect(v.error).toBeNull();
  });

  it("A2: anular la venta cancela la entrega abierta y el stock vuelve a como estaba", async () => {
    const v = await rpc(ctx.owner, "void_sale", { p_sale_id: ctx.saleId, p_reason: "Prueba ADR-149" });
    expect(v.error).toBeNull();
    expect(await storeQty(ctx.centro)).toBe(5);
    expect(await storeQty(ctx.norte)).toBe(5);
    expect(await depQty()).toBe(3);
    const { data } = await ctx.owner.from("dispatches" as never).select("part, status").eq("sale_id", ctx.saleId).order("part");
    expect((data as unknown as { status: string }[]).map((d) => d.status)).toEqual(["entregado", "cancelado", "cancelado"]);
    const mm = await rpc(ctx.admin, "product_stock_mismatches", { p_tenant: ctx.tenant });
    expect((mm.data as unknown[] | null) ?? []).toHaveLength(0);
  });

  it("otro negocio no ve entregas ni lo pendiente; nadie escribe por REST", async () => {
    const { data } = await ctx.stranger.from("dispatches" as never).select("id");
    expect(data ?? []).toHaveLength(0);
    const p = await rpc(ctx.stranger, "dispatch_sale_pending", { p_sale_id: ctx.saleId });
    expect(p.error?.message).toMatch(/sale_not_found/);
    const pv = await rpc(ctx.stranger, "remito_preview", { p_data: { sale_id: ctx.saleId } });
    expect(pv.error?.message).toMatch(/sale_not_found/);
    const { error } = await ctx.cashier.from("dispatches" as never).update({ status: "entregado" } as never).eq("sale_id", ctx.saleId);
    expect(error).not.toBeNull();
  });
});
