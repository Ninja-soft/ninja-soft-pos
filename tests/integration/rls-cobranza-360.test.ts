// @vitest-environment node
// =============================================================================
// H136 (F20-10 y F20-11 · ADR-131): prorrateo, conciliación con Mercado Pago y
// cobranza 360 (migración 20261126100000_cobranza_360).
//   · Las tablas nuevas no se leen directo desde un negocio; el staff sólo con
//     el header de scope interno.
//   · Permisos finos: "sólo ver" mira la cartera y simula; "asignar" reparte
//     cobradores; Cobranzas gestiona (notas, conciliación); cambiar el plan es
//     de admin.
//   · El cambio de plan inmediato usa el cargo que vio el staff (quote_changed).
//   · La entrada de la Edge de conciliación sólo la llama service_role.
//   · Guardarraíles de RLS en 0.
//
// Fechas en hora de Argentina (todayAR), no en UTC.
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

const STAMP = `c360-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const TODAY = todayAR();

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const TABLES = [
  "platform_collection_notes",
  "platform_plan_changes",
  "platform_mp_recon_runs",
  "platform_mp_payments_seen",
  "platform_recon_diffs",
];

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  subA: string;
  planUp: string | null;
  userIds: string[];
  cobId: string;
  ownerA: SupabaseClient;
  ownerB: SupabaseClient;
  support: SupabaseClient;
  viewer: SupabaseClient;
  assigner: SupabaseClient;
  cobranzas: SupabaseClient;
  cobranzasPlain: SupabaseClient;
  adminStaff: SupabaseClient;
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

describe.skipIf(!enabled)("H136 · prorrateo, conciliación y cobranza 360", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const mk = async (suffix: string) => {
      const { data, error } = await ctx.admin
        .from("tenants")
        .insert({ name: `C360 ${suffix} ${STAMP}`, slug: `${STAMP}-${suffix}`, status: "active", industry: "kiosco" })
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    };
    ctx.tenantA = await mk("a");
    ctx.tenantB = await mk("b");
    const { data: plans } = await ctx.admin
      .from("plans")
      .select("id, monthly_price_ars")
      .is("tenant_id", null)
      .eq("is_active", true)
      .order("monthly_price_ars", { ascending: true });
    const list = (plans ?? []) as { id: string; monthly_price_ars: number }[];
    const base = list.find((p) => Number(p.monthly_price_ars) > 0) ?? list[0];
    if (!base) throw new Error("No hay planes globales activos");
    ctx.planUp = list.find((p) => Number(p.monthly_price_ars) > Number(base.monthly_price_ars))?.id ?? null;
    // Período vigente: empezó hace 10 días (fecha de Argentina) y dura un mes.
    const start = `${addDays(TODAY, -10)}T15:00:00Z`;
    const end = `${addDays(TODAY, 20)}T15:00:00Z`;
    const { data: sub, error: subErr } = await ctx.admin
      .from("subscriptions")
      .insert({ tenant_id: ctx.tenantA, plan_id: base.id, status: "active", billing_cycle: "monthly", current_period_start: start, current_period_end: end })
      .select("id")
      .single();
    if (subErr) throw subErr;
    ctx.subA = (sub as { id: string }).id;
    await ctx.admin.from("tenant_billing_terms" as never).insert({ tenant_id: ctx.tenantA, billing_mode: "account" } as never);

    await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    const verId = await makeUser(`ver-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    const asgId = await makeUser(`asg-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    ctx.cobId = await makeUser(`cob-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    await ctx.admin.from("platform_staff_permissions" as never).insert([
      { user_id: ctx.cobId, permission: "cobranzas" },
      { user_id: verId, permission: "cobranzas_ver" },
      { user_id: asgId, permission: "cobranzas_asignar" },
    ] as never);

    ctx.ownerA = await signIn(`owner-a-${STAMP}@test.local`, false);
    ctx.ownerB = await signIn(`owner-b-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.viewer = await signIn(`ver-${STAMP}@test.local`, true);
    ctx.assigner = await signIn(`asg-${STAMP}@test.local`, true);
    ctx.cobranzas = await signIn(`cob-${STAMP}@test.local`, true);
    ctx.cobranzasPlain = await signIn(`cob-${STAMP}@test.local`, false);
    ctx.adminStaff = await signIn(`adm-${STAMP}@test.local`, true);
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

  it("ningún negocio lee las tablas nuevas directo", async () => {
    for (const c of [ctx.ownerA, ctx.ownerB]) {
      for (const table of TABLES) {
        const { data, error } = await c.from(table as never).select("*").limit(5);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
      }
    }
  });

  it("el staff lee con el header de scope y no sin él", async () => {
    const withScope = await ctx.support.from("platform_mp_recon_runs" as never).select("id").limit(1);
    expect(withScope.error).toBeNull();
    const without = await ctx.cobranzasPlain.from("platform_collection_notes" as never).select("id").limit(1);
    expect(without.error !== null || (without.data ?? []).length === 0).toBe(true);
  });

  it("capacidades finas sobre Cobranzas", async () => {
    const caps = async (c: SupabaseClient) => ((await rpc(c, "internal_my_billing_access")).data as { capabilities: string[] }).capabilities.slice().sort();
    expect(await caps(ctx.support)).toEqual([]);
    expect(await caps(ctx.viewer)).toEqual(["view"]);
    expect(await caps(ctx.assigner)).toEqual(["assign", "view"]);
    expect(await caps(ctx.cobranzas)).toEqual(["manage", "view"]);
    expect(await caps(ctx.adminStaff)).toEqual(["assign", "manage", "view"]);
  });

  it("la cartera y el timeline: el staff con permiso sí, el dueño y soporte sin permiso no", async () => {
    expect((await rpc(ctx.ownerA, "internal_billing_portfolio")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.support, "internal_billing_portfolio")).error?.message).toMatch(/forbidden/);
    const pf = await rpc(ctx.viewer, "internal_billing_portfolio");
    expect(pf.error).toBeNull();
    expect((pf.data as { as_of: string }).as_of).toBe(TODAY);
    const tl = await rpc(ctx.viewer, "internal_billing_timeline", { p_tenant: ctx.tenantA, p_from: null, p_to: null });
    expect(tl.error).toBeNull();
    expect((await rpc(ctx.ownerB, "internal_billing_timeline", { p_tenant: ctx.tenantA, p_from: null, p_to: null })).error?.message).toMatch(/forbidden/);
  });

  it("asignar, gestionar y sólo ver", async () => {
    const v = await rpc(ctx.viewer, "internal_billing_assign", { p_tenants: [ctx.tenantA], p_user: ctx.cobId, p_reason: null });
    expect(v.error?.message).toMatch(/forbidden/);
    const a = await rpc(ctx.assigner, "internal_billing_assign", { p_tenants: [ctx.tenantA], p_user: ctx.cobId, p_reason: "Reparto" });
    expect(a.error).toBeNull();
    expect(a.data).toBe(1);
    const noteByAssigner = await rpc(ctx.assigner, "internal_collection_note_add", {
      p_tenant: ctx.tenantA, p_kind: "call", p_outcome: null, p_body: "Lo llamé", p_next_action_at: null,
    });
    expect(noteByAssigner.error?.message).toMatch(/forbidden/);
    const note = await rpc(ctx.cobranzas, "internal_collection_note_add", {
      p_tenant: ctx.tenantA, p_kind: "whatsapp", p_outcome: "promised", p_body: "Paga el viernes", p_next_action_at: addDays(TODAY, 3),
    });
    expect(note.error).toBeNull();
    const past = await rpc(ctx.cobranzas, "internal_collection_note_add", {
      p_tenant: ctx.tenantA, p_kind: "call", p_outcome: null, p_body: "Fecha vieja", p_next_action_at: addDays(TODAY, -1),
    });
    expect(past.error?.message).toMatch(/invalid_next_action/);
    const pf = await rpc(ctx.cobranzas, "internal_billing_portfolio");
    const row = (pf.data as { rows: { tenant_id: string; collector: { id: string } | null; next_action_at: string | null }[] }).rows
      .find((r) => r.tenant_id === ctx.tenantA);
    expect(row?.collector?.id).toBe(ctx.cobId);
    expect(row?.next_action_at).toBe(addDays(TODAY, 3));
  });

  it("simular es de quien ve; confirmar el cambio de plan es de admin y respeta lo simulado", async () => {
    if (!ctx.planUp) return;
    const prev = await rpc(ctx.viewer, "internal_billing_proration_preview", { p_tenant: ctx.tenantA, p_plan: ctx.planUp, p_cycle: null, p_timing: "auto" });
    expect(prev.error).toBeNull();
    const q = prev.data as { kind: string; timing: string; charge_cents: number; bonus_cents: number };
    expect(q.kind).toBe("upgrade");
    const args = { p_tenant: ctx.tenantA, p_plan: ctx.planUp, p_cycle: null, p_timing: "auto", p_reason: "Sube de plan", p_request_id: crypto.randomUUID() };
    expect((await rpc(ctx.cobranzas, "internal_billing_plan_change", { ...args, p_expected: null })).error?.message).toMatch(/forbidden/);
    const wrong = await rpc(ctx.adminStaff, "internal_billing_plan_change", { ...args, p_expected: { charge_cents: q.charge_cents + 1 } });
    expect(wrong.error?.message).toMatch(/quote_changed/);
    const ok = await rpc(ctx.adminStaff, "internal_billing_plan_change", {
      ...args, p_expected: { charge_cents: q.charge_cents, bonus_cents: q.bonus_cents, timing: q.timing },
    });
    expect(ok.error).toBeNull();
    expect((ok.data as { status: string }).status).toBe("applied");
    const again = await rpc(ctx.adminStaff, "internal_billing_plan_change", { ...args, p_expected: null });
    expect((again.data as { replayed: boolean }).replayed).toBe(true);
  });

  it("la bandeja de conciliación: ver con permiso; resolver es de Cobranzas", async () => {
    expect((await rpc(ctx.support, "internal_recon_overview", { p_status: "open" })).error?.message).toMatch(/forbidden/);
    const ov = await rpc(ctx.viewer, "internal_recon_overview", { p_status: "open" });
    expect(ov.error).toBeNull();
    expect((ov.data as { can_manage: boolean }).can_manage).toBe(false);
    const fake = await rpc(ctx.cobranzas, "internal_recon_resolve", { p_diff: ctx.tenantA, p_action: "ignore", p_tenant: null, p_reason: "No existe" });
    expect(fake.error?.message).toMatch(/diff_not_found/);
    const cfg = await rpc(ctx.adminStaff, "internal_recon_set_settings", { p_window_hours: 72, p_tolerance_cents: 100, p_reason: "Prueba de admin" });
    expect(cfg.error?.message).toMatch(/forbidden/);
  });

  it("la entrada de la Edge y los crons no se llaman desde la API", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["platform_recon_begin", { p_source: "manual", p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date().toISOString(), p_actor: null }],
      ["platform_recon_inputs", { p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date().toISOString() }],
      ["platform_recon_finish", { p_run: ctx.tenantA, p_status: "ok", p_message: "x", p_result: {} }],
      ["platform_plan_changes_run", {}],
      ["platform_register_partial_refund", { p_payment: ctx.tenantA, p_refunded_cents: 1, p_reason: "x", p_actor: null }],
    ];
    for (const [fn, args] of calls) {
      const r = await rpc(ctx.adminStaff, fn, args);
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
