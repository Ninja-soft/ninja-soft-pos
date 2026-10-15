// @vitest-environment node
// =============================================================================
// F20-9 (H135 · ADR-128): punitorios, escalera de mora, promesas y feriados
// (migración 20261124100000_cobranza_mora_punitorios).
//   · Las tablas nuevas no se leen directo desde un negocio; el staff sólo con
//     el header de scope interno.
//   · El dueño y la encargada ven su estado de mora por my_billing_mora; el
//     cajero no (sólo la restricción, sin importes). Otro negocio no ve nada.
//   · Sólo el dueño carga su promesa; Cobranzas carga promesas y condona;
//     soporte sin el permiso sólo mira; la configuración es de super_admin.
//   · Los crons no se llaman desde la API.
//   · Guardarraíles de RLS en 0.
//
// Fechas en hora de Argentina (todayAR), no en UTC: entre las 21 y las 24 la
// fecha UTC ya es la de mañana y las validaciones de la base usan Argentina.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { todayAR } from "@/lib/billing/ledger";
import { addDays } from "@/lib/billing/interest";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `mora-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const TODAY = todayAR();

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const TABLES = [
  "platform_interest_policies",
  "platform_interest_policy_plans",
  "platform_dunning_ladders",
  "platform_dunning_steps",
  "platform_holidays",
  "platform_interest_pauses",
  "platform_interest_accruals",
  "platform_interest_waivers",
  "platform_fiscal_pending",
  "platform_promises",
  "platform_collection_status",
  "platform_dunning_events",
];

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  subA: string;
  userIds: string[];
  ownerA: SupabaseClient;
  managerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  support: SupabaseClient;
  cobranzas: SupabaseClient;
  cobranzasPlain: SupabaseClient;
  adminStaff: SupabaseClient;
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

async function makeUser(email: string, appMeta: Record<string, unknown>, membership?: { tenantId: string; role: string }) {
  const { data, error } = await ctx.admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, app_metadata: appMeta });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const level = appMeta.internal_level as string | undefined;
  if (level) await ctx.admin.from("users").update({ internal_level: level }).eq("id", id);
  if (membership) {
    await ctx.admin.from("tenant_users").insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
  }
  ctx.userIds.push(id);
  return id;
}

describe.skipIf(!enabled)("F20-9 · mora, punitorios y promesas", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const mk = async (suffix: string) => {
      const { data, error } = await ctx.admin
        .from("tenants")
        .insert({ name: `Mora ${suffix} ${STAMP}`, slug: `${STAMP}-${suffix}`, status: "active", industry: "kiosco" })
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    };
    ctx.tenantA = await mk("a");
    ctx.tenantB = await mk("b");
    const { data: plan } = await ctx.admin.from("plans").select("id").is("tenant_id", null).limit(1).single();
    const { data: sub, error: subErr } = await ctx.admin
      .from("subscriptions")
      .insert({ tenant_id: ctx.tenantA, plan_id: (plan as { id: string }).id, status: "active", billing_cycle: "monthly" })
      .select("id")
      .single();
    if (subErr) throw subErr;
    ctx.subA = (sub as { id: string }).id;
    await ctx.admin.from("tenant_billing_terms" as never).insert({ tenant_id: ctx.tenantA, billing_mode: "account" } as never);

    await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`manager-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "manager" });
    await makeUser(`cashier-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    const cobId = await makeUser(`cob-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    await makeUser(`super-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    await ctx.admin.from("platform_staff_permissions" as never).insert({ user_id: cobId, permission: "cobranzas" } as never);

    // Deuda vencida hace 20 días (fecha de Argentina).
    const { error: chErr } = await rpc(ctx.admin, "platform_create_charge", {
      p_tenant: ctx.tenantA,
      p_sub: ctx.subA,
      p_kind: "one_off",
      p_description: "Cuota de prueba",
      p_start: null,
      p_end: null,
      p_due: addDays(TODAY, -20),
      p_lines: [{ source: "manual", description: "Cuota de prueba", amount_cents: 5000000 }],
      p_key: `test:${STAMP}`,
      p_actor: null,
      p_source: "staff",
      p_reason: "Cargo de prueba",
    });
    if (chErr) throw new Error(chErr.message);

    ctx.ownerA = await signIn(`owner-a-${STAMP}@test.local`, false);
    ctx.managerA = await signIn(`manager-a-${STAMP}@test.local`, false);
    ctx.cashierA = await signIn(`cashier-a-${STAMP}@test.local`, false);
    ctx.ownerB = await signIn(`owner-b-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.cobranzas = await signIn(`cob-${STAMP}@test.local`, true);
    ctx.cobranzasPlain = await signIn(`cob-${STAMP}@test.local`, false);
    ctx.adminStaff = await signIn(`adm-${STAMP}@test.local`, true);
    ctx.superAdmin = await signIn(`super-${STAMP}@test.local`, true);
  }, 180_000);

  afterAll(async () => {
    const safe = async (p: PromiseLike<unknown>) => {
      try {
        await p;
      } catch {
        /* best effort */
      }
    };
    if (!ctx.admin) return;
    for (const id of ctx.userIds) {
      await safe(ctx.admin.from("platform_staff_permissions" as never).delete().eq("user_id", id));
      await safe(ctx.admin.from("tenant_users").delete().eq("user_id", id));
      await safe(ctx.admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  it("ningún negocio lee las tablas de mora directo", async () => {
    for (const c of [ctx.ownerA, ctx.managerA, ctx.cashierA, ctx.ownerB]) {
      for (const table of TABLES) {
        const { data, error } = await c.from(table as never).select("*").limit(5);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
      }
    }
  });

  it("el staff lee con el header de scope y no sin él", async () => {
    const withScope = await ctx.support.from("platform_dunning_steps" as never).select("id").limit(1);
    expect(withScope.error).toBeNull();
    expect((withScope.data ?? []).length).toBeGreaterThan(0);
    const without = await ctx.cobranzasPlain.from("platform_dunning_steps" as never).select("id").limit(1);
    expect(without.error !== null || (without.data ?? []).length === 0).toBe(true);
  });

  it("dueño y encargada ven su estado de mora; el cajero sólo la restricción", async () => {
    const own = await rpc(ctx.ownerA, "my_billing_mora");
    expect(own.error).toBeNull();
    const d = own.data as { is_owner: boolean; overdue_cents: number; days_overdue: number; as_of: string };
    expect(d.is_owner).toBe(true);
    expect(d.overdue_cents).toBe(5000000);
    expect(d.as_of).toBe(TODAY);
    const mgr = await rpc(ctx.managerA, "my_billing_mora");
    expect((mgr.data as { is_owner: boolean }).is_owner).toBe(false);
    const cash = await rpc(ctx.cashierA, "my_billing_mora");
    expect(cash.error?.message).toMatch(/forbidden/);
    const restr = await rpc(ctx.cashierA, "my_billing_restriction");
    expect(restr.error).toBeNull();
    expect(restr.data).not.toHaveProperty("overdue_cents");
  });

  it("otro negocio no ve la mora de A", async () => {
    const r = await rpc(ctx.ownerB, "internal_billing_mora", { p_tenant: ctx.tenantA });
    expect(r.error?.message).toMatch(/forbidden/);
    const own = await rpc(ctx.ownerB, "my_billing_mora");
    expect((own.data as { overdue_cents: number }).overdue_cents).toBe(0);
  });

  it("soporte sin Cobranzas mira pero no opera", async () => {
    const r = await rpc(ctx.support, "internal_billing_mora", { p_tenant: ctx.tenantA });
    expect(r.error).toBeNull();
    const w = await rpc(ctx.support, "internal_interest_waive", { p_tenant: ctx.tenantA, p_movement_ids: null, p_amount_cents: 100, p_reason: "Prueba de soporte" });
    expect(w.error?.message).toMatch(/forbidden/);
    const p = await rpc(ctx.support, "internal_promise_create", {
      p_tenant: ctx.tenantA, p_amount_cents: 1000, p_date: addDays(TODAY, 3), p_note: null, p_reason: "Prueba de soporte",
    });
    expect(p.error?.message).toMatch(/forbidden/);
  });

  it("sólo el dueño carga su promesa; Cobranzas también puede", async () => {
    const mgr = await rpc(ctx.managerA, "owner_promise_create", { p_amount_cents: 1000, p_date: addDays(TODAY, 3), p_note: null });
    expect(mgr.error?.message).toMatch(/forbidden/);
    const late = await rpc(ctx.ownerA, "owner_promise_create", { p_amount_cents: 1000, p_date: addDays(TODAY, 90), p_note: null });
    expect(late.error?.message).toMatch(/invalid_promise_date/);
    const ok = await rpc(ctx.ownerA, "owner_promise_create", { p_amount_cents: 5000000, p_date: addDays(TODAY, 5), p_note: "Cobro el viernes" });
    expect(ok.error).toBeNull();
    const dup = await rpc(ctx.cobranzas, "internal_promise_create", {
      p_tenant: ctx.tenantA, p_amount_cents: 1000, p_date: addDays(TODAY, 3), p_note: null, p_reason: "Llamado al dueño",
    });
    expect(dup.error?.message).toMatch(/promise_open_exists/);
    const id = (ok.data as { id: string }).id;
    const cancel = await rpc(ctx.cobranzas, "internal_promise_update", { p_promise: id, p_action: "cancel", p_date: null, p_reason: "Prueba de cancelación" });
    expect(cancel.error).toBeNull();
  });

  it("la configuración es de super_admin", async () => {
    const day = addDays(TODAY, 700);
    const adm = await rpc(ctx.adminStaff, "internal_holiday_save", { p_day: day, p_name: "Feriado de prueba", p_reason: "Prueba de feriado" });
    expect(adm.error?.message).toMatch(/forbidden/);
    const cfgAdmin = await rpc(ctx.adminStaff, "internal_billing_set_mora_settings", { p_data: { dunning_enabled: true }, p_reason: "Prueba de admin" });
    expect(cfgAdmin.error?.message).toMatch(/forbidden/);
    const sup = await rpc(ctx.superAdmin, "internal_holiday_save", { p_day: day, p_name: "Feriado de prueba", p_reason: "Prueba de feriado" });
    expect(sup.error).toBeNull();
    const del = await rpc(ctx.superAdmin, "internal_holiday_delete", { p_day: day, p_reason: "Fin de la prueba" });
    expect(del.error).toBeNull();
    const cfg = await rpc(ctx.support, "internal_billing_mora_config");
    expect(cfg.error).toBeNull();
    expect((cfg.data as { can_configure: boolean }).can_configure).toBe(false);
  });

  it("las condiciones de mora del negocio: admin sí, Cobranzas no", async () => {
    const cob = await rpc(ctx.cobranzas, "internal_billing_set_mora_terms", { p_tenant: ctx.tenantA, p_data: { self_promise_enabled: false }, p_reason: "Prueba de Cobranzas" });
    expect(cob.error?.message).toMatch(/forbidden/);
    const adm = await rpc(ctx.adminStaff, "internal_billing_set_mora_terms", { p_tenant: ctx.tenantA, p_data: { self_promise_enabled: null }, p_reason: "Prueba de admin" });
    expect(adm.error).toBeNull();
  });

  it("los crons y el motor no se llaman desde la API", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["platform_interest_run", {}],
      ["platform_dunning_run", {}],
      ["platform_mora_evaluate", { p_tenant: ctx.tenantA, p_today: TODAY, p_run_steps: true }],
      ["platform_interest_accrue_tenant", { p_tenant: ctx.tenantA, p_today: TODAY }],
      ["platform_interest_apply_waiver", { p_waiver: ctx.tenantA, p_actor: null }],
    ];
    for (const [fn, args] of calls) {
      const r = await rpc(ctx.superAdmin, fn, args);
      expect(r.error).not.toBeNull();
    }
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn as never);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
