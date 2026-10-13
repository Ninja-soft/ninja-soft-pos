// @vitest-environment node
// =============================================================================
// Administración interna de negocios (F7 · H11c · ADR-073, migración
// 20261101200000_admin_tenants): ciclo de vida con motivo (suspender,
// reactivar, baja lógica), bloqueo real de la operación, selector de estado
// sin atajos y alta manual sólo por service_role.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `admt-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  createdTenants: string[];
  owner: User;
  ownerB: User;
  staffAdmin: User;
  staffSuper: User;
  staffSupport: User;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    global: { headers: { "x-ninja-scope": "internal" } },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function makeUser(
  admin: SupabaseClient,
  email: string,
  appMeta: Record<string, unknown>,
  membership?: { tenantId: string; role: string },
): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (membership) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
    if (tuErr) throw tuErr;
  }
  ctx.userIds.push(id);
  return { id, client: await signIn(email) };
}

async function tenantRow(id: string) {
  const { data } = await ctx.admin.from("tenants").select("status, deleted_at").eq("id", id).single();
  const { data: sub } = await ctx.admin.from("subscriptions").select("status").eq("tenant_id", id).maybeSingle();
  return { ...(data as { status: string; deleted_at: string | null }), subStatus: (sub as { status: string } | null)?.status ?? null };
}

describe.skipIf(!enabled)("administración interna de negocios · RPC y bloqueo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.createdTenants = [];

    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `AdmT A ${STAMP}`, slug: `admta-${STAMP}`, status: "active" },
        { name: `AdmT B ${STAMP}`, slug: `admtb-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `admta-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `admtb-${STAMP}`)!.id;

    const { data: plan } = await admin.from("plans").select("id").eq("key", "start").is("tenant_id", null).single();
    const { error: subErr } = await admin.from("subscriptions").insert([
      { tenant_id: ctx.tenantA, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
      { tenant_id: ctx.tenantB, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
    ]);
    if (subErr) throw subErr;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    ctx.staffAdmin = await makeUser(admin, `staff-adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.staffSuper = await makeUser(admin, `staff-sup-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    ctx.staffSupport = await makeUser(admin, `staff-sop-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    const all = [ctx.tenantA, ctx.tenantB, ...(ctx.createdTenants ?? [])].filter(Boolean);
    for (const t of all) {
      await admin.from("tenant_payment_methods").delete().eq("tenant_id", t);
      await admin.from("cash_registers").delete().eq("tenant_id", t);
      await admin.from("stores").delete().eq("tenant_id", t);
      await admin.from("audit_logs").delete().eq("tenant_id", t);
      await admin.from("subscriptions").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("el dueño y soporte no pueden cambiar el ciclo de vida", async () => {
    const own = await rpc(ctx.owner.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: "prueba de dueño" });
    expect(own.error?.message).toMatch(/forbidden/);
    const sop = await rpc(ctx.staffSupport.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: "prueba de soporte" });
    expect(sop.error?.message).toMatch(/forbidden/);
    expect((await tenantRow(ctx.tenantA)).status).toBe("active");
  });

  it("el motivo es obligatorio (5+ caracteres)", async () => {
    const r = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: "  ab " });
    expect(r.error?.message).toMatch(/reason_required/);
    const r2 = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: null });
    expect(r2.error?.message).toMatch(/reason_required/);
  });

  it("suspender bloquea la operación del negocio y queda auditado con motivo", async () => {
    // Antes: opera (no lanza account_inactive).
    const before = await rpc(ctx.owner.client, "assert_account_active", { p_tenant: ctx.tenantA });
    expect(before.error).toBeNull();

    const r = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: "Deuda de dos meses" });
    expect(r.error).toBeNull();
    expect(await tenantRow(ctx.tenantA)).toMatchObject({ status: "suspended", deleted_at: null, subStatus: "suspended" });

    const blocked = await rpc(ctx.owner.client, "assert_account_active", { p_tenant: ctx.tenantA });
    expect(blocked.error?.message).toMatch(/account_inactive/);
    // open_cash_shift corta antes de mirar la caja.
    const shift = await rpc(ctx.owner.client, "open_cash_shift", { p_register_id: crypto.randomUUID(), p_opening_amount: 0 });
    expect(shift.error?.message).toMatch(/account_inactive/);
    // El otro negocio sigue operando.
    const other = await rpc(ctx.ownerB.client, "assert_account_active", { p_tenant: ctx.tenantB });
    expect(other.error).toBeNull();

    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("action, reason, before_data, after_data, actor_user_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("action", "tenant_suspended");
    expect(logs).toHaveLength(1);
    expect(logs![0]).toMatchObject({
      reason: "Deuda de dos meses",
      actor_user_id: ctx.staffAdmin.id,
      before_data: { status: "active" },
      after_data: { status: "suspended" },
    });
  });

  it("suspender dos veces es una transición inválida", async () => {
    const r = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "suspend", p_reason: "otra vez lo mismo" });
    expect(r.error?.message).toMatch(/invalid_transition/);
  });

  it("el selector de estado no saca de la suspensión ni suspende sin motivo", async () => {
    const out = await rpc(ctx.staffAdmin.client, "internal_set_subscription_status", { p_tenant_id: ctx.tenantA, p_status: "active" });
    expect(out.error?.message).toMatch(/use_tenant_lifecycle/);
    const into = await rpc(ctx.staffAdmin.client, "internal_set_subscription_status", { p_tenant_id: ctx.tenantB, p_status: "suspended" });
    expect(into.error?.message).toMatch(/use_tenant_lifecycle/);
    const ok = await rpc(ctx.staffAdmin.client, "internal_set_subscription_status", { p_tenant_id: ctx.tenantB, p_status: "past_due" });
    expect(ok.error).toBeNull();
    expect((await tenantRow(ctx.tenantB)).status).toBe("past_due");
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("before_data, after_data")
      .eq("tenant_id", ctx.tenantB)
      .eq("action", "status_changed");
    expect(logs?.[0]).toMatchObject({ before_data: { status: "active" }, after_data: { status: "past_due" } });
  });

  it("reactivar vuelve a operar", async () => {
    const r = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "reactivate", p_reason: "Pagó la deuda" });
    expect(r.error).toBeNull();
    expect(await tenantRow(ctx.tenantA)).toMatchObject({ status: "active", deleted_at: null, subStatus: "active" });
    const ok = await rpc(ctx.owner.client, "assert_account_active", { p_tenant: ctx.tenantA });
    expect(ok.error).toBeNull();
  });

  it("la baja lógica es sólo de super_admin, no borra y bloquea", async () => {
    const adm = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "delete", p_reason: "Cierre del local" });
    expect(adm.error?.message).toMatch(/forbidden_super_admin_only/);

    const sup = await rpc(ctx.staffSuper.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "delete", p_reason: "Cierre del local" });
    expect(sup.error).toBeNull();
    const row = await tenantRow(ctx.tenantA);
    expect(row.status).toBe("cancelled");
    expect(row.deleted_at).not.toBeNull();

    const blocked = await rpc(ctx.owner.client, "assert_account_active", { p_tenant: ctx.tenantA });
    expect(blocked.error?.message).toMatch(/account_inactive/);

    // Aunque alguien fuerce el estado, la baja lógica sigue bloqueando.
    await ctx.admin.from("tenants").update({ status: "active" }).eq("id", ctx.tenantA);
    const still = await rpc(ctx.owner.client, "assert_account_active", { p_tenant: ctx.tenantA });
    expect(still.error?.message).toMatch(/account_inactive/);

    // Reactivar quita la baja.
    const re = await rpc(ctx.staffAdmin.client, "internal_tenant_lifecycle", { p_tenant_id: ctx.tenantA, p_action: "reactivate", p_reason: "Reabre el local" });
    expect(re.error).toBeNull();
    expect(await tenantRow(ctx.tenantA)).toMatchObject({ status: "active", deleted_at: null });
  });

  it("alta manual: authenticated (aun staff) no puede llamar la RPC", async () => {
    const r = await rpc(ctx.staffSuper.client, "internal_create_tenant", {
      p_actor: ctx.staffSuper.id,
      p_owner_user_id: ctx.owner.id,
      p_name: "No debería",
      p_slug: `nodeberia-${STAMP}`,
      p_industry: "kiosco",
      p_plan_key: "start",
      p_trial_days: 14,
      p_reason: null,
    });
    expect(r.error).not.toBeNull();
  });

  it("alta manual por service_role: crea todo, audita y desambigua el slug", async () => {
    const args = {
      p_actor: ctx.staffAdmin.id,
      p_owner_user_id: ctx.ownerB.id,
      p_name: `Nuevo ${STAMP}`,
      p_slug: `nuevo-${STAMP}`,
      p_industry: "cafeteria",
      p_plan_key: "start",
      p_trial_days: 14,
      p_reason: "Venta por teléfono",
      p_owner_invited: false,
    };
    const r1 = await rpc(ctx.admin, "internal_create_tenant", args);
    expect(r1.error).toBeNull();
    const t1 = r1.data as { tenant_id: string; slug: string; status: string };
    ctx.createdTenants.push(t1.tenant_id);
    expect(t1).toMatchObject({ slug: `nuevo-${STAMP}`, status: "trial" });

    const r2 = await rpc(ctx.admin, "internal_create_tenant", { ...args, p_trial_days: 0 });
    expect(r2.error).toBeNull();
    const t2 = r2.data as { tenant_id: string; slug: string; status: string };
    ctx.createdTenants.push(t2.tenant_id);
    expect(t2).toMatchObject({ slug: `nuevo-${STAMP}-2`, status: "active" });

    const { data: sub } = await ctx.admin.from("subscriptions").select("status, plans(key)").eq("tenant_id", t1.tenant_id).single();
    expect(sub).toMatchObject({ status: "trial", plans: { key: "start" } });
    const { data: tu } = await ctx.admin.from("tenant_users").select("user_id, role, status").eq("tenant_id", t1.tenant_id);
    expect(tu).toEqual([{ user_id: ctx.ownerB.id, role: "owner", status: "active" }]);
    const { data: stores } = await ctx.admin.from("stores").select("id, is_default").eq("tenant_id", t1.tenant_id);
    expect(stores).toHaveLength(1);
    expect(stores![0]!.is_default).toBe(true);
    const { count: regs } = await ctx.admin.from("cash_registers").select("id", { count: "exact", head: true }).eq("tenant_id", t1.tenant_id);
    expect(regs).toBe(1);
    const { data: logs } = await ctx.admin
      .from("audit_logs")
      .select("actor_user_id, reason, after_data")
      .eq("tenant_id", t1.tenant_id)
      .eq("action", "tenant_created_internal");
    expect(logs).toHaveLength(1);
    expect(logs![0]).toMatchObject({ actor_user_id: ctx.staffAdmin.id, reason: "Venta por teléfono", after_data: { plan: "start", industry: "cafeteria" } });

    // Un dueño de otro negocio no ve el negocio nuevo.
    const { data: visible } = await ctx.owner.client.from("tenants").select("id").eq("id", t1.tenant_id);
    expect(visible ?? []).toHaveLength(0);
  });

  it("alta manual: valida actor, plan, rubro y días", async () => {
    const base = {
      p_actor: ctx.staffAdmin.id,
      p_owner_user_id: ctx.ownerB.id,
      p_name: "Valido",
      p_slug: `valido-${STAMP}`,
      p_industry: "kiosco",
      p_plan_key: "start",
      p_trial_days: 7,
      p_reason: null,
      p_owner_invited: false,
    };
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_actor: ctx.owner.id })).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_actor: ctx.staffSupport.id })).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_plan_key: "no-existe" })).error?.message).toMatch(/plan_not_found/);
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_industry: "farmacia" })).error?.message).toMatch(/invalid_industry/);
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_trial_days: 120 })).error?.message).toMatch(/invalid_trial_days/);
    expect((await rpc(ctx.admin, "internal_create_tenant", { ...base, p_slug: "Con Espacios" })).error?.message).toMatch(/invalid_slug/);
    const { count } = await ctx.admin.from("tenants").select("id", { count: "exact", head: true }).like("slug", `valido-${STAMP}%`);
    expect(count).toBe(0);
  });

  it("guardarraíl: ninguna política de negocio usa is_internal() sin internal_scope()", async () => {
    const { data: leaks, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(leaks ?? []).toHaveLength(0);
  });
});
