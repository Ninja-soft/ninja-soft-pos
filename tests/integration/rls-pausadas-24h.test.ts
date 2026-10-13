// @vitest-environment node
// =============================================================================
// Ventas pausadas que vencen a las 24 h (ADR-108, sobre ADR-106).
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// El paso del tiempo se simula corriendo paused_at 25 h para atrás con
// service_role (el trigger recalcula expires_at). El job se corre a mano
// (expire_paused_sales) como lo haría pg_cron.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pv24-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  cashier2A: SupabaseClient;
  ownerB: SupabaseClient;
  cashierAId: string;
  userIds: string[];
  product: string;
  store: string;
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
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
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

const cartOf = (price: number) => ({
  v: 1,
  lines: [{ lineId: "l1", productId: ctx.product, name: "Producto", sku: null, unitPrice: price, quantity: 1, discount: 0, unit: "un" }],
  discountTotal: 0,
  couponCode: null,
  customer: null,
  offeredWarrantyId: "",
  pricing: { listId: null, termId: null },
  notes: null,
});
const saleArgs = (price: number) => ({
  items: [{ product_id: ctx.product, quantity: 1, unit_price: price, discount: 0 }],
  extras: [],
  discount_total: 0,
});

function pause(
  client: SupabaseClient,
  id: string,
  payments: Record<string, unknown>[] = [],
  over: Record<string, unknown> = {},
): Promise<RpcRes> {
  return rpc(client, "pause_sale", {
    p_id: id,
    p_store_id: ctx.store,
    p_register_id: ctx.register,
    p_cash_shift_id: ctx.shift,
    p_customer_id: null,
    p_customer_name: null,
    p_label: "Señora de rojo",
    p_cart: cartOf(100),
    p_checkout: { v: 1, lines: [], tipPct: null, tipCustom: "", warrantyId: "", warrantyLineId: "", professionalId: "" },
    p_sale_args: saleArgs(100),
    p_total: 100,
    p_item_count: 1,
    p_payments: payments,
    p_source: "online",
    p_version: null,
    ...over,
  });
}

describe.skipIf(!enabled)("ADR-108 · ventas pausadas que vencen a las 24 h", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `PV24 A ${STAMP}`, slug: `pv24a-${STAMP}`, status: "active" },
        { name: `PV24 B ${STAMP}`, slug: `pv24b-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (tErr || !tenants) throw tErr ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    // El cobro QR de la pausada es de Pagos360: el plan debe incluirlo (payment_method_plan_key).
    const { error: addonErr } = await admin.from("subscription_addons").insert([
      { tenant_id: ctx.tenantA, addon_key: "pagos360", status: "active", source: "granted" },
    ]);
    if (addonErr) throw addonErr;

    const ownerA = await makeUser(admin, `pv24-owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `pv24-cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const cashier2A = await makeUser(admin, `pv24-cashier2-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `pv24-owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.ownerA = ownerA.client;
    ctx.cashierA = cashierA.client;
    ctx.cashierAId = cashierA.id;
    ctx.cashier2A = cashier2A.client;
    ctx.ownerB = ownerB.client;
    ctx.userIds.push(ownerA.id, cashierA.id, cashier2A.id, ownerB.id);

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
    ctx.store = store.id;
    const { data: reg, error: rErr } = await admin
      .from("cash_registers")
      .insert({ tenant_id: ctx.tenantA, store_id: store.id, name: `Caja ${STAMP}` })
      .select("id")
      .single();
    if (rErr || !reg) throw rErr ?? new Error("register");
    ctx.register = reg.id;
    // El cajero abre SU turno y vende en él.
    const { data: shift, error: shErr } = await rpc(ctx.cashierA, "open_cash_shift", {
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
      await admin.from("paused_sale_payments").delete().eq("tenant_id", t);
      await admin.from("paused_sales").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // Corre el reloj: la pausada quedó pausada hace 25 h.
  async function age(id: string, hours = 25) {
    const at = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { error } = await ctx.admin.from("paused_sales").update({ paused_at: at }).eq("id", id);
    if (error) throw error;
  }
  const listIds = async (c: SupabaseClient, store = ctx.store) => {
    const r = await c.rpc("list_open_paused_sales" as never, { p_store_id: store } as never).select("id, expires_at");
    if (r.error) throw r.error;
    return ((r.data ?? []) as { id: string }[]).map((x) => x.id);
  };
  const auditCount = async (id: string, action: string) => {
    const { count } = await ctx.admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", id)
      .eq("action", action);
    return count ?? 0;
  };

  const fresh = crypto.randomUUID();
  const stale = crypto.randomUUID();
  const staleCash = crypto.randomUUID();
  const staleQr = crypto.randomUUID();
  const staleDeadQr = crypto.randomUUID();

  it("expires_at = pausada + 24 h y la recién pausada se lista", async () => {
    expect((await pause(ctx.cashierA, fresh)).error).toBeNull();
    const { data } = await ctx.admin.from("paused_sales").select("paused_at, expires_at").eq("id", fresh).single();
    const diff = new Date(data!.expires_at as string).getTime() - new Date(data!.paused_at as string).getTime();
    expect(diff).toBe(24 * 3_600_000);
    expect(await listIds(ctx.cashierA)).toContain(fresh);
  });

  it("vencida sin pagos: no se lista ni se retoma aunque el job no haya corrido", async () => {
    expect((await pause(ctx.cashierA, stale)).error).toBeNull();
    await age(stale);
    expect(await listIds(ctx.cashierA)).not.toContain(stale);
    expect(await listIds(ctx.ownerA)).not.toContain(stale);
    const r = await rpc(ctx.cashierA, "resume_paused_sale", { p_id: stale, p_cash_shift_id: ctx.shift });
    expect(r.error?.message).toMatch(/paused_sale_expired/);
    // Sigue 'paused' en la base hasta que corra el job (el rechazo no escribe).
    const { data } = await ctx.admin.from("paused_sales").select("status").eq("id", stale).single();
    expect(data!.status).toBe("paused");
  });

  it("vencida con pagos vivos (efectivo, QR pendiente): se sigue listando", async () => {
    expect(
      (await pause(ctx.cashierA, staleCash, [{ kind: "line", method: "cash", amount: 30, line: { title: "Efectivo" } }]))
        .error,
    ).toBeNull();
    const intent = await newIntent(40);
    expect(
      (
        await pause(ctx.cashierA, staleQr, [
          { kind: "intent", method: "qr", amount: 40, intent_id: intent, provider_key: "pagos360", channel: "qr", line: {} },
        ])
      ).error,
    ).toBeNull();
    // Un QR que el proveedor dio por vencido no cuenta como pago vivo.
    const deadIntent = await newIntent(20);
    expect(
      (
        await pause(ctx.cashierA, staleDeadQr, [
          { kind: "intent", method: "qr", amount: 20, intent_id: deadIntent, provider_key: "pagos360", channel: "qr", line: {} },
        ])
      ).error,
    ).toBeNull();
    await ctx.admin.from("mp_payment_intents").update({ status: "expired" }).eq("id", deadIntent);
    for (const id of [staleCash, staleQr, staleDeadQr]) await age(id);

    const ids = await listIds(ctx.cashierA);
    expect(ids).toEqual(expect.arrayContaining([staleCash, staleQr]));
    expect(ids).not.toContain(staleDeadQr);
  });

  it("otro negocio no ve nada y nadie con sesión corre el job", async () => {
    expect(await listIds(ctx.ownerB)).toEqual([]);
    const cross = await rpc(ctx.ownerB, "resume_paused_sale", { p_id: staleCash });
    expect(cross.error?.message).toMatch(/paused_sale_not_found/);
    const job = await rpc(ctx.ownerA, "expire_paused_sales", { p_limit: 10 });
    expect(job.error).not.toBeNull();
    // Otro cajero del mismo negocio tampoco ve las del primero.
    expect(await listIds(ctx.cashier2A)).toEqual([]);
  });

  it("el job vence las que no tienen pagos (baja lógica + auditoría) y retiene las que tienen", async () => {
    const r = await rpc(ctx.admin, "expire_paused_sales", { p_limit: 500 });
    expect(r.error).toBeNull();

    const { data: rows } = await ctx.admin
      .from("paused_sales")
      .select("id, status, expired_at, expiry_held_at, deleted_at")
      .in("id", [fresh, stale, staleCash, staleQr, staleDeadQr]);
    const by = new Map((rows ?? []).map((x) => [x.id as string, x]));
    expect(by.get(fresh)).toMatchObject({ status: "paused", expired_at: null, expiry_held_at: null });
    for (const id of [stale, staleDeadQr]) {
      expect(by.get(id)).toMatchObject({ status: "expired", deleted_at: null });
      expect(by.get(id)!.expired_at).not.toBeNull();
      expect(await auditCount(id, "paused_sale_expired")).toBe(1);
    }
    for (const id of [staleCash, staleQr]) {
      expect(by.get(id)).toMatchObject({ status: "paused", expired_at: null });
      expect(by.get(id)!.expiry_held_at).not.toBeNull();
      expect(await auditCount(id, "paused_sale_expiry_held")).toBe(1);
    }

    // Idempotente: otra corrida no audita de nuevo.
    expect((await rpc(ctx.admin, "expire_paused_sales", { p_limit: 500 })).error).toBeNull();
    expect(await auditCount(stale, "paused_sale_expired")).toBe(1);
    expect(await auditCount(staleCash, "paused_sale_expiry_held")).toBe(1);

    // La vencida no se retoma ni se renombra.
    const res = await rpc(ctx.cashierA, "resume_paused_sale", { p_id: stale, p_cash_shift_id: ctx.shift });
    expect(res.error?.message).toMatch(/paused_sale_expired/);
    const ren = await rpc(ctx.cashierA, "rename_paused_sale", { p_id: stale, p_label: "x" });
    expect(ren.error?.message).toMatch(/paused_sale_closed/);
  });

  it("la retenida con efectivo se retoma y el reloj vuelve a arrancar", async () => {
    const r = await rpc(ctx.cashierA, "resume_paused_sale", { p_id: staleCash, p_cash_shift_id: ctx.shift });
    expect(r.error).toBeNull();
    const { data } = await ctx.admin
      .from("paused_sales")
      .select("status, expires_at, expiry_held_at")
      .eq("id", staleCash)
      .single();
    expect(data!.status).toBe("resumed");
    expect(data!.expiry_held_at).toBeNull();
    expect(new Date(data!.expires_at as string).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("un pago tardío sobre una vencida queda para revisión", async () => {
    const { data: p } = await ctx.admin
      .from("paused_sale_payments")
      .select("intent_id")
      .eq("paused_sale_id", staleDeadQr)
      .single();
    await ctx.admin.from("mp_payment_intents").update({ status: "approved" }).eq("id", p!.intent_id as string);
    const { data } = await ctx.admin.from("paused_sales").select("status, needs_review").eq("id", staleDeadQr).single();
    expect(data).toMatchObject({ status: "expired", needs_review: true });
  });
});
