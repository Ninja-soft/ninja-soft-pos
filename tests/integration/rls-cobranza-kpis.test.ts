// @vitest-environment node
// =============================================================================
// F20-2 (H128 · ADR-127): snapshots de MRR y KPIs de cobranza (migración
// 20261122100000_cobranza_mrr_snapshots).
//   · internal_billing_kpis sólo para Cobranzas, admin o super_admin bajo el
//     header de scope interno; soporte sin el permiso, staff sin header y
//     dueños de negocio reciben forbidden.
//   · platform_mrr_snapshots y platform_mrr_daily no se leen directo (ni el
//     staff): sólo por la RPC.
//   · El cron (platform_mrr_snapshot_run) no lo puede llamar nadie desde la API.
//   · Guardarraíles de RLS en 0.
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

const STAMP = `kpi-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

const ctx = {} as {
  admin: SupabaseClient;
  tenantA: string;
  userIds: string[];
  ownerA: SupabaseClient;
  support: SupabaseClient;
  cobranzas: SupabaseClient;
  cobranzasPlain: SupabaseClient;
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

describe.skipIf(!enabled)("F20-2 · snapshots de MRR y KPIs de cobranza", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await ctx.admin
      .from("tenants")
      .insert({ name: `KPIs ${STAMP}`, slug: STAMP, status: "active", industry: "kiosco" })
      .select("id")
      .single();
    if (error) throw error;
    ctx.tenantA = (t as { id: string }).id;

    await makeUser(`owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    await makeUser(`support-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    const cobId = await makeUser(`cob-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
    await makeUser(`super-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    await ctx.admin.from("platform_staff_permissions" as never).insert({ user_id: cobId, permission: "cobranzas" } as never);

    ctx.ownerA = await signIn(`owner-${STAMP}@test.local`, false);
    ctx.support = await signIn(`support-${STAMP}@test.local`, true);
    ctx.cobranzas = await signIn(`cob-${STAMP}@test.local`, true);
    ctx.cobranzasPlain = await signIn(`cob-${STAMP}@test.local`, false);
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
    await safe(ctx.admin.from("tenants").delete().eq("id", ctx.tenantA));
  }, 120_000);

  it("Cobranzas y super_admin leen los KPIs", async () => {
    for (const c of [ctx.cobranzas, ctx.superAdmin]) {
      const r = await rpc(c, "internal_billing_kpis", { p_months: 6 });
      expect(r.error).toBeNull();
      const d = r.data as { boundaries: { live: boolean }[]; collections: unknown[] };
      expect(d.boundaries.at(-1)?.live).toBe(true);
      expect(d.collections).toHaveLength(6);
    }
  });

  it("soporte sin Cobranzas, staff sin header y dueños: forbidden", async () => {
    for (const c of [ctx.support, ctx.cobranzasPlain, ctx.ownerA]) {
      const r = await rpc(c, "internal_billing_kpis", { p_months: 12 });
      expect(r.error?.message).toMatch(/forbidden/);
    }
  });

  it("las tablas de snapshots no se leen directo, ni siquiera el staff", async () => {
    for (const c of [ctx.superAdmin, ctx.ownerA]) {
      for (const table of ["platform_mrr_snapshots", "platform_mrr_daily"]) {
        const { data, error } = await c.from(table as never).select("*").limit(1);
        expect(error !== null || (data ?? []).length === 0).toBe(true);
      }
    }
  });

  it("el cron y la foto del día no se llaman desde la API", async () => {
    for (const fn of ["platform_mrr_snapshot_run", "platform_mrr_state", "platform_mrr_snapshot_day"]) {
      const r = await rpc(ctx.superAdmin, fn, fn === "platform_mrr_snapshot_run" ? {} : { p_day: "2026-10-01" });
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
