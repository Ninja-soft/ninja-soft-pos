// @vitest-environment node
// =============================================================================
// F20-0a (H125): internal_saas_kpi_events (migración 20261111200000).
//   · Sólo el staff bajo internal_scope() la ejecuta; el dueño y el staff sin
//     el header de scope reciben forbidden.
//   · Devuelve el cambio de estado de una suscripción (desde audit_logs, no
//     desde updated_at) y no lista los UPDATE sin cambio de estado.
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
  tenant: string;
  userIds: string[];
  owner: SupabaseClient;
  staff: SupabaseClient;
  staffPlain: SupabaseClient;
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

async function makeUser(email: string, appMeta: Record<string, unknown>, tenantId?: string) {
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (tenantId) {
    await ctx.admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role: "owner", status: "active" });
  }
  ctx.userIds.push(id);
  return id;
}

describe.skipIf(!enabled)("F20-0a · internal_saas_kpi_events", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];
    const { data: t, error } = await ctx.admin
      .from("tenants")
      .insert({ name: `KPI ${STAMP}`, slug: STAMP, status: "active", industry: "kiosco" })
      .select("id")
      .single();
    if (error) throw error;
    ctx.tenant = (t as { id: string }).id;
    const { data: plan } = await ctx.admin.from("plans").select("id").eq("key", "start").is("tenant_id", null).single();
    await ctx.admin
      .from("subscriptions")
      .insert({ tenant_id: ctx.tenant, plan_id: plan!.id, status: "active", billing_cycle: "monthly" });
    // Un UPDATE sin cambio de estado y uno con cambio.
    await ctx.admin.from("subscriptions").update({ cancel_at_period_end: true }).eq("tenant_id", ctx.tenant);
    await ctx.admin.from("subscriptions").update({ status: "cancelled" }).eq("tenant_id", ctx.tenant);

    await makeUser(`owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenant }, ctx.tenant);
    await makeUser(`staff-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.owner = await signIn(`owner-${STAMP}@test.local`, true);
    ctx.staff = await signIn(`staff-${STAMP}@test.local`, true);
    ctx.staffPlain = await signIn(`staff-${STAMP}@test.local`, false);
  }, 180_000);

  afterAll(async () => {
    const safe = async (p: PromiseLike<unknown>) => {
      try {
        await p;
      } catch {
        /* best effort (audit_logs inmutable) */
      }
    };
    if (!ctx.admin) return;
    await safe(ctx.admin.from("subscriptions").delete().eq("tenant_id", ctx.tenant));
    await safe(ctx.admin.from("tenant_users").delete().eq("tenant_id", ctx.tenant));
    await safe(ctx.admin.from("tenants").delete().eq("id", ctx.tenant));
    for (const id of ctx.userIds) {
      await safe(ctx.admin.from("users").delete().eq("id", id));
      await safe(ctx.admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  it("el dueño y el staff sin scope interno reciben forbidden", async () => {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    for (const c of [ctx.owner, ctx.staffPlain]) {
      const r = await rpc(c, "internal_saas_kpi_events", { p_since: since });
      expect(r.error?.message).toMatch(/forbidden/);
    }
  });

  it("el staff ve el cambio de estado y no los UPDATE sin cambio", async () => {
    const r = await rpc(ctx.staff, "internal_saas_kpi_events", {
      p_since: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(r.error).toBeNull();
    const changes = (r.data as { status_changes: { tenant_id: string; from: string; to: string }[] }).status_changes.filter(
      (c) => c.tenant_id === ctx.tenant,
    );
    expect(changes).toEqual([expect.objectContaining({ from: "active", to: "cancelled" })]);
  });
});
