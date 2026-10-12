// @vitest-environment node
// =============================================================================
// Cobros en espera (ADR-048): RLS, RPC y venta del lado del servidor.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con la feature (addon) y Pagos360 habilitado; negocio B
// sin la feature. El "proveedor" se simula actualizando el intent con
// service_role, igual que hace un webhook o el sondeo de la Edge.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  ownerAId: string;
  userIds: string[];
  product: string;
  register: string;
  shift: string;
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
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown>) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

async function newIntent(amount: number, tenant = ctx.tenantA): Promise<string> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .insert({ tenant_id: tenant, amount, provider_key: "pagos360" })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("intent");
  return data.id as string;
}

const sale = (price: number) => ({
  items: [{ product_id: ctx.product, quantity: 1, unit_price: price, discount: 0 }],
  extras: [],
  discount_total: 0,
});

async function park(client: SupabaseClient, intent: string, price: number, shift = ctx.shift): Promise<RpcRes> {
  return rpc(client, "park_pending_charge", {
    p_intent_id: intent,
    p_sale: sale(price),
    p_cart: { lines: [] },
    p_lines: [{ name: "Producto", quantity: 1, unit_price: price, discount: 0, subtotal: price }],
    p_cash_shift_id: shift,
    p_channel: "link",
    p_share_url: "https://example.com/pay",
    p_customer_name: "Ana",
    p_expires_minutes: 120,
  });
}

describe.skipIf(!enabled)("ADR-048 · cobros en espera", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `PC A ${STAMP}`, slug: `pca-${STAMP}`, status: "active" },
        { name: `PC B ${STAMP}`, slug: `pcb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addonErr } = await admin.from("subscription_addons").insert([
      ...["cobros_en_espera", "pagos360"].map((k) => ({
        tenant_id: ctx.tenantA,
        addon_key: k,
        status: "active",
        source: "granted",
      })),
      { tenant_id: ctx.tenantB, addon_key: "pagos360", status: "active", source: "granted" },
    ]);
    if (addonErr) throw addonErr;

    const ownerA = await makeUser(admin, `pc-owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `pc-cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `pc-owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerA = ownerA.client;
    ctx.ownerAId = ownerA.id;
    ctx.cashierA = cashierA.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(ownerA.id, cashierA.id, ownerB.id);

    const { data: prod, error: pErr } = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenantA, name: `Producto ${STAMP}`, price: 100 })
      .select("id")
      .single();
    if (pErr || !prod) throw pErr ?? new Error("product");
    ctx.product = prod.id;

    const { data: store, error: sErr } = await admin
      .from("stores")
      .insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}`, is_default: true })
      .select("id")
      .single();
    if (sErr || !store) throw sErr ?? new Error("store");
    const { data: reg, error: rErr } = await admin
      .from("cash_registers")
      .insert({ tenant_id: ctx.tenantA, store_id: store.id, name: `Caja ${STAMP}` })
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    ctx.register = reg.id;
    const { data: shift, error: shErr } = await rpc(ctx.ownerA, "open_cash_shift", {
      p_register_id: reg.id,
      p_opening_amount: 0,
    });
    if (shErr) throw shErr;
    ctx.shift = shift as string;
  }, 90_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("pending_charge_events").delete().eq("tenant_id", t);
      await admin.from("pending_charges").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  let chargeId = "";
  let intentId = "";

  it("estaciona con el total autoritativo; rechaza montos que no coinciden", async () => {
    const bad = await newIntent(99);
    const r1 = await park(ctx.ownerA, bad, 100);
    expect(r1.error?.message).toMatch(/amount_mismatch/);

    intentId = await newIntent(100);
    const r2 = await park(ctx.ownerA, intentId, 100);
    expect(r2.error).toBeNull();
    chargeId = (r2.data as { id: string }).id;
    expect(chargeId).toBeTruthy();

    // El dry-run no dejó ventas.
    const { count } = await ctx.admin
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantA);
    expect(count).toBe(0);

    const again = await park(ctx.ownerA, intentId, 100);
    expect(again.error?.message).toMatch(/intent_already_parked/);
  });

  it("sin la feature en el plan, el servidor no deja estacionar", async () => {
    const i = await newIntent(100, ctx.tenantB);
    const r = await park(ctx.ownerB, i, 100, ctx.shift);
    expect(r.error?.message).toMatch(/feature_not_in_plan/);
  });

  it("RLS: otro negocio no lo ve ni lo toca; el cajero de la sucursal sí lo ve", async () => {
    const { data: other } = await ctx.ownerB.from("pending_charges" as never).select("id").eq("id", chargeId);
    expect(other).toEqual([]);
    const { data: mine } = await ctx.cashierA.from("pending_charges" as never).select("id").eq("id", chargeId);
    expect(mine?.length).toBe(1);
    const { data: evs } = await ctx.ownerB.from("pending_charge_events" as never).select("id").eq("pending_charge_id", chargeId);
    expect(evs).toEqual([]);

    const cross = await rpc(ctx.ownerB, "cancel_pending_charge", { p_id: chargeId, p_reason: "x", p_version: null });
    expect(cross.error?.message).toMatch(/pending_charge_not_found/);
  });

  it("escritura directa bloqueada (sólo RPC)", async () => {
    const { error: insErr } = await ctx.ownerA.from("pending_charges" as never).insert({
      tenant_id: ctx.tenantA,
      store_id: ctx.register,
      sale_args: {},
      amount: 1,
      provider_key: "pagos360",
      intent_id: intentId,
      expires_at: new Date().toISOString(),
    } as never);
    expect(insErr).not.toBeNull();
    await ctx.ownerA.from("pending_charges" as never).update({ amount: 1 } as never).eq("id", chargeId);
    const { data } = await ctx.admin.from("pending_charges").select("amount").eq("id", chargeId).single();
    expect(Number(data!.amount)).toBe(100);
  });

  it("al acreditarse el intent (webhook/sondeo) la venta se crea en el servidor, una sola vez", async () => {
    const { error } = await ctx.admin.from("mp_payment_intents").update({ status: "approved" }).eq("id", intentId);
    expect(error).toBeNull();
    const { data: c } = await ctx.admin.from("pending_charges").select("*").eq("id", chargeId).single();
    expect(c!.status).toBe("completed");
    expect(c!.sale_id).toBeTruthy();

    const { data: s } = await ctx.admin.from("sales").select("id, created_by, cash_shift_id, total").eq("id", c!.sale_id).single();
    expect(s!.created_by).toBe(ctx.ownerAId);
    expect(s!.cash_shift_id).toBe(ctx.shift);
    expect(Number(s!.total)).toBe(100);
    const { data: pays } = await ctx.admin.from("payments").select("method, reference").eq("sale_id", c!.sale_id);
    expect(pays).toEqual([{ method: "qr", reference: intentId }]);

    const again = await rpc(ctx.ownerA, "complete_pending_charge", { p_id: chargeId, p_force: false });
    expect((again.data as { status: string }).status).toBe("completed");
    const { count } = await ctx.admin
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantA);
    expect(count).toBe(1);
  });

  it("cierre de caja: exige decidir; 'pasar' lo engancha a la próxima apertura", async () => {
    const i = await newIntent(100);
    const r = await park(ctx.ownerA, i, 100);
    expect(r.error).toBeNull();
    const id = (r.data as { id: string }).id;

    const noDecision = await rpc(ctx.ownerA, "close_cash_shift", { p_shift_id: ctx.shift, p_closing_amount: 0 });
    expect(noDecision.error?.message).toMatch(/pending_charges_decision_required/);

    const carry = await rpc(ctx.ownerA, "close_cash_shift", {
      p_shift_id: ctx.shift,
      p_closing_amount: 0,
      p_pending_action: "carry",
    });
    expect(carry.error).toBeNull();
    let { data: c } = await ctx.admin.from("pending_charges").select("status, cash_shift_id, carry_over").eq("id", id).single();
    expect(c).toMatchObject({ status: "waiting", cash_shift_id: null, carry_over: true });

    const { data: newShift, error } = await rpc(ctx.ownerA, "open_cash_shift", {
      p_register_id: ctx.register,
      p_opening_amount: 0,
    });
    expect(error).toBeNull();
    ({ data: c } = await ctx.admin.from("pending_charges").select("status, cash_shift_id, carry_over").eq("id", id).single());
    expect(c).toMatchObject({ status: "waiting", cash_shift_id: newShift, carry_over: false });
    ctx.shift = newShift as string;
  });

  it("cancelar invalida el intent; un pago tardío queda para revisión", async () => {
    const i = await newIntent(100);
    const r = await park(ctx.ownerA, i, 100);
    const id = (r.data as { id: string }).id;
    const cancel = await rpc(ctx.cashierA, "cancel_pending_charge", { p_id: id, p_reason: "no paga", p_version: 1 });
    expect(cancel.error).toBeNull();
    const { data: intent } = await ctx.admin.from("mp_payment_intents").select("status").eq("id", i).single();
    expect(intent!.status).toBe("cancelled");

    await ctx.admin.from("mp_payment_intents").update({ status: "approved" }).eq("id", i);
    const { data: c } = await ctx.admin.from("pending_charges").select("status, needs_review, sale_id").eq("id", id).single();
    expect(c).toMatchObject({ status: "paid", needs_review: true, sale_id: null });

    // El cajero no puede forzar; el dueño sí.
    const cashierForce = await rpc(ctx.cashierA, "complete_pending_charge", { p_id: id, p_force: true });
    expect(cashierForce.error?.message).toMatch(/forbidden/);
    const ownerForce = await rpc(ctx.ownerA, "complete_pending_charge", { p_id: id, p_force: true });
    expect((ownerForce.data as { status: string }).status).toBe("completed");
  });
});
