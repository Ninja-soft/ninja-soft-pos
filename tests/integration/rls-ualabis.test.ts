// @vitest-environment node
// =============================================================================
// Ualá Bis (ADR-143, migración 20261210100000_ualabis): gating por plan del
// medio manual (payments.method = 'ualabis') y del cobro por API (method 'qr'
// + intent ualabis), número de operación obligatorio, RLS de ualabis_refunds
// (sólo lectura del propio negocio, escribe service_role), una devolución viva
// por cobro y los guardarraíles de RLS en 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// Ualá: el "proveedor" se simula con service_role, como el webhook.
// Fechas: el corte del día es el de Argentina (_ar_day_start), no UTC.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `uala-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type Biz = { tenant: string; owner: SupabaseClient; ownerId: string; shift: string; product: string };
type Ctx = { admin: SupabaseClient; a: Biz; b: Biz; userIds: string[] };
const ctx = {} as Ctx;

type RpcRes = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

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

async function makeBiz(admin: SupabaseClient, tag: string, withFeature: boolean): Promise<Biz> {
  const t = await admin
    .from("tenants")
    .insert({ name: `Uala ${tag} ${STAMP}`, slug: `u${tag}-${STAMP}`, status: "active" })
    .select("id")
    .single();
  if (t.error || !t.data) throw t.error ?? new Error("tenant");
  const tenant = (t.data as { id: string }).id;
  if (withFeature) {
    const { error } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: tenant, addon_key: "ualabis", status: "active", source: "granted" });
    if (error) throw error;
  }
  const owner = await makeUser(admin, `uala-owner-${tag}-${STAMP}@test.local`, tenant, "owner");
  ctx.userIds.push(owner.id);
  const st = await owner.client.from("stores").insert({ name: "Centro" } as never).select("id").single();
  if (st.error || !st.data) throw st.error ?? new Error("store");
  const reg = await owner.client
    .from("cash_registers")
    .insert({ store_id: (st.data as unknown as { id: string }).id, name: "Caja 1" } as never)
    .select("id")
    .single();
  if (reg.error || !reg.data) throw reg.error ?? new Error("caja");
  const sh = await rpc(owner.client, "open_cash_shift", {
    p_register_id: (reg.data as unknown as { id: string }).id,
    p_opening_amount: 0,
  });
  if (sh.error) throw new Error(sh.error.message);
  const p = await admin
    .from("products")
    .insert({ tenant_id: tenant, name: `Alfajor ${STAMP}`, price: 1500 })
    .select("id")
    .single();
  if (p.error || !p.data) throw p.error ?? new Error("product");
  return { tenant, owner: owner.client, ownerId: owner.id, shift: sh.data as string, product: (p.data as { id: string }).id };
}

const sell = (biz: Biz, payment: Record<string, unknown>) =>
  rpc(biz.owner, "create_sale", {
    p_items: [{ product_id: biz.product, quantity: 1, unit_price: 1500, discount: 0 }],
    p_payments: [{ amount: 1500, ...payment }],
    p_extras: [],
    p_cash_shift_id: biz.shift,
  });

async function approvedIntent(tenant: string): Promise<string> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .insert({
      tenant_id: tenant,
      amount: 1500,
      provider_key: "ualabis",
      status: "approved",
      preference_id: `order-${Math.random().toString(36).slice(2, 12)}`,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("intent");
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("ADR-143 · Ualá Bis: gating, número de operación y devoluciones", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    ctx.a = await makeBiz(ctx.admin, "a", true);
    ctx.b = await makeBiz(ctx.admin, "b", false);
  }, 150_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const biz of [ctx.a, ctx.b].filter(Boolean)) {
      await admin.from("ualabis_refunds" as never).delete().eq("tenant_id", biz.tenant);
      await admin.from("subscription_addons").delete().eq("tenant_id", biz.tenant);
      // audit_logs es inmutable (ADR-083): si el negocio no se puede borrar
      // por sus auditorías, queda (datos de prueba con sello único).
      await admin.from("tenants").delete().eq("id", biz.tenant);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("payment_method_plan_key mapea el medio a su feature", async () => {
    const r = await rpc(ctx.a.owner, "payment_method_plan_key", { p_method: "ualabis" });
    expect(r.error).toBeNull();
    expect(r.data).toBe("ualabis");
  });

  it("con la feature: registro manual con número de operación", async () => {
    const r = await sell(ctx.a, { method: "ualabis", reference: "OP-778899" });
    expect(r.error).toBeNull();
    const { data } = await ctx.admin
      .from("payments")
      .select("method, reference")
      .eq("tenant_id", ctx.a.tenant)
      .eq("method", "ualabis");
    expect((data ?? []).map((p) => (p as { reference: string }).reference)).toContain("OP-778899");
  });

  it("sin número de operación, el servidor no lo acepta", async () => {
    const r = await sell(ctx.a, { method: "ualabis" });
    expect(r.error?.message).toMatch(/payments_ualabis_reference_check|check/i);
  });

  it("sin la feature en el plan: ni manual ni por API", async () => {
    const manual = await sell(ctx.b, { method: "ualabis", reference: "OP-1" });
    expect(manual.error?.message).toMatch(/payment_method_not_allowed/);
    const intent = await approvedIntent(ctx.b.tenant);
    const api = await sell(ctx.b, { method: "qr", reference: intent });
    expect(api.error?.message).toMatch(/payment_method_not_allowed/);
  });

  it("ualabis_refunds: cada negocio lee sólo lo suyo y nadie escribe desde el cliente", async () => {
    const intentA = await approvedIntent(ctx.a.tenant);
    const ins = await ctx.admin
      .from("ualabis_refunds" as never)
      .insert({ tenant_id: ctx.a.tenant, intent_id: intentA, order_uuid: "order-abc-12345", amount: 1500, status: "initiated" } as never);
    expect(ins.error).toBeNull();

    const mine = await ctx.a.owner.from("ualabis_refunds" as never).select("intent_id, status");
    expect((mine.data ?? []).map((r) => (r as { intent_id: string }).intent_id)).toContain(intentA);
    const other = await ctx.b.owner.from("ualabis_refunds" as never).select("intent_id").eq("intent_id", intentA);
    expect(other.data ?? []).toEqual([]);

    const write = await ctx.a.owner
      .from("ualabis_refunds" as never)
      .insert({ tenant_id: ctx.a.tenant, intent_id: intentA, order_uuid: "order-abc-12345", amount: 1, status: "refunded" } as never);
    expect(write.error).not.toBeNull();
    const upd = await ctx.a.owner
      .from("ualabis_refunds" as never)
      .update({ status: "refunded" } as never)
      .eq("intent_id", intentA)
      .select("status");
    expect(upd.data ?? []).toEqual([]);
  });

  it("una devolución viva por cobro; después de un rechazo se puede volver a pedir", async () => {
    const intent = await approvedIntent(ctx.a.tenant);
    const row = { tenant_id: ctx.a.tenant, intent_id: intent, order_uuid: "order-xyz-12345", amount: 1500 };
    const first = await ctx.admin
      .from("ualabis_refunds" as never)
      .insert({ ...row, status: "requested" } as never)
      .select("id")
      .single();
    expect(first.error).toBeNull();
    const dup = await ctx.admin.from("ualabis_refunds" as never).insert({ ...row, status: "requested" } as never);
    expect((dup.error as { code?: string } | null)?.code).toBe("23505");

    await ctx.admin
      .from("ualabis_refunds" as never)
      .update({ status: "failed" } as never)
      .eq("id", (first.data as unknown as { id: string }).id);
    const retry = await ctx.admin.from("ualabis_refunds" as never).insert({ ...row, status: "requested" } as never);
    expect(retry.error).toBeNull();
  });

  it("las devoluciones de hoy se cortan con el día de Argentina", async () => {
    const start = await rpc(ctx.a.owner, "_ar_day_start", {});
    expect(start.error).toBeNull();
    const { data } = await ctx.a.owner
      .from("ualabis_refunds" as never)
      .select("created_at")
      .gte("created_at", start.data as string);
    expect((data ?? []).length).toBeGreaterThan(0);
    // El inicio del día AR es medianoche en UTC-3 (03:00 UTC).
    expect(new Date(start.data as string).getUTCHours()).toBe(3);
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const r = await rpc(ctx.admin, fn);
      expect(r.error).toBeNull();
      expect(r.data as unknown[]).toEqual([]);
    }
  });
});
