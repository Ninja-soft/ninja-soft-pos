// @vitest-environment node
// =============================================================================
// Talo (ADR-175, migración 20270113100000_talo): gating por plan del cobro por
// API (method 'qr' + intent talo), RLS de talo_refunds (sólo lectura del propio
// negocio, escribe service_role), una devolución en curso por cobro, una hecha
// por tipo, paid_amount del intent y los guardarraíles de RLS en 0.
// En CI los planes los crea el seed DESPUÉS de las migraciones: no se afirman
// valores de plans.limits.modules; la feature se otorga con un addon.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos. No llama a
// Talo: el "proveedor" se simula con service_role, como el webhook.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `talo-${Math.random().toString(36).slice(2, 8)}`;
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
    .insert({ name: `Talo ${tag} ${STAMP}`, slug: `t${tag}-${STAMP}`, status: "active" })
    .select("id")
    .single();
  if (t.error || !t.data) throw t.error ?? new Error("tenant");
  const tenant = (t.data as { id: string }).id;
  if (withFeature) {
    const { error } = await admin
      .from("subscription_addons")
      .insert({ tenant_id: tenant, addon_key: "talo", status: "active", source: "granted" });
    if (error) throw error;
  }
  const owner = await makeUser(admin, `talo-owner-${tag}-${STAMP}@test.local`, tenant, "owner");
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

async function approvedIntent(tenant: string, paid: number | null = 1500): Promise<string> {
  const { data, error } = await ctx.admin
    .from("mp_payment_intents")
    .insert({
      tenant_id: tenant,
      amount: 1500,
      provider_key: "talo",
      status: "approved",
      preference_id: `VAR-test-${Math.random().toString(36).slice(2, 12)}`,
      paid_amount: paid,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("intent");
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("ADR-175 · Talo: gating, paid_amount y devoluciones", () => {
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
      await admin.from("talo_refunds" as never).delete().eq("tenant_id", biz.tenant);
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
    const r = await rpc(ctx.a.owner, "payment_method_plan_key", { p_method: "talo" });
    expect(r.error).toBeNull();
    expect(r.data).toBe("talo");
  });

  it("pending_charge_max_ttl topea Talo en 3 días", async () => {
    const r = await rpc(ctx.a.owner, "pending_charge_max_ttl", { p_provider: "talo" });
    expect(r.error).toBeNull();
    expect(r.data).toBe(4320);
  });

  it("con la feature: la venta entra con el intent aprobado de Talo", async () => {
    const intent = await approvedIntent(ctx.a.tenant);
    const r = await sell(ctx.a, { method: "qr", reference: intent });
    expect(r.error).toBeNull();
  });

  it("sin la feature en el plan: el cobro por API no entra", async () => {
    const intent = await approvedIntent(ctx.b.tenant);
    const api = await sell(ctx.b, { method: "qr", reference: intent });
    expect(api.error?.message).toMatch(/payment_method_not_allowed/);
  });

  it("paid_amount: el negocio lo lee en sus intents y no ve los de otro", async () => {
    const intent = await approvedIntent(ctx.a.tenant, 1700);
    const mine = await ctx.a.owner.from("mp_payment_intents").select("id, paid_amount" as never).eq("id", intent);
    expect(Number((mine.data as unknown as { paid_amount: number }[] | null)?.[0]?.paid_amount)).toBe(1700);
    const other = await ctx.b.owner.from("mp_payment_intents").select("id").eq("id", intent);
    expect(other.data ?? []).toEqual([]);
    const bad = await ctx.admin.from("mp_payment_intents").update({ paid_amount: -1 } as never).eq("id", intent);
    expect(bad.error).not.toBeNull();
  });

  it("talo_refunds: cada negocio lee sólo lo suyo y nadie escribe desde el cliente", async () => {
    const intentA = await approvedIntent(ctx.a.tenant);
    const row = { tenant_id: ctx.a.tenant, intent_id: intentA, payment_id: "VAR-abc-12345", refund_type: "FULL", amount: 1500 };
    const ins = await ctx.admin.from("talo_refunds" as never).insert({ ...row, status: "initiated" } as never);
    expect(ins.error).toBeNull();

    const mine = await ctx.a.owner.from("talo_refunds" as never).select("intent_id, status");
    expect((mine.data ?? []).map((r) => (r as { intent_id: string }).intent_id)).toContain(intentA);
    const other = await ctx.b.owner.from("talo_refunds" as never).select("intent_id").eq("intent_id", intentA);
    expect(other.data ?? []).toEqual([]);

    const write = await ctx.a.owner.from("talo_refunds" as never).insert({ ...row, amount: 1, status: "refunded" } as never);
    expect(write.error).not.toBeNull();
    const upd = await ctx.a.owner
      .from("talo_refunds" as never)
      .update({ status: "refunded" } as never)
      .eq("intent_id", intentA)
      .select("status");
    expect(upd.data ?? []).toEqual([]);
  });

  it("una devolución en curso por cobro; después de un rechazo se puede volver a pedir", async () => {
    const intent = await approvedIntent(ctx.a.tenant);
    const row = { tenant_id: ctx.a.tenant, intent_id: intent, payment_id: "VAR-xyz-12345", refund_type: "FULL", amount: 1500 };
    const first = await ctx.admin
      .from("talo_refunds" as never)
      .insert({ ...row, status: "requested" } as never)
      .select("id")
      .single();
    expect(first.error).toBeNull();
    const dup = await ctx.admin
      .from("talo_refunds" as never)
      .insert({ ...row, kind: "excess", refund_type: "PARTIAL", status: "requested" } as never);
    expect((dup.error as { code?: string } | null)?.code).toBe("23505");

    await ctx.admin
      .from("talo_refunds" as never)
      .update({ status: "failed" } as never)
      .eq("id", (first.data as unknown as { id: string }).id);
    const retry = await ctx.admin.from("talo_refunds" as never).insert({ ...row, status: "requested" } as never);
    expect(retry.error).toBeNull();
  });

  it("no se devuelve dos veces lo mismo: una devolución hecha por tipo", async () => {
    const intent = await approvedIntent(ctx.a.tenant, 2000);
    const row = { tenant_id: ctx.a.tenant, intent_id: intent, payment_id: "VAR-ovp-12345", kind: "excess", refund_type: "PARTIAL", amount: 500 };
    const done = await ctx.admin.from("talo_refunds" as never).insert({ ...row, status: "refunded" } as never);
    expect(done.error).toBeNull();
    const again = await ctx.admin.from("talo_refunds" as never).insert({ ...row, status: "refunded" } as never);
    expect((again.error as { code?: string } | null)?.code).toBe("23505");
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const r = await rpc(ctx.admin, fn);
      expect(r.error).toBeNull();
      expect(r.data as unknown[]).toEqual([]);
    }
  });
});
