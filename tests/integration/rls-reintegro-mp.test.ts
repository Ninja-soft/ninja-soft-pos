// @vitest-environment node
// =============================================================================
// Reintegro por Mercado Pago (H21h · ADR-067, migraciones 20261030100000 y
// 20261030100100): ajuste del dueño, opciones del wizard, return_sale_v2 con
// la pata MP (feature, motivo, tope, PIN 'reintegro_mp'), RLS de mp_refunds,
// RPC de la Edge (_mp_refund_claim / _mp_refund_finish sólo service_role,
// clave de idempotencia), registro en payment_disputes con origen 'pos' y
// respaldo en vale.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
//
// Escenario: negocio A con `reintegro_mp` (addon otorgado), dueño, encargado y
// cajero; una venta de $1000 (2 x $500) cobrada con QR de Mercado Pago.
// Negocio B sin la feature.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `rmp-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  manager: User;
  cashier: User;
  ownerB: User;
  store: string;
  customer: string;
  reason: string;
  sale: string;
  items: string[];
  payment: string;
  intent: string;
  refund1: string;
  refund2: string;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;
const obj = (r: RpcResult) => r.data as Record<string, unknown>;

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

const returnArgs = (over: Record<string, unknown> = {}) => ({
  p_sale_id: ctx.sale,
  p_items: [{ sale_item_id: ctx.items[0], quantity: 1 }],
  p_reason_id: ctx.reason,
  p_refund: "cash",
  p_mp_payment_id: ctx.payment,
  p_mp_amount: 500,
  ...over,
});

describe.skipIf(!enabled)("reintegro por Mercado Pago · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `RMP A ${STAMP}`, slug: `rmpa-${STAMP}`, status: "active" },
        { name: `RMP B ${STAMP}`, slug: `rmpb-${STAMP}`, status: "active" },
      ])
      .select("id");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants[0]!.id;
    ctx.tenantB = tenants[1]!.id;

    const { error: addErr } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: ctx.tenantA, addon_key: "reintegro_mp", status: "active", source: "granted" });
    if (addErr) throw addErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.manager = await makeUser(admin, `enc-${STAMP}@test.local`, ctx.tenantA, "manager");
    ctx.cashier = await makeUser(admin, `caj-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.manager.id, ctx.cashier.id, ctx.ownerB.id);

    const { data: st, error: stErr } = await admin
      .from("stores")
      .insert({ tenant_id: ctx.tenantA, name: `Local ${STAMP}` })
      .select("id")
      .single();
    if (stErr || !st) throw stErr ?? new Error("store");
    ctx.store = st.id as string;

    const { data: cu, error: cuErr } = await admin
      .from("customers")
      .insert({ tenant_id: ctx.tenantA, name: `Cliente ${STAMP}` })
      .select("id")
      .single();
    if (cuErr || !cu) throw cuErr ?? new Error("customer");
    ctx.customer = cu.id as string;

    const { data: rr, error: rrErr } = await admin
      .from("return_reasons")
      .insert({ tenant_id: ctx.tenantA, label: "Falla" })
      .select("id")
      .single();
    if (rrErr || !rr) throw rrErr ?? new Error("reason");
    ctx.reason = rr.id as string;

    const { data: sale, error: saErr } = await admin
      .from("sales")
      .insert({
        tenant_id: ctx.tenantA,
        store_id: ctx.store,
        customer_id: ctx.customer,
        number: 995001,
        subtotal: 1000,
        total: 1000,
        status: "completed",
      })
      .select("id")
      .single();
    if (saErr || !sale) throw saErr ?? new Error("sale");
    ctx.sale = sale.id as string;

    const { data: items, error: itErr } = await admin
      .from("sale_items")
      .insert([
        { tenant_id: ctx.tenantA, sale_id: ctx.sale, product_name: "A", quantity: 1, unit_price: 500, subtotal: 500 },
        { tenant_id: ctx.tenantA, sale_id: ctx.sale, product_name: "B", quantity: 1, unit_price: 500, subtotal: 500 },
      ])
      .select("id, product_name");
    if (itErr || !items) throw itErr ?? new Error("items");
    ctx.items = ["A", "B"].map((n) => (items as { id: string; product_name: string }[]).find((i) => i.product_name === n)!.id);

    const { data: intent, error: inErr } = await admin
      .from("mp_payment_intents")
      .insert({
        tenant_id: ctx.tenantA,
        provider_key: "mercadopago",
        amount: 1000,
        status: "approved",
        mp_payment_id: "5550001",
        mp_env: "test",
        sale_id: ctx.sale,
      } as never)
      .select("id")
      .single();
    if (inErr || !intent) throw inErr ?? new Error("intent");
    ctx.intent = (intent as { id: string }).id;

    const { data: payment, error: pErr } = await admin
      .from("payments")
      .insert({ tenant_id: ctx.tenantA, sale_id: ctx.sale, method: "qr", amount: 1000, reference: ctx.intent } as never)
      .select("id")
      .single();
    if (pErr || !payment) throw pErr ?? new Error("payment");
    ctx.payment = (payment as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await admin.from("payment_disputes" as never).delete().eq("tenant_id", t);
      await admin.from("mp_refunds" as never).delete().eq("tenant_id", t);
      await admin.from("store_credit_movements").delete().eq("tenant_id", t);
      await admin.from("store_credit_vouchers" as never).delete().eq("tenant_id", t);
      await admin.from("sale_returns").delete().eq("tenant_id", t);
      await admin.from("payments").delete().eq("tenant_id", t);
      await admin.from("sale_items").delete().eq("tenant_id", t);
      await admin.from("mp_payment_intents").delete().eq("tenant_id", t);
      await admin.from("sales").delete().eq("tenant_id", t);
      await admin.from("notifications").delete().eq("target_tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("supervisor_auth_tokens").delete().eq("tenant_id", t);
      await admin.from("tenant_payment_methods").delete().eq("tenant_id", t);
      await admin.from("subscription_addons").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("el ajuste lo prende sólo el dueño, por la RPC", async () => {
    const direct = await ctx.owner.client
      .from("tenant_payment_methods")
      .upsert(
        { tenant_id: ctx.tenantA, provider_key: "mercadopago", enabled: false, config: { mp_refunds_enabled: true } } as never,
        { onConflict: "tenant_id,provider_key" },
      );
    expect(direct.error?.message).toMatch(/mp_refunds_setting_owner_only/);

    const byManager = await rpc(ctx.manager.client, "mp_refund_settings_save", { p_enabled: true });
    expect(byManager.error?.message).toMatch(/forbidden/);

    const ok = await rpc(ctx.owner.client, "mp_refund_settings_save", { p_enabled: true });
    expect(ok.error).toBeNull();
    expect(obj(ok)).toMatchObject({ mp_refunds_enabled: true });

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("id")
      .eq("tenant_id", ctx.tenantA)
      .eq("action", "mp_refund_settings_saved");
    expect((audit ?? []).length).toBe(1);

    // Negocio B: sin la feature no se puede prender.
    const b = await rpc(ctx.ownerB.client, "mp_refund_settings_save", { p_enabled: true });
    expect(b.error?.message).toMatch(/feature_not_in_plan/);
  });

  it("opciones del wizard: cobro de MP con lo disponible", async () => {
    const r = await rpc(ctx.cashier.client, "mp_refund_options", { p_sale_id: ctx.sale });
    expect(r.error).toBeNull();
    const o = obj(r) as { feature: boolean; enabled: boolean; is_supervisor: boolean; payments: { refundable: number }[] };
    expect(o.feature).toBe(true);
    expect(o.enabled).toBe(true);
    expect(o.is_supervisor).toBe(false);
    expect(o.payments).toHaveLength(1);
    expect(Number(o.payments[0]!.refundable)).toBe(1000);

    // Otro negocio no ve la venta.
    const other = await rpc(ctx.ownerB.client, "mp_refund_options", { p_sale_id: ctx.sale });
    expect(other.error?.message).toMatch(/sale_not_found/);
  });

  it("valida motivo, tope y PIN sin dejar nada registrado", async () => {
    const noReason = await rpc(ctx.owner.client, "return_sale_v2", returnArgs({ p_reason_id: null }));
    expect(noReason.error?.message).toMatch(/mp_refund_reason_required/);

    const over = await rpc(ctx.owner.client, "return_sale_v2", returnArgs({ p_mp_amount: 1500 }));
    expect(over.error?.message).toMatch(/mp_amount_exceeds_refundable/);

    const overReturn = await rpc(ctx.owner.client, "return_sale_v2", returnArgs({ p_mp_amount: 800 }));
    expect(overReturn.error?.message).toMatch(/mp_amount_exceeds_return/);

    // El cajero no es supervisor: pide PIN.
    const cashier = await rpc(ctx.cashier.client, "return_sale_v2", returnArgs());
    expect(cashier.error?.message).toMatch(/supervisor_required:reintegro_mp/);

    const { data: rets } = await ctx.admin.from("sale_returns").select("id").eq("sale_id", ctx.sale);
    expect(rets ?? []).toHaveLength(0);
  });

  it("el dueño registra la devolución con la pata MP en 'pending'", async () => {
    const r = await rpc(ctx.owner.client, "return_sale_v2", returnArgs());
    expect(r.error).toBeNull();
    const res = obj(r);
    expect(Number(res.mp_amount)).toBe(500);
    expect(Number(res.rest_amount)).toBe(0);
    ctx.refund1 = String(res.mp_refund_id);

    const { data: ret } = await ctx.admin
      .from("sale_returns")
      .select("refund_method, mp_refund_amount")
      .eq("id", String(res.return_id))
      .single();
    expect(ret).toMatchObject({ refund_method: "mercadopago" });
    expect(Number((ret as { mp_refund_amount: number }).mp_refund_amount)).toBe(500);

    // Sin efectivo: no hay movimiento de caja.
    const { data: movs } = await ctx.admin.from("cash_movements").select("id").eq("reference_id", String(res.return_id));
    expect(movs ?? []).toHaveLength(0);

    const left = await rpc(ctx.cashier.client, "mp_refund_options", { p_sale_id: ctx.sale });
    expect(Number((obj(left).payments as { refundable: number }[])[0]!.refundable)).toBe(500);
  });

  it("mp_refunds: visible en el negocio, invisible afuera, sin escritura del cliente", async () => {
    const mine = await ctx.cashier.client.from("mp_refunds" as never).select("id, status").eq("id", ctx.refund1);
    expect(mine.error).toBeNull();
    expect(mine.data ?? []).toHaveLength(1);
    expect((mine.data as unknown as { status: string }[])[0]!.status).toBe("pending");

    const other = await ctx.ownerB.client.from("mp_refunds" as never).select("id").eq("id", ctx.refund1);
    expect(other.data ?? []).toHaveLength(0);

    const upd = await ctx.owner.client
      .from("mp_refunds" as never)
      .update({ status: "approved" } as never)
      .eq("id", ctx.refund1)
      .select("id");
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
  });

  it("claim y finish son de service_role; la clave cambia sólo tras un rechazo", async () => {
    const byUser = await rpc(ctx.owner.client, "_mp_refund_claim", {
      p_id: ctx.refund1,
      p_tenant: ctx.tenantA,
      p_user: ctx.owner.id,
    });
    expect(byUser.error).not.toBeNull();

    // Otro usuario del negocio que no lo pidió y no es encargado: no.
    const notMine = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.cashier.id });
    expect(obj(notMine)).toMatchObject({ error: "forbidden" });

    const c1 = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    expect(obj(c1).idempotency_key).toBe(`${ctx.refund1}:0`);
    // Mientras está en curso no se toma de nuevo.
    const busy = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    expect(obj(busy)).toMatchObject({ error: "in_progress" });

    // Dudoso: se reintenta con la misma clave.
    await rpc(ctx.admin, "_mp_refund_finish", {
      p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id, p_status: "error", p_error_code: "provider_unavailable",
    });
    const c2 = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    expect(obj(c2).idempotency_key).toBe(`${ctx.refund1}:0`);

    // Rechazo firme: clave nueva en el próximo intento.
    await rpc(ctx.admin, "_mp_refund_finish", {
      p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id, p_status: "failed", p_error_code: "insufficient_balance",
    });
    const c3 = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    expect(obj(c3).idempotency_key).toBe(`${ctx.refund1}:1`);

    const fin = await rpc(ctx.admin, "_mp_refund_finish", {
      p_id: ctx.refund1,
      p_tenant: ctx.tenantA,
      p_user: ctx.owner.id,
      p_status: "approved",
      p_mp_refund_id: `R-${STAMP}`,
      p_mp_status: "approved",
      p_provider_payment_id: "5550001",
    });
    expect(fin.error).toBeNull();
    const { data: row } = await ctx.admin.from("mp_refunds" as never).select("status, mp_refund_id").eq("id", ctx.refund1).single();
    expect(row).toMatchObject({ status: "approved", mp_refund_id: `R-${STAMP}` });

    // Ya final: no se vuelve a tomar.
    const again = await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund1, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    expect(obj(again)).toMatchObject({ error: "already_final", status: "approved" });
  });

  it("la devolución queda en disputas con origen 'pos' y la sincronización no avisa", async () => {
    const { data: d } = await ctx.admin
      .from("payment_disputes" as never)
      .select("origin, kind, status, payment_id, sale_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("dispute_key", `mp_refund:R-${STAMP}`)
      .single();
    expect(d).toMatchObject({ origin: "pos", kind: "refund", status: "refunded", payment_id: ctx.payment, sale_id: ctx.sale });

    const sync = await rpc(ctx.admin, "_payment_disputes_upsert", {
      p_tenant: ctx.tenantA,
      p_items: [
        {
          provider_key: "mercadopago",
          kind: "refund",
          dispute_key: `mp_refund:R-${STAMP}`,
          provider_payment_id: "5550001",
          provider_case_id: `R-${STAMP}`,
          external_reference: null,
          amount: 500,
          currency: "ARS",
          status: "refunded",
          provider_status: "approved",
          provider_status_detail: null,
          reason: null,
          refund_source: "collector",
          documentation_status: null,
          documentation_deadline: null,
          coverage_applied: null,
          coverage_eligible: null,
          occurred_at: new Date().toISOString(),
          resolved: true,
          raw: {},
        },
      ],
    });
    expect(sync.error).toBeNull();
    expect(obj(sync)).toMatchObject({ inserted: 0, updated: 1, notified: 0 });
    const { data: after } = await ctx.admin
      .from("payment_disputes" as never)
      .select("origin")
      .eq("tenant_id", ctx.tenantA)
      .eq("dispute_key", `mp_refund:R-${STAMP}`)
      .single();
    expect(after).toMatchObject({ origin: "pos" });
  });

  it("respaldo: si MP no pudo, vale para el cliente de la venta", async () => {
    const r = await rpc(ctx.owner.client, "return_sale_v2", returnArgs({ p_items: [{ sale_item_id: ctx.items[1], quantity: 1 }] }));
    expect(r.error).toBeNull();
    ctx.refund2 = String(obj(r).mp_refund_id);
    const returnId = String(obj(r).return_id);

    // Todavía en curso: el cajero (no lo pidió, no es encargado) no puede.
    const notYours = await rpc(ctx.cashier.client, "mp_refund_fallback", { p_refund_id: ctx.refund2, p_method: "store_credit" });
    expect(notYours.error?.message).toMatch(/forbidden/);

    await rpc(ctx.admin, "_mp_refund_claim", { p_id: ctx.refund2, p_tenant: ctx.tenantA, p_user: ctx.owner.id });
    await rpc(ctx.admin, "_mp_refund_finish", {
      p_id: ctx.refund2, p_tenant: ctx.tenantA, p_user: ctx.owner.id, p_status: "failed", p_error_code: "refund_period_expired",
    });

    const fb = await rpc(ctx.owner.client, "mp_refund_fallback", { p_refund_id: ctx.refund2, p_method: "store_credit" });
    expect(fb.error).toBeNull();
    expect(obj(fb).voucher_code).toBeTruthy();

    const { data: row } = await ctx.admin.from("mp_refunds" as never).select("status, fallback_method").eq("id", ctx.refund2).single();
    expect(row).toMatchObject({ status: "fallback", fallback_method: "store_credit" });
    const { data: ret } = await ctx.admin.from("sale_returns").select("refund_method, mp_refund_amount").eq("id", returnId).single();
    expect(ret).toMatchObject({ refund_method: "store_credit" });
    expect(Number((ret as { mp_refund_amount: number }).mp_refund_amount)).toBe(0);

    const twice = await rpc(ctx.owner.client, "mp_refund_fallback", { p_refund_id: ctx.refund2, p_method: "store_credit" });
    expect(twice.error?.message).toMatch(/refund_not_fallbackable/);

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .in("action", ["mp_refund_requested", "mp_refund_failed", "mp_refund_approved", "mp_refund_fallback"]);
    const actions = new Set((audit ?? []).map((a) => (a as { action: string }).action));
    expect([...actions].sort()).toEqual(["mp_refund_approved", "mp_refund_failed", "mp_refund_fallback", "mp_refund_requested"]);
  });
});
