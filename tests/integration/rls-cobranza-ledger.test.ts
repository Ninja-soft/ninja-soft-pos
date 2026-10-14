// @vitest-environment node
// =============================================================================
// F20-1 (H127 · ADR-115): cuenta corriente de la plataforma (migraciones
// 20261113100000_cobranza_ledger y 20261113100100_cobranza_ledger_rpc).
//   · Un negocio sólo ve su estado de cuenta (dueño o encargado); el cajero y
//     el dueño de otro negocio no. El ledger no se lee directo.
//   · El staff sin header de scope no ve nada; el de soporte sin el permiso
//     Cobranzas mira pero no opera; con Cobranzas opera dentro de su tope.
//   · Topes por operación y por mes; sólo super_admin los edita.
//   · El webhook (billing_records) repetido deja un solo pago.
//   · rls_internal_scope_leaks() = 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos. El ledger y
// audit_logs son inmutables: el cleanup es best effort.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `cob-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  userIds: string[];
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  support: SupabaseClient;
  supportPlain: SupabaseClient;
  supportId: string;
  superAdmin: SupabaseClient;
};

async function signIn(email: string, internalScope: boolean): Promise<SupabaseClient> {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(internalScope ? { global: { headers: { "x-ninja-scope": "internal" } } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function makeUser(
  email: string,
  appMeta: Record<string, unknown>,
  membership?: { tenantId: string; role: string },
): Promise<string> {
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const level = appMeta.internal_level as string | undefined;
  if (level) await ctx.admin.from("users").update({ internal_level: level }).eq("id", id);
  if (membership) {
    await ctx.admin
      .from("tenant_users")
      .insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
  }
  ctx.userIds.push(id);
  return id;
}

async function makeTenant(slug: string, planKey: string): Promise<string> {
  const { data: t, error } = await ctx.admin
    .from("tenants")
    .insert({ name: `Cobranza ${slug}`, slug, status: "active", industry: "kiosco" })
    .select("id")
    .single();
  if (error) throw error;
  const id = (t as { id: string }).id;
  const { data: plan } = await ctx.admin.from("plans").select("id").eq("key", planKey).is("tenant_id", null).single();
  const start = new Date(Date.now() - 5 * 86_400_000);
  const end = new Date(Date.now() + 25 * 86_400_000);
  await ctx.admin.from("subscriptions").insert({
    tenant_id: id,
    plan_id: plan!.id,
    status: "active",
    billing_cycle: "monthly",
    current_period_start: start.toISOString(),
    current_period_end: end.toISOString(),
  });
  return id;
}

describe.skipIf(!enabled)("F20-1 · cuenta corriente de la plataforma", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    ctx.tenantA = await makeTenant(`${STAMP}-a`, "start");
    ctx.tenantB = await makeTenant(`${STAMP}-b`, "start");

    await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`cashier-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    ctx.supportId = await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`super-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });

    ctx.ownerA = await signIn(`owner-a-${STAMP}@test.local`, false);
    ctx.cashierA = await signIn(`cashier-a-${STAMP}@test.local`, false);
    ctx.ownerB = await signIn(`owner-b-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.supportPlain = await signIn(`support-${STAMP}@test.local`, false);
    ctx.superAdmin = await signIn(`super-${STAMP}@test.local`, true);

    // Pago del webhook de MP entregado dos veces para el negocio A.
    const periodStart = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 2; i++) {
      await ctx.admin.from("billing_records").insert({
        tenant_id: ctx.tenantA,
        amount: 1000,
        medium: "mp",
        period_start: periodStart,
        receipt_ref: `mp-${STAMP}`,
      });
    }
  }, 180_000);

  afterAll(async () => {
    const safe = async (p: PromiseLike<unknown>) => {
      try {
        await p;
      } catch {
        /* best effort: ledger y audit_logs inmutables */
      }
    };
    if (!ctx.admin) return;
    for (const id of ctx.userIds) {
      await safe(ctx.admin.from("tenant_users").delete().eq("user_id", id));
      await safe(ctx.admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  it("el webhook repetido deja un solo pago", async () => {
    const { data } = await ctx.admin.from("platform_payments").select("id").eq("external_id", `mp-${STAMP}`);
    expect((data ?? []).length).toBe(1);
  });

  it("el dueño ve su estado de cuenta, sin motivos internos", async () => {
    const r = await rpc(ctx.ownerA, "my_billing_statement");
    expect(r.error).toBeNull();
    const s = r.data as { tenant_id: string; movements: Record<string, unknown>[]; timeline?: unknown };
    expect(s.tenant_id).toBe(ctx.tenantA);
    expect(s.movements.length).toBeGreaterThan(0);
    expect(s.movements[0]).not.toHaveProperty("reason");
    expect(s.timeline).toBeUndefined();
  });

  it("el dueño no lee el ledger directo ni los cargos de otro negocio", async () => {
    const { data: ledger } = await ctx.ownerA.from("platform_ledger" as never).select("id");
    expect(ledger ?? []).toHaveLength(0);
    const { data: charges } = await ctx.ownerB.from("platform_charges" as never).select("tenant_id");
    expect(((charges ?? []) as { tenant_id: string }[]).every((c) => c.tenant_id === ctx.tenantB)).toBe(true);
    const r = await rpc(ctx.ownerA, "internal_billing_statement", { p_tenant: ctx.tenantB });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("el cajero no ve el estado de cuenta", async () => {
    const r = await rpc(ctx.cashierA, "my_billing_statement");
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("staff sin header de scope: forbidden", async () => {
    const r = await rpc(ctx.supportPlain, "internal_billing_statement", { p_tenant: ctx.tenantA });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("soporte sin Cobranzas mira pero no opera", async () => {
    const view = await rpc(ctx.support, "internal_billing_statement", { p_tenant: ctx.tenantA });
    expect(view.error).toBeNull();
    const pay = await rpc(ctx.support, "internal_billing_register_payment", {
      p_tenant: ctx.tenantA,
      p_amount_cents: 1000,
      p_method: "cash",
      p_paid_on: null,
      p_reference: null,
      p_reason: "Pago en mano",
    });
    expect(pay.error?.message).toMatch(/forbidden/);
    const bonus = await rpc(ctx.support, "internal_billing_bonus", { p_tenant: ctx.tenantA, p_amount_cents: 1000, p_reason: "Gesto comercial" });
    expect(bonus.error?.message).toMatch(/forbidden/);
  });

  it("con Cobranzas opera dentro del tope; los topes sólo los edita super_admin", async () => {
    const denied = await rpc(ctx.support, "internal_billing_set_caps", {
      p_level: "cobranzas",
      p_per_operation_cents: 1,
      p_per_month_cents: 2,
      p_reason: "Sin permiso",
    });
    expect(denied.error?.message).toMatch(/forbidden/);

    const grant = await rpc(ctx.superAdmin, "internal_set_staff_permission", {
      p_user: ctx.supportId,
      p_permission: "cobranzas",
      p_enabled: true,
      p_reason: "Cobra las cuentas",
    });
    expect(grant.error).toBeNull();
    const caps = await rpc(ctx.superAdmin, "internal_billing_set_caps", {
      p_level: "cobranzas",
      p_per_operation_cents: 50_000,
      p_per_month_cents: 80_000,
      p_reason: "Topes del test",
    });
    expect(caps.error).toBeNull();

    const pay = await rpc(ctx.support, "internal_billing_register_payment", {
      p_tenant: ctx.tenantB,
      p_amount_cents: 10_000,
      p_method: "transfer",
      p_paid_on: null,
      p_reference: "TRF-1",
      p_reason: "Transferencia informada",
    });
    expect(pay.error).toBeNull();

    const over = await rpc(ctx.support, "internal_billing_bonus", { p_tenant: ctx.tenantB, p_amount_cents: 60_000, p_reason: "Supera el tope" });
    expect(over.error?.message).toMatch(/cap_per_operation_exceeded/);
    const first = await rpc(ctx.support, "internal_billing_bonus", { p_tenant: ctx.tenantB, p_amount_cents: 50_000, p_reason: "Compensación" });
    expect(first.error).toBeNull();
    const month = await rpc(ctx.support, "internal_billing_bonus", { p_tenant: ctx.tenantB, p_amount_cents: 40_000, p_reason: "Otra compensación" });
    expect(month.error?.message).toMatch(/cap_per_month_exceeded/);

    const terms = await rpc(ctx.support, "internal_billing_set_terms", {
      p_tenant: ctx.tenantB,
      p_billing_mode: "account",
      p_exempt_reason: null,
      p_due_days: 10,
      p_reason: "No administra negocios",
    });
    expect(terms.error?.message).toMatch(/forbidden/);

    // Restaurar el default.
    await rpc(ctx.superAdmin, "internal_billing_set_caps", {
      p_level: "cobranzas",
      p_per_operation_cents: 5_000_000,
      p_per_month_cents: 15_000_000,
      p_reason: "Vuelve al default",
    });
  });

  it("rls_internal_scope_leaks() sigue en 0", async () => {
    const { data, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
