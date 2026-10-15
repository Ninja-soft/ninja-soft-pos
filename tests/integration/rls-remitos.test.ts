// @vitest-environment node
// =============================================================================
// ADR-136: remitos de entrega y de envío con COT (RLS, numeración por punto
// de venta interno, COT, anulación y aislamiento), con el create_sale real.
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

const STAMP = `rem-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const AR_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  other: string;
  owner: SupabaseClient;
  cashier: SupabaseClient;
  viewer: SupabaseClient;
  stranger: SupabaseClient;
  userIds: string[];
  store: string;
  shift: string;
  product: string;
  sale: string;
  remito: string;
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

describe.skipIf(!enabled)("ADR-136 · remitos con COT (RLS + create_sale real)", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    const t = await admin.from("tenants").insert({ name: `REM ${STAMP}`, slug: `a-${STAMP}`, status: "active" }).select("id").single();
    if (t.error || !t.data) throw t.error ?? new Error("tenant");
    ctx.tenant = (t.data as { id: string }).id;
    const t2 = await admin.from("tenants").insert({ name: `REM B ${STAMP}`, slug: `b-${STAMP}`, status: "active" }).select("id").single();
    if (t2.error || !t2.data) throw t2.error ?? new Error("tenant b");
    ctx.other = (t2.data as { id: string }).id;
    const { error: addonErr } = await admin.from("subscription_addons").insert(
      ["pedidos_despacho", "entregas_remitos", "depositos"].map((key) => ({ tenant_id: ctx.tenant, addon_key: key, status: "active", source: "granted" })),
    );
    if (addonErr) throw addonErr;

    const owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenant, "owner");
    const cashier = await makeUser(admin, `cajera-${STAMP}@test.local`, ctx.tenant, "cashier");
    const viewer = await makeUser(admin, `viewer-${STAMP}@test.local`, ctx.tenant, "viewer");
    const stranger = await makeUser(admin, `otro-${STAMP}@test.local`, ctx.other, "owner");
    Object.assign(ctx, { owner: owner.client, cashier: cashier.client, viewer: viewer.client, stranger: stranger.client });
    ctx.userIds.push(owner.id, cashier.id, viewer.id, stranger.id);

    await admin.from("tenant_branding").upsert({ tenant_id: ctx.tenant, legal_name: "Electro SRL", cuit: "30712345678" } as never, { onConflict: "tenant_id" });
    const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
    if (st.error || !st.data) throw st.error ?? new Error("store");
    ctx.store = (st.data as unknown as { id: string }).id;
    const prod = await admin
      .from("products")
      .insert({ tenant_id: ctx.tenant, name: `Campera ${STAMP}`, price: 100, cost: 50, stock: 10, track_stock: true })
      .select("id")
      .single();
    if (prod.error || !prod.data) throw prod.error ?? new Error("product");
    ctx.product = (prod.data as { id: string }).id;
    const reg = await owner.client.from("cash_registers").insert({ store_id: ctx.store, name: "Caja 1" } as never).select("id").single();
    if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
    const sh = await rpc(cashier.client, "open_cash_shift", { p_register_id: (reg.data as unknown as { id: string }).id, p_opening_amount: 0 });
    if (sh.error) throw new Error(sh.error.message);
    ctx.shift = sh.data as string;
    const s = await rpc(cashier.client, "create_sale", {
      p_items: [{ product_id: ctx.product, quantity: 3, unit_price: 100, discount: 0 }],
      p_payments: [{ method: "cash", amount: 300 }],
      p_cash_shift_id: ctx.shift,
    });
    if (s.error) throw new Error(s.error.message);
    ctx.sale = (s.data as { sale_id: string }).sale_id;
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin || !ctx.tenant) return;
    await admin.from("remito_items" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("remitos" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("remito_points" as never).delete().eq("tenant_id", ctx.tenant);
    await admin.from("subscription_addons").delete().eq("tenant_id", ctx.tenant);
    await admin.from("tenants").delete().in("id", [ctx.tenant, ctx.other]);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("la cajera emite el remito de la venta con el punto interno 0001", async () => {
    ctx.remito = crypto.randomUUID();
    const r = await rpc(ctx.cashier, "remito_issue", {
      p_id: ctx.remito,
      p_data: { sale_id: ctx.sale, kind: "envio", receiver_name: "Juan Pérez", delivery_address: "Calle 9 123", packages: 2, carrier_cuit: "30-50000000-1" },
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ pto_vta: 1, number: 1 });
    const { data } = await ctx.cashier.from("remitos" as never).select("number, declared_value, issued_at, issuer, carrier_cuit").eq("id", ctx.remito).single();
    const row = data as unknown as { number: number; declared_value: number; issued_at: string; issuer: { cuit: string }; carrier_cuit: string };
    expect(Number(row.declared_value)).toBe(300);
    expect(row.issuer.cuit).toBe("30712345678");
    expect(row.carrier_cuit).toBe("30500000001");
    expect(AR_DAY.format(new Date(row.issued_at))).toBe(AR_DAY.format(new Date()));
    const again = await rpc(ctx.cashier, "remito_issue", { p_id: ctx.remito, p_data: { sale_id: ctx.sale } });
    expect((again.data as { already: boolean }).already).toBe(true);
  });

  it("COT a mano con formato y auditoría; solo lectura no edita", async () => {
    const bad = await rpc(ctx.cashier, "remito_update", { p_id: ctx.remito, p_data: { cot_number: "12" } });
    expect(bad.error?.message).toMatch(/invalid_cot/);
    const ok = await rpc(ctx.cashier, "remito_update", { p_id: ctx.remito, p_data: { cot_number: "1234567890123456", cot_valid_until: "2026-12-01" } });
    expect(ok.error).toBeNull();
    const v = await rpc(ctx.viewer, "remito_update", { p_id: ctx.remito, p_data: { packages: 3 } });
    expect(v.error?.message).toMatch(/forbidden/);
  });

  it("anular es de la dueña con motivo; el siguiente remito sigue la numeración", async () => {
    expect((await rpc(ctx.cashier, "remito_void", { p_id: ctx.remito, p_reason: "error de carga" })).error?.message).toMatch(/void_requires_manager/);
    expect((await rpc(ctx.owner, "remito_void", { p_id: ctx.remito, p_reason: "error de carga" })).error).toBeNull();
    const r2 = await rpc(ctx.owner, "remito_issue", { p_id: crypto.randomUUID(), p_data: { sale_id: ctx.sale, receiver_name: "Juan Pérez" } });
    expect(r2.data).toMatchObject({ pto_vta: 1, number: 2 });
  });

  it("otro negocio no ve ni emite; nadie escribe por REST", async () => {
    for (const t of ["remitos", "remito_items", "remito_points"]) {
      const { data } = await ctx.stranger.from(t as never).select("id");
      expect(data ?? []).toHaveLength(0);
    }
    const r = await rpc(ctx.stranger, "remito_issue", { p_id: crypto.randomUUID(), p_data: { sale_id: ctx.sale } });
    expect(r.error?.message).toMatch(/sale_not_found|feature_not_in_plan/);
    const { error } = await ctx.owner.from("remitos" as never).update({ status: "emitido" } as never).eq("id", ctx.remito);
    expect(error).not.toBeNull();
  });
});
