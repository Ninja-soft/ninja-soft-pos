// @vitest-environment node
// =============================================================================
// F21 · ADR-121: participación del staff (migración
// 20261115200000_staff_participacion).
//   · Sólo super_admin (en el panel interno) configura, ve gastos y cierra;
//     un admin, uno de soporte y el permiso Cobranzas no alcanzan.
//   · Cada persona ve sólo SU participación, reglas, líneas, pagos y cuentas;
//     sin el header de scope no ve nada; un dueño de negocio no ve nada.
//   · Los insumos del cálculo (staff_settlement_inputs) son sólo service_role.
//   · Cuentas de cobro: la persona carga las suyas, no las de otro; CBU
//     validado.
//   · rls_internal_scope_leaks() = 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `stf-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

/** CBU con los dos dígitos verificadores correctos. */
function validCbu(b1: string, b2: string): string {
  const w1 = [7, 1, 3, 9, 7, 1, 3];
  const w2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  const d1 = (10 - ([...b1].reduce((s, c, i) => s + Number(c) * w1[i]!, 0) % 10)) % 10;
  const d2 = (10 - ([...b2].reduce((s, c, i) => s + Number(c) * w2[i]!, 0) % 10)) % 10;
  return `${b1}${d1}${b2}${d2}`;
}

const ctx = {} as {
  admin: SupabaseClient;
  userIds: string[];
  tenant: string;
  superAdmin: SupabaseClient;
  superNoScope: SupabaseClient;
  adminStaff: SupabaseClient;
  juan: SupabaseClient;
  juanNoScope: SupabaseClient;
  support: SupabaseClient;
  owner: SupabaseClient;
  juanUser: string;
  anaUser: string;
  juanMember: string;
  anaMember: string;
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

async function makeUser(email: string, appMeta: Record<string, unknown>, membership?: { tenantId: string; role: string }): Promise<string> {
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

describe.skipIf(!enabled)("F21 · participación del staff", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await ctx.admin
      .from("tenants")
      .insert({ name: `Staff ${STAMP}`, slug: `${STAMP}-t`, status: "active", industry: "kiosco" })
      .select("id")
      .single();
    if (error) throw error;
    ctx.tenant = (t as { id: string }).id;

    await makeUser(`super-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    await makeUser(`admin-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.juanUser = await makeUser(`juan-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    ctx.anaUser = await makeUser(`ana-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenant }, { tenantId: ctx.tenant, role: "owner" });

    ctx.superAdmin = await signIn(`super-${STAMP}@test.local`, true);
    ctx.superNoScope = await signIn(`super-${STAMP}@test.local`, false);
    ctx.adminStaff = await signIn(`admin-${STAMP}@test.local`, true);
    ctx.juan = await signIn(`juan-${STAMP}@test.local`, true);
    ctx.juanNoScope = await signIn(`juan-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.owner = await signIn(`owner-${STAMP}@test.local`, false);
  });

  afterAll(async () => {
    if (!enabled) return;
    for (const id of ctx.userIds) await ctx.admin.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("sólo super_admin en el panel interno configura", async () => {
    const args = { p_id: null, p_user_id: ctx.juanUser, p_display_name: "Juan", p_email: null, p_notes: null, p_is_active: true, p_reason: "Alta de Juan" };
    expect((await rpc(ctx.adminStaff, "internal_staff_save_member", args)).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.superNoScope, "internal_staff_save_member", args)).error?.message).toMatch(/forbidden/);
    const j = await rpc(ctx.superAdmin, "internal_staff_save_member", args);
    expect(j.error).toBeNull();
    ctx.juanMember = j.data as string;
    const a = await rpc(ctx.superAdmin, "internal_staff_save_member", { ...args, p_user_id: ctx.anaUser, p_display_name: "Ana", p_reason: "Alta de Ana" });
    expect(a.error).toBeNull();
    ctx.anaMember = a.data as string;
    const today = new Date().toISOString().slice(0, 10);
    expect((await rpc(ctx.superAdmin, "internal_staff_set_share", { p_member: ctx.juanMember, p_share_bp: 4000, p_expense_bp: null, p_valid_from: today, p_reason: "Socio" })).error).toBeNull();
    expect((await rpc(ctx.superAdmin, "internal_staff_set_share", { p_member: ctx.anaMember, p_share_bp: 3000, p_expense_bp: 1000, p_valid_from: today, p_reason: "Socia" })).error).toBeNull();
    const over = await rpc(ctx.superAdmin, "internal_staff_set_share", { p_member: ctx.anaMember, p_share_bp: 7000, p_expense_bp: null, p_valid_from: today, p_reason: "Demasiado" });
    expect(over.error?.message).toMatch(/shares_over_100/);
    const exp = await rpc(ctx.superAdmin, "internal_staff_save_expense", {
      p_id: null,
      p: { name: "Servidor", category: "servidores", amount_cents: 2500, currency: "USD", recurrence: "monthly", start_date: today, allocation: "proportional" },
      p_reason: "Servidor de producción",
    });
    expect(exp.error).toBeNull();
  });

  it("cada persona ve sólo lo suyo; los gastos, nadie más que el dueño", async () => {
    const { data: shares } = await ctx.juan.from("staff_shares").select("member_id");
    expect((shares ?? []).every((s: { member_id: string }) => s.member_id === ctx.juanMember)).toBe(true);
    expect((shares ?? []).length).toBe(1);
    expect(((await ctx.juan.from("staff_expenses").select("id")).data ?? []).length).toBe(0);
    expect(((await ctx.juan.from("staff_members").select("id")).data ?? []).length).toBe(1);
    expect(((await ctx.support.from("staff_shares").select("id")).data ?? []).length).toBe(0);
    expect(((await ctx.adminStaff.from("staff_expenses").select("id")).data ?? []).length).toBe(0);
    expect(((await ctx.juanNoScope.from("staff_shares").select("id")).data ?? []).length).toBe(0);
    expect(((await ctx.owner.from("staff_shares").select("id")).data ?? []).length).toBe(0);
    expect(((await ctx.superAdmin.from("staff_expenses").select("id")).data ?? []).length).toBeGreaterThan(0);
    const mine = await rpc(ctx.juan, "my_staff_summary");
    expect((mine.data as { member: { name: string } }).member.name).toBe("Juan");
  });

  it("los insumos del cálculo y el cierre no están al alcance del staff común", async () => {
    expect((await rpc(ctx.superAdmin, "staff_settlement_inputs", { p_period: "2026-01-01" })).error).not.toBeNull();
    expect((await rpc(ctx.juan, "internal_staff_close_run", { p_period: "2026-01-01", p_result: {}, p_notes: null })).error?.message).toMatch(/forbidden/);
    const { error } = await ctx.juan.from("staff_payout_runs").insert({ period: "2026-01-01" } as never);
    expect(error).not.toBeNull();
  });

  it("cuentas de cobro: la propia sí, la de otro no, CBU validado", async () => {
    const bad = await rpc(ctx.juan, "internal_staff_save_bank_account", {
      p_id: null,
      p_member: ctx.juanMember,
      p: { bank_name: "Galicia", holder_name: "Juan", cbu: "0070000000000000000000" },
      p_is_default: true,
    });
    expect(bad.error?.message).toMatch(/invalid_cbu/);
    const ok = await rpc(ctx.juan, "internal_staff_save_bank_account", {
      p_id: null,
      p_member: ctx.juanMember,
      p: { bank_slug: "galicia", bank_name: "Banco Galicia", holder_name: "Juan", cbu: validCbu("0070999", "0300041234567"), alias: `juan.${STAMP}`.slice(0, 20) },
      p_is_default: true,
    });
    expect(ok.error).toBeNull();
    const other = await rpc(ctx.juan, "internal_staff_save_bank_account", {
      p_id: null,
      p_member: ctx.anaMember,
      p: { bank_name: "X", holder_name: "Ana", alias: "ana.alias.ok" },
      p_is_default: false,
    });
    expect(other.error?.message).toMatch(/forbidden/);
  });

  it("rls_internal_scope_leaks() = 0", async () => {
    const { data } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect((data as unknown[] | null) ?? []).toHaveLength(0);
  });
});
