// @vitest-environment node
// =============================================================================
// F20-8 (ADR-120): suscripción por cuenta corriente (migración
// 20261115200000_cobranza_cuenta_corriente).
//   · Cuentas para cobrar: sólo super_admin las carga; el negocio no lee la
//     tabla (las ve por my_billing_account).
//   · "Ya transferí": sólo el dueño informa, en la carpeta de su negocio; otro
//     negocio no ve sus avisos; Cobranzas verifica e imputa; soporte sin el
//     permiso no.
//   · Cambio de modalidad: soporte no; admin sí; set_terms ya no cambia la
//     modalidad.
//   · Códigos de invitación: escritura sólo por RPC; el canje de cuenta
//     corriente deja al negocio en esa modalidad.
//   · Límites: el staff lee con scope; soporte no guarda.
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

const STAMP = `cta-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

// CBU válido a partir de 7 + 13 dígitos.
function cbu(a7: string, b13: string) {
  const w1 = [7, 1, 3, 9, 7, 1, 3];
  const w2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  const s1 = [...a7].reduce((s, d, i) => s + Number(d) * w1[i]!, 0);
  const s2 = [...b13].reduce((s, d, i) => s + Number(d) * w2[i]!, 0);
  return `${a7}${(10 - (s1 % 10)) % 10}${b13}${(10 - (s2 % 10)) % 10}`;
}

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  tenantN: string;
  userIds: string[];
  ownerA: SupabaseClient;
  cashierA: SupabaseClient;
  ownerB: SupabaseClient;
  ownerN: SupabaseClient;
  support: SupabaseClient;
  supportPlain: SupabaseClient;
  cobranzas: SupabaseClient;
  adminStaff: SupabaseClient;
  superAdmin: SupabaseClient;
  reportId: string;
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

async function makeTenant(slug: string, status: "active" | "trial", preapproval: string | null): Promise<string> {
  const { data: t, error } = await ctx.admin
    .from("tenants")
    .insert({ name: `Cuenta corriente ${slug}`, slug, status, industry: "kiosco" })
    .select("id")
    .single();
  if (error) throw error;
  const id = (t as { id: string }).id;
  const { data: plan } = await ctx.admin.from("plans").select("id").eq("key", "start").is("tenant_id", null).single();
  await ctx.admin.from("subscriptions").insert({
    tenant_id: id,
    plan_id: plan!.id,
    status,
    billing_cycle: "monthly",
    current_period_start: status === "active" ? new Date(Date.now() - 5 * 86_400_000).toISOString() : null,
    current_period_end: status === "active" ? new Date(Date.now() + 25 * 86_400_000).toISOString() : null,
    mp_preapproval_id: preapproval,
  });
  return id;
}

describe.skipIf(!enabled)("F20-8 · suscripción por cuenta corriente", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    ctx.tenantA = await makeTenant(`${STAMP}-a`, "active", null);
    ctx.tenantB = await makeTenant(`${STAMP}-b`, "active", `pre-${STAMP}`);
    ctx.tenantN = await makeTenant(`${STAMP}-n`, "trial", null);

    await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`cashier-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    await makeUser(`owner-n-${STAMP}@test.local`, { current_tenant_id: ctx.tenantN }, { tenantId: ctx.tenantN, role: "owner" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    const cobId = await makeUser(`cob-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`admin-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    await makeUser(`super-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    await ctx.admin.from("platform_staff_permissions").insert({ user_id: cobId, permission: "cobranzas", reason: "test" });

    ctx.ownerA = await signIn(`owner-a-${STAMP}@test.local`, false);
    ctx.cashierA = await signIn(`cashier-a-${STAMP}@test.local`, false);
    ctx.ownerB = await signIn(`owner-b-${STAMP}@test.local`, false);
    ctx.ownerN = await signIn(`owner-n-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.supportPlain = await signIn(`support-${STAMP}@test.local`, false);
    ctx.cobranzas = await signIn(`cob-${STAMP}@test.local`, true);
    ctx.adminStaff = await signIn(`admin-${STAMP}@test.local`, true);
    ctx.superAdmin = await signIn(`super-${STAMP}@test.local`, true);
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
      await safe(ctx.admin.from("platform_staff_permissions").delete().eq("user_id", id));
      await safe(ctx.admin.from("tenant_users").delete().eq("user_id", id));
      await safe(ctx.admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  it("sólo super_admin carga cuentas para cobrar; el negocio no lee la tabla", async () => {
    const data = { bank_slug: "galicia", bank_name: "Banco Galicia", holder_name: "Ninja Soft", cbu: cbu("0070999", "0000000123456") };
    const denied = await rpc(ctx.adminStaff, "internal_platform_bank_account_save", { p_id: null, p_data: data, p_reason: "Cuenta de prueba" });
    expect(denied.error?.message).toMatch(/forbidden/);
    const ok = await rpc(ctx.superAdmin, "internal_platform_bank_account_save", { p_id: null, p_data: data, p_reason: "Cuenta de prueba" });
    expect(ok.error).toBeNull();
    const { data: rows } = await ctx.ownerA.from("platform_bank_accounts" as never).select("id");
    expect(rows ?? []).toHaveLength(0);
    const mine = await rpc(ctx.ownerA, "my_billing_account");
    expect(mine.error).toBeNull();
    expect(((mine.data as { bank_accounts: unknown[] }).bank_accounts ?? []).length).toBeGreaterThan(0);
    await rpc(ctx.superAdmin, "internal_platform_bank_account_delete", { p_id: ok.data, p_reason: "Fin de la prueba" });
  });

  it("el cambio de modalidad: soporte no, admin sí; set_terms no la cambia", async () => {
    const denied = await rpc(ctx.support, "internal_billing_change_mode", {
      p_tenant: ctx.tenantB, p_to: "account", p_due_days: 10, p_exempt_reason: null, p_reason: "Pasa a transferencia",
    });
    expect(denied.error?.message).toMatch(/forbidden/);
    const r = await rpc(ctx.adminStaff, "internal_billing_change_mode", {
      p_tenant: ctx.tenantB, p_to: "account", p_due_days: 10, p_exempt_reason: null, p_reason: "Pasa a transferencia",
    });
    expect(r.error).toBeNull();
    const res = r.data as { needs_mp_cancel: boolean; change_id: string };
    expect(res.needs_mp_cancel).toBe(true);
    // Sin llamar a Mercado Pago real: se informa el resultado como si hubiera fallado.
    const fail = await rpc(ctx.adminStaff, "internal_billing_mode_change_mp_result", { p_change: res.change_id, p_ok: false, p_detail: "test" });
    expect(fail.error).toBeNull();
    const terms = await rpc(ctx.adminStaff, "internal_billing_set_terms", {
      p_tenant: ctx.tenantB, p_billing_mode: "mp_subscription", p_exempt_reason: null, p_due_days: 5, p_reason: "Atajo",
    });
    expect(terms.error?.message).toMatch(/use_mode_change/);
    const { data: own } = await ctx.ownerB.from("platform_billing_mode_changes" as never).select("tenant_id");
    expect(((own ?? []) as { tenant_id: string }[]).every((c) => c.tenant_id === ctx.tenantB)).toBe(true);
    const { data: other } = await ctx.ownerA.from("platform_billing_mode_changes" as never).select("id").eq("tenant_id", ctx.tenantB);
    expect(other ?? []).toHaveLength(0);
  });

  it("códigos de invitación: sólo por RPC; el canje deja al negocio en cuenta corriente", async () => {
    const direct = await ctx.adminStaff.from("invite_codes").insert({ code: `X${STAMP}`, kind: "trial_days", plan_key: "start" });
    expect(direct.error).not.toBeNull();
    const code = `CTA${STAMP.replace(/[^a-z0-9]/gi, "").toUpperCase()}`;
    const c = await rpc(ctx.adminStaff, "internal_invite_code_create", {
      p_data: { code, kind: "account", plan_key: "start", due_days: 7, discount_percent: 10, discount_months: 2, max_uses: 1 },
    });
    expect(c.error).toBeNull();
    const red = await rpc(ctx.ownerN, "redeem_invite_code", { p_code: code, p_tenant_id: ctx.tenantN });
    expect(red.error).toBeNull();
    const { data: terms } = await ctx.admin.from("tenant_billing_terms").select("billing_mode, due_days").eq("tenant_id", ctx.tenantN).single();
    expect(terms).toMatchObject({ billing_mode: "account", due_days: 7 });
    const again = await rpc(ctx.ownerA, "redeem_invite_code", { p_code: code, p_tenant_id: ctx.tenantA });
    expect(again.error?.message).toMatch(/code_exhausted/);
  });

  it("Ya transferí: sólo el dueño, en su carpeta; otro negocio no lo ve", async () => {
    const args = (path: string) => ({
      p_amount_cents: 150_000, p_paid_on: new Date().toISOString().slice(0, 10), p_bank_account: null,
      p_reference: "TRF-1", p_note: null, p_proof_path: path, p_proof_sha256: null, p_proof_mime: "application/pdf",
    });
    const cashier = await rpc(ctx.cashierA, "owner_report_transfer", args(`${ctx.tenantA}/a.pdf`));
    expect(cashier.error?.message).toMatch(/forbidden/);
    const foreign = await rpc(ctx.ownerA, "owner_report_transfer", args(`${ctx.tenantB}/a.pdf`));
    expect(foreign.error?.message).toMatch(/invalid_proof/);
    const ok = await rpc(ctx.ownerA, "owner_report_transfer", args(`${ctx.tenantA}/a.pdf`));
    expect(ok.error).toBeNull();
    ctx.reportId = ok.data as string;
    const { data: mine } = await ctx.ownerA.from("platform_transfer_reports" as never).select("id");
    expect((mine ?? []).length).toBe(1);
    const { data: theirs } = await ctx.ownerB.from("platform_transfer_reports" as never).select("id");
    expect(theirs ?? []).toHaveLength(0);
  });

  it("verificar: soporte sin Cobranzas no; Cobranzas imputa", async () => {
    const denied = await rpc(ctx.support, "internal_billing_verify_transfer", {
      p_report: ctx.reportId, p_approve: true, p_amount_cents: null, p_reason: "Verificado en el banco",
    });
    expect(denied.error?.message).toMatch(/forbidden/);
    const ok = await rpc(ctx.cobranzas, "internal_billing_verify_transfer", {
      p_report: ctx.reportId, p_approve: true, p_amount_cents: null, p_reason: "Verificado en el banco",
    });
    expect(ok.error).toBeNull();
    const { data: pay } = await ctx.admin
      .from("platform_payments")
      .select("method, amount_cents")
      .eq("id", (ok.data as { payment_id: string }).payment_id)
      .single();
    expect(pay).toMatchObject({ method: "transfer", amount_cents: 150_000 });
  });

  it("límites: el staff lee con scope; soporte no guarda", async () => {
    const noScope = await rpc(ctx.supportPlain, "internal_tenant_limits", { p_tenant: ctx.tenantA });
    expect(noScope.error?.message).toMatch(/forbidden/);
    const read = await rpc(ctx.support, "internal_tenant_limits", { p_tenant: ctx.tenantA });
    expect(read.error).toBeNull();
    const save = await rpc(ctx.support, "internal_set_limit_overrides", {
      p_tenant: ctx.tenantA, p_overrides: { max_users: 10 }, p_reason: "Más usuarios",
    });
    expect(save.error?.message).toMatch(/forbidden/);
    const adminSave = await rpc(ctx.adminStaff, "internal_set_limit_overrides", {
      p_tenant: ctx.tenantA, p_overrides: { max_users: 10 }, p_reason: "Más usuarios",
    });
    expect(adminSave.error).toBeNull();
  });

  it("la vista del staff exige el contexto interno", async () => {
    const plain = await rpc(ctx.supportPlain, "internal_billing_collection", { p_tenant: null });
    expect(plain.error?.message).toMatch(/forbidden/);
    const owner = await rpc(ctx.ownerA, "internal_billing_collection", { p_tenant: null });
    expect(owner.error?.message).toMatch(/forbidden/);
  });

  it("rls_internal_scope_leaks() sigue en 0", async () => {
    const { data, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
