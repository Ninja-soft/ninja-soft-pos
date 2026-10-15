// @vitest-environment node
// =============================================================================
// H32 · ADR-129: pedidos de salón, reserva por minutos y expedición.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// La cajera cobra en SU turno, abierto por ella, con el create_sale real.
// audit_logs es inmutable (ADR-083): el cleanup no la toca.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `h32-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  seller: SupabaseClient;
  viewer: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  cashierId: string;
  sellerId: string;
  store: string;
  shift: string;
  campera: string;
  professional: string;
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

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const cart = { v: 1, lines: [{ lineId: "l1", productId: "x", name: "Campera", unitPrice: 100, quantity: 3, discount: 0, unit: "un" }], discountTotal: 0, couponCode: null, customer: null, offeredWarrantyId: "", pricing: { listId: null, termId: null }, notes: null };

async function createOrder(c: SupabaseClient, qty: number, extra: Record<string, unknown> = {}) {
  return rpc(c, "sale_order_create", {
    p_id: crypto.randomUUID(),
    p_store_id: ctx.store,
    p_order: {
      cart,
      checkout: null,
      items: [{ product_id: ctx.campera, variant_id: null, qty }],
      total: qty * 100,
      item_count: qty,
      delivery_type: "retiro",
      pickup_name: "Ana",
      ...extra,
    },
  });
}

const sale = (qty: number, extras: Record<string, unknown>[] = []) =>
  rpc(ctx.cashier, "create_sale", {
    p_items: [{ product_id: ctx.campera, quantity: qty, unit_price: 100, discount: 0 }],
    p_payments: [{ method: "cash", amount: qty * 100 }],
    p_extras: extras,
    p_cash_shift_id: ctx.shift,
  });

describe.skipIf(!enabled)("H32 · pedidos de salón y expedición (RLS + create_sale real)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const t = await admin.from("tenants").insert({ name: `H32 ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `H32 B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;

    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["pedidos_despacho", "reservas_stock"].map((key) => ({
        tenant_id: ctx.tenant,
        addon_key: key,
        status: "active",
        source: "granted",
      })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const seller = await makeUser(admin, `vendedor-${STAMP}@test.local`, ctx.tenant, "cashier");
    const viewer = await makeUser(admin, `viewer-${STAMP}@test.local`, ctx.tenant, "viewer");
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, {
      owner: owner.client,
      cashier: cashier.client,
      seller: seller.client,
      viewer: viewer.client,
      stranger: stranger.client,
      cashierId: cashier.id,
      sellerId: seller.id,
    });
    ctx.userIds.push(owner.id, cashier.id, seller.id, viewer.id, stranger.id);

    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;

    const ps = await admin
      .from("pos_settings")
      .upsert({ tenant_id: ctx.tenant, allow_negative_stock: false } as never, { onConflict: "tenant_id" });
    if (ps.error) throw ps.error;

    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, cost: 50, stock: 10, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.campera = (prod.data as { id: string }).id;

    const pr = (await admin
      .from("professionals" as never)
      .insert({ tenant_id: ctx.tenant, name: "Juan vendedor", user_id: seller.id, is_active: true } as never)
      .select("id")
      .single()) as unknown as { data: { id: string } | null; error: Error | null };
    if (pr.error || !pr.data) throw pr.error ?? new Error("professional");
    ctx.professional = pr.data.id;

    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja 1" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", {
      p_register_id: (reg.data as unknown as { id: string }).id,
      p_opening_amount: 0,
    });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("dispatches" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("stock_reservations" as never).update({ sale_order_id: null } as never).eq("tenant_id", ctx.tenant);
    await admin.from("sale_orders" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("stock_reservations" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("criterio H32: el vendedor reserva, la cajera levanta y cobra, expedición entrega", async () => {
    const created = await createOrder(ctx.seller, 3);
    expect(created.error).toBeNull();
    const out = created.data as { id: string; number: number; reservation_id: string; pickup_code: string };
    expect(out.reservation_id).toBeTruthy();
    expect(out.pickup_code).toMatch(/^[0-9]{6}$/);

    // La venta de mostrador no consume lo reservado (10 − 3 = 7).
    const over = await sale(8);
    expect(over.error?.message).toMatch(/insufficient_stock_reserved/);

    const taken = await rpc(ctx.cashier, "sale_order_take", { p_id: out.id });
    expect(taken.error).toBeNull();
    const o = taken.data as { status: string; reservation_active: boolean; seller_professional_id: string };
    expect(o.status).toBe("tomado");
    expect(o.reservation_active).toBe(true);
    expect(o.seller_professional_id).toBe(ctx.professional);

    const paid = await sale(3, [
      { kind: "reservation", id: out.reservation_id },
      { kind: "professional", id: ctx.professional },
    ]);
    expect(paid.error).toBeNull();
    const saleId = (paid.data as { sale_id: string }).sale_id;

    const { data: row } = await ctx.cashier
      .from("sale_orders" as never)
      .select("status, sale_id, cashier_user_id")
      .eq("id", out.id)
      .single();
    expect(row).toMatchObject({ status: "cobrado", sale_id: saleId, cashier_user_id: ctx.cashierId });
    const { data: s } = await ctx.admin.from("sales").select("professional_id").eq("id", saleId).single();
    expect((s as { professional_id: string }).professional_id).toBe(ctx.professional);

    const { data: d } = await ctx.cashier
      .from("dispatches" as never)
      .select("id, status, has_pickup_code")
      .eq("sale_id", saleId)
      .single();
    const disp = d as unknown as { id: string; status: string; has_pickup_code: boolean };
    expect(disp.status).toBe("pendiente");
    expect(disp.has_pickup_code).toBe(true);

    expect((await rpc(ctx.cashier, "dispatch_advance", { p_id: disp.id, p_to: "armando" })).error).toBeNull();
    expect((await rpc(ctx.cashier, "dispatch_advance", { p_id: disp.id, p_to: "listo" })).error).toBeNull();
    const wrong = await rpc(ctx.cashier, "dispatch_deliver", { p_id: disp.id, p_code: out.pickup_code === "000000" ? "111111" : "000000", p_delivered_to: "Ana" });
    expect((wrong.data as { ok: boolean }).ok).toBe(false);
    const ok = await rpc(ctx.cashier, "dispatch_deliver", { p_id: disp.id, p_code: out.pickup_code, p_delivered_to: "Ana" });
    expect((ok.data as { ok: boolean }).ok).toBe(true);
    const { data: done } = await ctx.cashier.from("dispatches" as never).select("status, delivered_to").eq("id", disp.id).single();
    expect(done).toMatchObject({ status: "entregado", delivered_to: "Ana" });

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .in("entity_id", [out.id, disp.id]);
    const actions = (audit ?? []).map((a) => (a as { action: string }).action);
    for (const a of ["sale_order_created", "sale_order_taken", "sale_order_paid", "dispatch_created", "dispatch_delivered"]) {
      expect(actions).toContain(a);
    }
  });

  it("aislamiento: otro negocio no ve ni levanta; solo lectura no crea; sin escritura directa", async () => {
    const created = await createOrder(ctx.seller, 1, { delivery_type: "inmediato" });
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const { data: foreign } = await ctx.stranger.from("sale_orders" as never).select("id").eq("id", id);
    expect(foreign ?? []).toHaveLength(0);
    const take = await rpc(ctx.stranger, "sale_order_take", { p_id: id });
    expect(take.error?.message).toMatch(/order_not_found|forbidden|feature_not_in_plan/);

    const v = await createOrder(ctx.viewer, 1);
    expect(v.error?.message).toMatch(/forbidden/);

    const ins = await ctx.cashier.from("sale_orders" as never).insert({ tenant_id: ctx.tenant, number: 999, store_id: ctx.store, fulfillment_store_id: ctx.store, cart: {} } as never);
    expect(ins.error).not.toBeNull();
    const hash = await ctx.cashier.from("sale_orders" as never).select("pickup_code_hash").eq("id", id);
    expect(hash.error).not.toBeNull();

    const cancel = await rpc(ctx.seller, "sale_order_cancel", { p_id: id, p_reason: "Se arrepintió" });
    expect(cancel.error).toBeNull();
  });

  it("vencimiento: el job libera la reserva y se cobra sin ella con el enlace", async () => {
    const created = await createOrder(ctx.seller, 1, { delivery_type: "inmediato" });
    const out = created.data as { id: string; reservation_id: string };
    await ctx.admin.from("stock_reservations" as never).update({ expires_at: new Date(Date.now() - 60_000).toISOString() } as never).eq("id", out.reservation_id);
    const job = await rpc(ctx.cashier, "sale_orders_expire_due", { p_limit: 10 });
    expect(job.error).not.toBeNull(); // sólo service_role
    const run = await rpc(ctx.admin, "sale_orders_expire_due", { p_limit: 100 });
    expect(run.error).toBeNull();

    const taken = await rpc(ctx.cashier, "sale_order_take", { p_id: out.id });
    expect((taken.data as { reservation_active: boolean }).reservation_active).toBe(false);
    const paid = await sale(1);
    expect(paid.error).toBeNull();
    const link = await rpc(ctx.cashier, "sale_order_complete", { p_id: out.id, p_sale_id: (paid.data as { sale_id: string }).sale_id });
    expect(link.error).toBeNull();
    const { data } = await ctx.cashier.from("sale_orders" as never).select("status").eq("id", out.id).single();
    expect((data as unknown as { status: string }).status).toBe("cobrado");
  });

  it("sin la feature, el servidor rechaza", async () => {
    await ctx.admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant).eq("addon_key", "pedidos_despacho");
    const r = await createOrder(ctx.seller, 1);
    expect(r.error?.message).toMatch(/feature_not_in_plan/);
  });
});
