// @vitest-environment node
// =============================================================================
// ADR-156: complemento "Email con dominio NinjaSoft" y arreglos del cobro
// (migración 20261224100000_addon_email_cobro).
//   · Las tablas nuevas no se leen directo (ni negocio ni staff): todo por RPC.
//   · La puerta de envío (email_addon_consume) y el monto esperado de MP son
//     sólo de service_role.
//   · El staff configura con scope interno y nivel admin; el dueño sólo ve su
//     oferta y contrata con el precio que vio.
//   · Una baja de addon deja de cobrarse en el período siguiente.
//   · Guardarraíles de RLS en 0.
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

const STAMP = `addm-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const TODAY = todayAR();

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  userIds: string[];
  tierId: string;
  ownerA: SupabaseClient;
  ownerB: SupabaseClient;
  support: SupabaseClient;
  adminStaff: SupabaseClient;
  adminPlain: SupabaseClient;
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

describe.skipIf(!enabled)("ADR-156 · email de NinjaSoft y cobro de addons", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const mk = async (suffix: string) => {
      const { data, error } = await ctx.admin
        .from("tenants")
        .insert({ name: `Email ${suffix} ${STAMP}`, slug: `${STAMP}-${suffix}`, status: "active", industry: "kiosco" })
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
    let base = ((plans ?? []) as { id: string; monthly_price_ars: number }[]).find((p) => Number(p.monthly_price_ars) > 0);
    if (!base) {
      // La base de CI no siembra planes pagos: el test crea el suyo.
      const { data: created, error: planErr } = await ctx.admin
        .from("plans")
        .insert({ key: `${STAMP}-plan`, name: `Plan ${STAMP}`, monthly_price_ars: 20000, is_active: true } as never)
        .select("id, monthly_price_ars")
        .single();
      if (planErr) throw planErr;
      base = created as { id: string; monthly_price_ars: number };
    }
    for (const t of [ctx.tenantA, ctx.tenantB]) {
      await ctx.admin.from("subscriptions").insert({
        tenant_id: t,
        plan_id: base.id,
        status: "active",
        billing_cycle: "monthly",
        current_period_start: `${addDays(TODAY, -10)}T15:00:00Z`,
        current_period_end: `${addDays(TODAY, 20)}T15:00:00Z`,
      });
      await ctx.admin.from("tenant_billing_terms" as never).insert({ tenant_id: t, billing_mode: "account" } as never);
    }
    await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.ownerA = await signIn(`owner-a-${STAMP}@test.local`, false);
    ctx.ownerB = await signIn(`owner-b-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.adminStaff = await signIn(`adm-${STAMP}@test.local`, true);
    ctx.adminPlain = await signIn(`adm-${STAMP}@test.local`, false);
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
    if (ctx.tierId) await safe(ctx.admin.from("email_addon_tiers" as never).update({ deleted_at: new Date().toISOString(), is_active: false } as never).eq("id", ctx.tierId));
    for (const id of ctx.userIds) {
      await safe(ctx.admin.from("tenant_users").delete().eq("user_id", id));
      await safe(ctx.admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  it("nadie lee las tablas nuevas directo", async () => {
    for (const c of [ctx.ownerA, ctx.ownerB, ctx.adminStaff]) {
      for (const table of ["email_addon_settings", "email_addon_tiers", "email_addon_usage"]) {
        const { data, error } = await c.from(table as never).select("*").limit(5);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
      }
    }
  });

  it("la puerta de envío y el monto de MP son sólo de service_role", async () => {
    expect((await rpc(ctx.ownerA, "email_addon_consume", { p_tenant: ctx.tenantA, p_count: 1 })).error).not.toBeNull();
    expect((await rpc(ctx.adminStaff, "email_addon_consume", { p_tenant: ctx.tenantA, p_count: 1 })).error).not.toBeNull();
    expect((await rpc(ctx.ownerA, "platform_mp_expected_amount", { p_tenant: ctx.tenantA })).error).not.toBeNull();
    expect((await rpc(ctx.ownerA, "platform_addons_daily")).error).not.toBeNull();
  });

  it("configuración: admin con scope sí; soporte, admin sin scope y dueño no", async () => {
    expect((await rpc(ctx.ownerA, "internal_email_addon_get")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.support, "internal_email_addon_get")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.adminPlain, "internal_email_addon_get")).error?.message).toMatch(/forbidden/);
    expect((await rpc(ctx.adminStaff, "internal_email_addon_get")).error).toBeNull();
    const t = await rpc(ctx.adminStaff, "internal_email_addon_save_tier", {
      p_id: null, p_label: `Prueba ${STAMP}`, p_quota: 10, p_price: 5000, p_sort: 99, p_active: true,
    });
    expect(t.error).toBeNull();
    ctx.tierId = t.data as string;
  });

  it("el dueño ve su oferta y contrata con el precio que vio", async () => {
    // Dominio verificado y key (lo hace la Edge con Resend; acá service_role).
    await ctx.admin.rpc("email_addon_set_provider_state" as never, {
      p: { key_source: "own", key_hint: "…test", domain: "soft.ninja", domain_status: "verified", dns_records: [] },
      p_actor: null,
    } as never);
    expect((await rpc(ctx.adminStaff, "internal_email_addon_save_settings", { p: { is_active: true } })).error).toBeNull();

    const offer = await rpc(ctx.ownerA, "owner_email_addon_offer");
    expect(offer.error).toBeNull();
    expect((offer.data as { available: boolean }).available).toBe(true);

    const wrong = await rpc(ctx.ownerA, "owner_email_addon_activate", { p_tier: ctx.tierId, p_expected_price: 1 });
    expect(wrong.error?.message).toMatch(/price_changed/);
    const ok = await rpc(ctx.ownerA, "owner_email_addon_activate", { p_tier: ctx.tierId, p_expected_price: 5000 });
    expect(ok.error).toBeNull();

    const { data: smtp } = await ctx.admin.from("tenant_email_smtp").select("provider").eq("tenant_id", ctx.tenantA).maybeSingle();
    expect((smtp as { provider: string } | null)?.provider).toBe("ninjasoft");
    // El otro negocio no ve el addon del primero.
    const offerB = await rpc(ctx.ownerB, "owner_email_addon_offer");
    expect((offerB.data as { addon: unknown }).addon).toBeNull();

    const sent = await ctx.admin.rpc("email_addon_consume" as never, { p_tenant: ctx.tenantA, p_count: 1 } as never);
    expect((sent.data as { allowed: boolean }).allowed).toBe(true);
    const otherTenant = await ctx.admin.rpc("email_addon_consume" as never, { p_tenant: ctx.tenantB, p_count: 1 } as never);
    expect((otherTenant.data as { reason: string }).reason).toBe("addon_inactive");
  });

  it("la baja deja de cobrarse en el período siguiente", async () => {
    expect((await rpc(ctx.ownerA, "cancel_addon", { p_addon_key: "email_ninjasoft" })).error).toBeNull();
    const now = await ctx.admin.rpc("platform_billing_breakdown" as never, { p_tenant: ctx.tenantA, p_at: TODAY } as never);
    const next = await ctx.admin.rpc("platform_billing_breakdown" as never, { p_tenant: ctx.tenantA, p_at: addDays(TODAY, 20) } as never);
    expect(Number((now.data as { addons_monthly: number }).addons_monthly)).toBe(5000);
    expect(Number((next.data as { addons_monthly: number }).addons_monthly)).toBe(0);
  });

  it("guardarraíles de RLS en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await ctx.admin.rpc(fn as never);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
