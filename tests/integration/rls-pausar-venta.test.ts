// @vitest-environment node
// =============================================================================
// Pausar venta (ADR-106): RLS, RPC, conciliación de intents y cierre de caja.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con dueño, cajero 1 (abre SU turno y vende en él) y
// cajero 2; negocio B con su dueño. El "proveedor" se simula actualizando el
// intent con service_role, igual que un webhook o el sondeo de la Edge.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `pv-test-${Math.random().toString(36).slice(2, 8)}`;
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

describe.skipIf(!enabled)("ADR-106 · pausar venta", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error: tErr } = await admin
      .from("tenants")
      .insert([
        { name: `PV A ${STAMP}`, slug: `pva-${STAMP}`, status: "active" },
        { name: `PV B ${STAMP}`, slug: `pvb-${STAMP}`, status: "active" },
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

    const ownerA = await makeUser(admin, `pv-owner-a-${STAMP}@test.local`, ctx.tenantA, "owner");
    const cashierA = await makeUser(admin, `pv-cashier-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const cashier2A = await makeUser(admin, `pv-cashier2-a-${STAMP}@test.local`, ctx.tenantA, "cashier");
    const ownerB = await makeUser(admin, `pv-owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
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

  const saleId = crypto.randomUUID();
  let intentId = "";

  it("el cajero pausa en SU turno con varios pagos; cada fila lleva todas las claves", async () => {
    intentId = await newIntent(50);
    const r = await pause(ctx.cashierA, saleId, [
      { kind: "line", method: "cash", amount: 30, line: { title: "Efectivo" } },
      { kind: "line", method: "debit", amount: 20, card_voucher: { lote: "1", cupon: "2", autorizacion: "3" }, line: {} },
      { kind: "intent", method: "qr", amount: 50, intent_id: intentId, provider_key: "pagos360", channel: "link", line: {} },
    ]);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ id: saleId, status: "paused", paid_amount: 50 });

    const { data: ps } = await ctx.admin.from("paused_sales").select("*").eq("id", saleId).single();
    expect(ps).toMatchObject({
      tenant_id: ctx.tenantA,
      store_id: ctx.store,
      register_id: ctx.register,
      cash_shift_id: ctx.shift,
      origin_shift_id: ctx.shift,
      created_by: ctx.cashierAId,
      label: "Señora de rojo",
      status: "paused",
    });
    const { data: rows } = await ctx.admin
      .from("paused_sale_payments")
      .select("tenant_id, paused_sale_id, position, kind, method, amount, intent_id, status, credited")
      .eq("paused_sale_id", saleId)
      .order("position");
    expect(rows).toHaveLength(3);
    for (const row of rows!) {
      expect(row.tenant_id).toBe(ctx.tenantA);
      expect(row.paused_sale_id).toBe(saleId);
    }
    expect(rows!.map((x) => [x.method, x.status, x.credited])).toEqual([
      ["cash", "confirmed", false],
      ["debit", "confirmed", true],
      ["qr", "pending", false],
    ]);
    const { count } = await ctx.admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", saleId)
      .eq("action", "paused_sale_paused");
    expect(count).toBe(1);
  });

  it("no se pausa en el turno de otro (caja propia, ADR-051)", async () => {
    const r = await pause(ctx.cashier2A, crypto.randomUUID());
    expect(r.error?.message).toMatch(/shift_not_owned/);
  });

  it("RLS: el cajero ve las suyas; otro cajero no; el dueño sí; otro negocio nunca", async () => {
    const mine = await ctx.cashierA.from("paused_sales" as never).select("id").eq("id", saleId);
    expect(mine.data?.length).toBe(1);
    const pays = await ctx.cashierA.from("paused_sale_payments" as never).select("id").eq("paused_sale_id", saleId);
    expect(pays.data?.length).toBe(3);
    const other = await ctx.cashier2A.from("paused_sales" as never).select("id").eq("id", saleId);
    expect(other.data).toEqual([]);
    const otherPays = await ctx.cashier2A.from("paused_sale_payments" as never).select("id").eq("paused_sale_id", saleId);
    expect(otherPays.data).toEqual([]);
    const owner = await ctx.ownerA.from("paused_sales" as never).select("id").eq("id", saleId);
    expect(owner.data?.length).toBe(1);
    const cross = await ctx.ownerB.from("paused_sales" as never).select("id").eq("id", saleId);
    expect(cross.data).toEqual([]);
    const crossRpc = await rpc(ctx.ownerB, "resume_paused_sale", { p_id: saleId });
    expect(crossRpc.error?.message).toMatch(/paused_sale_not_found/);
  });

  it("escritura directa bloqueada (sólo RPC)", async () => {
    const ins = await ctx.cashierA.from("paused_sales" as never).insert({ tenant_id: ctx.tenantA, store_id: ctx.store } as never);
    expect(ins.error).not.toBeNull();
    await ctx.cashierA.from("paused_sales" as never).update({ total: 1 } as never).eq("id", saleId);
    const { data } = await ctx.admin.from("paused_sales").select("total").eq("id", saleId).single();
    expect(Number(data!.total)).toBe(100);
  });

  it("un intent vive en una sola venta pausada y nunca en un cobro en espera", async () => {
    const r = await pause(ctx.cashierA, crypto.randomUUID(), [
      { kind: "intent", method: "qr", amount: 50, intent_id: intentId, provider_key: "pagos360", channel: "link", line: {} },
    ]);
    expect(r.error?.message).toMatch(/intent_in_other_paused_sale/);
  });

  it("el webhook concilia el intent contra la venta pausada (sin crear venta)", async () => {
    await ctx.admin.from("mp_payment_intents").update({ status: "approved" }).eq("id", intentId);
    const { data: p } = await ctx.admin
      .from("paused_sale_payments")
      .select("status, credited")
      .eq("intent_id", intentId)
      .single();
    expect(p).toMatchObject({ status: "approved", credited: true });
    const { data: ps } = await ctx.admin.from("paused_sales").select("paid_amount, status").eq("id", saleId).single();
    expect(Number(ps!.paid_amount)).toBe(100);
    expect(ps!.status).toBe("paused");
    const { count } = await ctx.admin.from("sales").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantA);
    expect(count).toBe(0);
  });

  it("con pagos acreditados no se descarta sin devolver; el cajero no puede confirmar la devolución", async () => {
    const r1 = await rpc(ctx.cashierA, "discard_paused_sale", { p_id: saleId, p_reason: null });
    expect(r1.error?.message).toMatch(/paused_sale_has_payments/);
    const r2 = await rpc(ctx.cashierA, "discard_paused_sale", { p_id: saleId, p_reason: "x", p_refund_confirmed: true });
    expect(r2.error?.message).toMatch(/refund_requires_manager/);
  });

  it("retomar ensaya create_sale con el turno propio y devuelve los pagos conciliados", async () => {
    const r = await rpc(ctx.cashierA, "resume_paused_sale", { p_id: saleId, p_cash_shift_id: ctx.shift });
    expect(r.error).toBeNull();
    const d = r.data as { status: string; payments: { status: string }[]; check: { ok: boolean; total?: number } };
    expect(d.status).toBe("resumed");
    expect(d.payments.map((p) => p.status)).toEqual(["confirmed", "confirmed", "approved"]);
    expect(d.check).toMatchObject({ ok: true });
    expect(Number(d.check.total)).toBe(100);
    // El ensayo no dejó ventas.
    const { count } = await ctx.admin.from("sales").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenantA);
    expect(count).toBe(0);
    // Otro cajero no la toma.
    const other = await rpc(ctx.cashier2A, "resume_paused_sale", { p_id: saleId });
    expect(other.error?.message).toMatch(/paused_sale_not_found|paused_sale_in_use/);
  });

  it("al cobrarla, create_sale ancla el intent y la pausada queda completada (una sola vez)", async () => {
    const { data: sale, error } = await rpc(ctx.cashierA, "create_sale", {
      p_items: saleArgs(100).items,
      p_payments: [
        { method: "cash", amount: 30 },
        { method: "debit", amount: 20, card_voucher: { lote: "1", cupon: "2", autorizacion: "3" } },
        { method: "qr", amount: 50, reference: intentId },
      ],
      p_cash_shift_id: ctx.shift,
    });
    expect(error).toBeNull();
    const saleRow = sale as { sale_id: string };
    const { data: ps } = await ctx.admin.from("paused_sales").select("status, sale_id").eq("id", saleId).single();
    expect(ps).toMatchObject({ status: "completed", sale_id: saleRow.sale_id });
    const again = await rpc(ctx.cashierA, "complete_paused_sale", { p_id: saleId, p_sale_id: saleRow.sale_id });
    expect((again.data as { status: string }).status).toBe("completed");
  });

  it("cierre de caja: las pausadas pasan a la próxima apertura de la caja", async () => {
    const id = crypto.randomUUID();
    expect((await pause(ctx.cashierA, id)).error).toBeNull();
    const close = await rpc(ctx.cashierA, "close_cash_shift", { p_shift_id: ctx.shift, p_closing_amount: 30 });
    expect(close.error).toBeNull();
    let { data: ps } = await ctx.admin.from("paused_sales").select("cash_shift_id, carry_over, status").eq("id", id).single();
    expect(ps).toMatchObject({ cash_shift_id: null, carry_over: true, status: "paused" });
    // Sigue visible para quien la pausó.
    const vis = await ctx.cashierA.from("paused_sales" as never).select("id").eq("id", id);
    expect(vis.data?.length).toBe(1);

    const { data: newShift, error } = await rpc(ctx.cashierA, "open_cash_shift", { p_register_id: ctx.register, p_opening_amount: 0 });
    expect(error).toBeNull();
    ({ data: ps } = await ctx.admin.from("paused_sales").select("cash_shift_id, carry_over").eq("id", id).single());
    expect(ps).toMatchObject({ cash_shift_id: newShift, carry_over: false });
    ctx.shift = newShift as string;

    // Sin pagos se descarta con auditoría.
    const d = await rpc(ctx.cashierA, "discard_paused_sale", { p_id: id, p_reason: "no vuelve" });
    expect(d.error).toBeNull();
    const { count } = await ctx.admin
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", id)
      .eq("action", "paused_sale_discarded");
    expect(count).toBe(1);
  });

  it("Limpiar con pagos en curso deja rastro; con pagos acreditados el servidor lo rechaza", async () => {
    const ok = await rpc(ctx.cashierA, "log_pos_cleared_sale", {
      p_store_id: ctx.store,
      p_cash_shift_id: ctx.shift,
      p_total: 100,
      p_item_count: 1,
      p_payments: [{ kind: "line", method: "cash", amount: 30, status: "confirmed" }],
    });
    expect(ok.error).toBeNull();
    const bad = await rpc(ctx.cashierA, "log_pos_cleared_sale", {
      p_store_id: ctx.store,
      p_payments: [{ kind: "line", method: "credit", amount: 30, status: "confirmed" }],
    });
    expect(bad.error?.message).toMatch(/sale_has_credited_payments/);
  });
});
