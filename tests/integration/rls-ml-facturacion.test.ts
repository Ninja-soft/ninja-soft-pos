// @vitest-environment node
// =============================================================================
// Facturación de Mercado Libre (ADR-141, migraciones 20261208100100 a
// 20261208100300): aislamiento de planes, cobros de percepción, subidas y
// configuración; gating por `mercadolibre_facturacion`; roles; escrituras
// sólo por RPC o service_role; fecha de Argentina en el contexto del worker
// y en el vencimiento del link; matriz de ARCA al elegir la letra;
// guardarraíles de RLS en 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos. No emite
// comprobantes (no hay ARCA configurado) ni crea links de pago.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PLAN_SETTINGS, buildInvoicePlan } from "@/supabase/functions/_shared/mercadolibre/invoicePlan";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mlf-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const ML_USER = 860000000 + Math.floor(Math.random() * 90_000_000);
const PACK = String(2_000_000_000_000 + Math.floor(Math.random() * 900_000_000));

type User = { id: string; client: SupabaseClient };
type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

/** Fecha de hoy en Argentina (UTC-3). */
const arToday = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

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
  accA: string;
  accB: string;
  accC: string;
  planA: string;
};

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

const RI = "30712345671";
const plan = buildInvoicePlan({
  orders: [{
    ml_order_id: "1", status: "paid", total_amount: 12100,
    lines: [{ ml_order_id: "1", ml_item_id: "MLA100001", ml_variation_id: null, title: "Remera", seller_sku: null, quantity: 1, unit_price: 12100, iva_rate: 21 }],
    payments: [{ id: "1", status: "approved", transaction_amount: 12100, coupon_amount: 0, shipping_cost: 0 }],
  }],
  shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Buenos Aires" },
  billing: { docType: "cuit", docNumber: RI, name: "EMPRESA", ivaCondition: "responsable_inscripto", address: null, state: "Buenos Aires" },
  padron: null,
  iibb: [{ jurisdiction: "902", rate: 3, valid_from: "2000-01-01", valid_to: "2999-12-31" }],
  iibb_loaded: [],
  emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: null, can_perceive: true },
  settings: { ...DEFAULT_PLAN_SETTINGS, perc_enabled: true, perc_rules: [{
    jurisdiction: "902", enabled: true, rate_source: "padron", rate: null, base_pct: 100, min_base: 0, min_amount: 0,
    conditions: ["responsable_inscripto"], base: "neto", base_exempt: "total", without_padron: false,
  }] },
  today: arToday(),
});

describe.skipIf(!enabled)("Facturación de Mercado Libre · RLS, roles, gating y fechas", () => {
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
    // A y B con la facturación pro; C sólo con la integración base.
    const addons = [
      ...[ctx.tA, ctx.tB].flatMap((tenant) => [
        { tenant_id: tenant, addon_key: "mercadolibre", status: "active", source: "granted" },
        { tenant_id: tenant, addon_key: "mercadolibre_facturacion", status: "active", source: "granted" },
        { tenant_id: tenant, addon_key: "percepciones_retenciones", status: "active", source: "granted" },
      ]),
      { tenant_id: ctx.tC, addon_key: "mercadolibre", status: "active", source: "granted" },
    ];
    const { error: aErr } = await admin.from("subscription_addons").insert(addons);
    if (aErr) throw aErr;

    ctx.ownerA = await makeUser(admin, `mlfowa-${STAMP}@test.local`, ctx.tA, "owner");
    ctx.cashierA = await makeUser(admin, `mlfcsa-${STAMP}@test.local`, ctx.tA, "cashier");
    ctx.viewerA = await makeUser(admin, `mlfvwa-${STAMP}@test.local`, ctx.tA, "viewer");
    ctx.ownerB = await makeUser(admin, `mlfowb-${STAMP}@test.local`, ctx.tB, "owner");
    ctx.ownerC = await makeUser(admin, `mlfowc-${STAMP}@test.local`, ctx.tC, "owner");
    ctx.userIds.push(ctx.ownerA.id, ctx.cashierA.id, ctx.viewerA.id, ctx.ownerB.id, ctx.ownerC.id);

    const accs = await admin
      .from("ml_accounts")
      .insert([
        { tenant_id: ctx.tA, ml_user_id: ML_USER, nickname: "MLF_A", site_id: "MLA" },
        { tenant_id: ctx.tB, ml_user_id: ML_USER + 1, nickname: "MLF_B", site_id: "MLA" },
        { tenant_id: ctx.tC, ml_user_id: ML_USER + 2, nickname: "MLF_C", site_id: "MLA" },
      ])
      .select("id, tenant_id");
    if (accs.error || !accs.data) throw accs.error ?? new Error("accounts");
    const a = accs.data as { id: string; tenant_id: string }[];
    ctx.accA = a.find((x) => x.tenant_id === ctx.tA)!.id;
    ctx.accB = a.find((x) => x.tenant_id === ctx.tB)!.id;
    ctx.accC = a.find((x) => x.tenant_id === ctx.tC)!.id;
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

  it("contexto del worker: sólo service_role, apagado sin la feature y con la fecha de Argentina", async () => {
    const asOwner = await rpc(ctx.ownerA.client, "ml_billing_context", { p_account: ctx.accA, p: {} });
    expect(asOwner.error).not.toBeNull();
    const c = await rpc(ctx.admin, "ml_billing_context", { p_account: ctx.accC, p: {} });
    expect((c.data as { enabled: boolean }).enabled).toBe(false);
    const a = await rpc(ctx.admin, "ml_billing_context", { p_account: ctx.accA, p: { cuit: RI, lines: [] } });
    expect(a.error).toBeNull();
    expect((a.data as { enabled: boolean; today: string }).enabled).toBe(true);
    expect((a.data as { today: string }).today).toBe(arToday());
  });

  it("configuración: dueño sí, cajero no; reglas pro sólo con la feature; jurisdicción válida", async () => {
    const ok = await rpc(ctx.ownerA.client, "ml_billing_settings_save", {
      p_account: ctx.accA,
      p: { invoice_mode: "on_delivered", pto_vta: 7, rules: { coupon_mode: "prorate", perc_enabled: true, perc_rules: [{ jurisdiction: "902" }] } },
    });
    expect(ok.error).toBeNull();
    const got = await rpc(ctx.cashierA.client, "ml_billing_settings_get", { p_account: ctx.accA });
    expect((got.data as { invoice_mode: string; pto_vta: number }).invoice_mode).toBe("on_delivered");
    expect((got.data as { pto_vta: number }).pto_vta).toBe(7);
    const cashier = await rpc(ctx.cashierA.client, "ml_billing_settings_save", { p_account: ctx.accA, p: { pto_vta: 8 } });
    expect(cashier.error).not.toBeNull();
    const bad = await rpc(ctx.ownerA.client, "ml_billing_settings_save", { p_account: ctx.accA, p: { rules: { perc_rules: [{ jurisdiction: "999" }] } } });
    expect(bad.error?.message).toMatch(/invalid_jurisdiction/);
    const c1 = await rpc(ctx.ownerC.client, "ml_billing_settings_save", { p_account: ctx.accC, p: { invoice_mode: "manual" } });
    expect(c1.error).toBeNull();
    const c2 = await rpc(ctx.ownerC.client, "ml_billing_settings_save", { p_account: ctx.accC, p: { pto_vta: 3 } });
    expect(c2.error?.message).toMatch(/feature_not_in_plan/);
    const cross = await rpc(ctx.ownerB.client, "ml_billing_settings_save", { p_account: ctx.accA, p: { invoice_mode: "none" } });
    expect(cross.error?.message).toMatch(/not_found/);
    const audit = await ctx.admin.from("audit_logs").select("id").eq("tenant_id", ctx.tA).eq("action", "ml_billing_settings_saved");
    expect((audit.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("planes: los guarda el servidor, cada negocio ve los suyos y nadie escribe por REST", async () => {
    const asOwner = await rpc(ctx.ownerA.client, "ml_invoice_plan_store", { p_account: ctx.accA, p_pack: PACK, p_plan: plan, p_user: ctx.ownerA.id });
    expect(asOwner.error).not.toBeNull();
    const r = await rpc(ctx.admin, "ml_invoice_plan_store", { p_account: ctx.accA, p_pack: PACK, p_plan: plan, p_user: ctx.ownerA.id });
    expect(r.error).toBeNull();
    ctx.planA = (r.data as { plan_id: string }).plan_id;
    expect((r.data as { status: string }).status).toBe("hold_perception");
    const mine = await ctx.cashierA.client.from("ml_invoice_plans").select("id, status").eq("id", ctx.planA);
    expect(mine.data).toHaveLength(1);
    const other = await ctx.ownerB.client.from("ml_invoice_plans").select("id").eq("id", ctx.planA);
    expect(other.data ?? []).toHaveLength(0);
    const ins = await ctx.ownerA.client
      .from("ml_invoice_plans")
      .insert({ tenant_id: ctx.tA, account_id: ctx.accA, pack_key: "1", plan: {} } as never);
    expect(ins.error).not.toBeNull();
    const upd = await ctx.ownerA.client.from("ml_invoice_plans").update({ status: "ready" } as never).eq("id", ctx.planA).select("id");
    expect(upd.data ?? []).toHaveLength(0);
  });

  it("bandeja: operativos ven, sólo lectura no, otro negocio tampoco", async () => {
    const inbox = await rpc(ctx.cashierA.client, "ml_invoice_inbox", { p_account: ctx.accA, p_filter: "percepcion" });
    expect(inbox.error).toBeNull();
    expect((inbox.data as { counts: { percepcion: number } }).counts.percepcion).toBe(1);
    const viewer = await rpc(ctx.viewerA.client, "ml_invoice_inbox", { p_account: ctx.accA });
    expect(viewer.error).not.toBeNull();
    const other = await rpc(ctx.ownerB.client, "ml_invoice_inbox", { p_account: ctx.accA });
    expect(other.error?.message).toMatch(/not_found/);
    const noFeature = await rpc(ctx.ownerC.client, "ml_invoice_inbox", { p_account: ctx.accC });
    expect(noFeature.error?.message).toMatch(/feature_not_in_plan/);
  });

  it("elección por venta: la matriz de ARCA manda y queda auditada", async () => {
    const bad = await rpc(ctx.ownerA.client, "ml_invoice_choice_set", { p_plan: ctx.planA, p: { choice: "consumidor_final", letter: "A" } });
    expect(bad.error?.message).toMatch(/letter_/);
    const cashier = await rpc(ctx.cashierA.client, "ml_invoice_choice_set", { p_plan: ctx.planA, p: { choice: "consumidor_final" } });
    expect(cashier.error).not.toBeNull();
    const ok = await rpc(ctx.ownerA.client, "ml_invoice_choice_set", { p_plan: ctx.planA, p: { choice: "consumidor_final", pto_vta: 9 } });
    expect(ok.error).toBeNull();
    expect((ok.data as { status: string }).status).toBe("ready");
    const back = await rpc(ctx.ownerA.client, "ml_invoice_choice_set", { p_plan: ctx.planA, p: { choice: "billing" } });
    expect((back.data as { status: string }).status).toBe("hold_perception");
    const audit = await ctx.admin.from("audit_logs").select("id").eq("tenant_id", ctx.tA).eq("action", "ml_invoice_choice_set");
    expect((audit.data ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("percepción: el link lo registra el servidor con el monto del plan y vence en días de Argentina", async () => {
    const asOwner = await rpc(ctx.ownerA.client, "ml_perception_charge_create", { p_plan: ctx.planA, p_user: ctx.ownerA.id, p: { amount: plan.perception.total } });
    expect(asOwner.error).not.toBeNull();
    const wrong = await rpc(ctx.admin, "ml_perception_charge_create", { p_plan: ctx.planA, p_user: ctx.ownerA.id, p: { amount: 1 } });
    expect(wrong.error?.message).toMatch(/amount_mismatch/);
    const r = await rpc(ctx.admin, "ml_perception_charge_create", {
      p_plan: ctx.planA, p_user: ctx.ownerA.id, p: { amount: plan.perception.total, init_point: "https://example.test/link" },
    });
    expect(r.error).toBeNull();
    const { data } = await ctx.ownerA.client.from("ml_perception_charges").select("status, amount, expires_at").eq("plan_id", ctx.planA);
    const row = (data as { status: string; amount: number; expires_at: string }[])[0]!;
    expect(row.status).toBe("link_sent");
    expect(Number(row.amount)).toBe(plan.perception.total);
    const days = (Date.parse(row.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
    const other = await ctx.ownerB.client.from("ml_perception_charges").select("id").eq("plan_id", ctx.planA);
    expect(other.data ?? []).toHaveLength(0);
    const expire = await rpc(ctx.ownerA.client, "ml_perception_expire_due");
    expect(expire.error).not.toBeNull();
    const cancel = await rpc(ctx.ownerA.client, "ml_perception_cancel", { p_plan: ctx.planA, p_then: "invoice_b" });
    expect(cancel.error).toBeNull();
    const after = await ctx.ownerA.client.from("ml_invoice_plans").select("choice, status").eq("id", ctx.planA).single();
    expect(after.data).toMatchObject({ choice: "consumidor_final", status: "ready" });
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const r = await rpc(ctx.admin, fn);
      expect(r.error).toBeNull();
      expect(r.data ?? []).toHaveLength(0);
    }
  });
});
