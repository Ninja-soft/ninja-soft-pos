// @vitest-environment node
// =============================================================================
// ADR-113: agenda editable de la sincronización del catálogo.
//
// catalog_sync_config: sólo lectura para staff interno en el panel interno
// ((select internal_scope()), header x-ninja-scope); nadie escribe por REST.
// internal_catalog_sync_config_save e internal_catalog_sync_control: sólo
// staff interno en el panel interno de nivel admin o super_admin (soporte no,
// un negocio no), auditadas en audit_logs. Cancelar es baja lógica.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: cambia la agenda y crea datos.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `csconf${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const SCOPE = { "x-ninja-scope": "internal" };

type Ctx = {
  admin: SupabaseClient;
  tenant: string;
  owner: SupabaseClient;
  staffNoScope: SupabaseClient;
  staffAdmin: SupabaseClient;
  staffSupport: SupabaseClient;
  staffAdminId: string;
  userIds: string[];
  runs: string[];
  original: Record<string, unknown> | null;
};
const ctx = {} as Ctx;

async function makeUser(
  admin: SupabaseClient,
  email: string,
  tenantId: string | null,
  role: string | null,
  meta: Record<string, unknown> = {},
  headers?: Record<string, string>,
) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: tenantId ? { current_tenant_id: tenantId, ...meta } : meta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (tenantId && role) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
    if (tuErr) throw tuErr;
  }
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

type RpcRes = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcRes>;

const DAILY = { enabled: true, frequency: "daily", weekdays: [6], hour: 4, minute: 15, run_kind: "incremental", full_every: 3 };

describe.skipIf(!enabled)("ADR-113 · agenda de la sync del catálogo", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.runs = [];

    const { data: conf } = await admin.from("catalog_sync_config").select("*").maybeSingle();
    ctx.original = (conf as Record<string, unknown> | null) ?? null;

    const { data: t, error: tErr } = await admin
      .from("tenants")
      .insert({ name: `Conf ${STAMP}`, slug: `conf-${STAMP}`, status: "active" })
      .select("id")
      .single();
    if (tErr || !t) throw tErr ?? new Error("tenant");
    ctx.tenant = t.id as string;

    const owner = await makeUser(admin, `own-${STAMP}@test.local`, ctx.tenant, "owner");
    // Un dueño que además manda el header del panel interno: igual no es staff.
    const ownerScoped = await makeUser(admin, `own2-${STAMP}@test.local`, ctx.tenant, "owner", {}, SCOPE);
    const noScope = await makeUser(admin, `stn-${STAMP}@test.local`, null, null, { is_internal: true, internal_level: "admin" });
    const staffAdmin = await makeUser(
      admin,
      `sta-${STAMP}@test.local`,
      null,
      null,
      { is_internal: true, internal_level: "admin" },
      SCOPE,
    );
    const staffSupport = await makeUser(
      admin,
      `sts-${STAMP}@test.local`,
      null,
      null,
      { is_internal: true, internal_level: "support" },
      SCOPE,
    );
    ctx.owner = ownerScoped.client;
    ctx.staffNoScope = noScope.client;
    ctx.staffAdmin = staffAdmin.client;
    ctx.staffSupport = staffSupport.client;
    ctx.staffAdminId = staffAdmin.id;
    ctx.userIds.push(owner.id, ownerScoped.id, noScope.id, staffAdmin.id, staffSupport.id);

    // Sin corridas abiertas de otras suites (una sola abierta a la vez).
    await admin
      .from("catalog_sync_runs")
      .update({ status: "error", finished_at: new Date().toISOString() })
      .eq("status", "running");
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    if (ctx.original) {
      const restore = { ...ctx.original };
      delete restore.id;
      await admin.from("catalog_sync_config").update(restore).eq("id", true);
    }
    await admin.from("audit_logs").delete().eq("action", "catalog_sync_config_updated").in("actor_user_id", ctx.userIds);
    if (ctx.runs.length) {
      await admin.from("audit_logs").delete().in("entity_id", ctx.runs);
      await admin.from("catalog_sync_runs").delete().in("id", ctx.runs);
    }
    await admin.from("tenants").delete().eq("id", ctx.tenant);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 120_000);

  it("lectura: sólo staff interno en el panel interno", async () => {
    const internal = await ctx.staffAdmin.from("catalog_sync_config").select("frequency, hour");
    expect(internal.error).toBeNull();
    expect(internal.data?.length).toBe(1);

    const support = await ctx.staffSupport.from("catalog_sync_config").select("frequency");
    expect(support.data?.length).toBe(1);

    const outOfScope = await ctx.staffNoScope.from("catalog_sync_config").select("frequency");
    expect(outOfScope.data ?? []).toEqual([]);

    const owner = await ctx.owner.from("catalog_sync_config").select("frequency");
    expect(owner.data ?? []).toEqual([]);
  });

  it("nadie escribe la tabla por REST, ni el staff interno", async () => {
    const upd = await ctx.staffAdmin.from("catalog_sync_config").update({ enabled: false }).eq("id", true).select("id");
    expect(upd.data ?? []).toEqual([]);
    const ins = await ctx.owner.from("catalog_sync_config").insert({ id: true }).select("id");
    expect(ins.error).not.toBeNull();
  });

  it("guardar: admin del panel interno sí (auditado); soporte, fuera del panel y un negocio no", async () => {
    for (const c of [ctx.staffSupport, ctx.staffNoScope, ctx.owner]) {
      const res = await rpc(c, "internal_catalog_sync_config_save", { p_config: DAILY });
      expect(res.error).not.toBeNull();
    }
    const { data: still } = await ctx.admin.from("catalog_sync_config").select("hour, minute").single();
    expect(still).not.toMatchObject({ hour: 4, minute: 15 });

    const ok = await rpc(ctx.staffAdmin, "internal_catalog_sync_config_save", { p_config: DAILY });
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ frequency: "daily", hour: 4, minute: 15, full_every: 3, updated_by: ctx.staffAdminId });

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("after_data")
      .eq("action", "catalog_sync_config_updated")
      .eq("actor_user_id", ctx.staffAdminId);
    expect(audit?.length).toBe(1);
    expect((audit?.[0]?.after_data as { hour?: number })?.hour).toBe(4);
  });

  it("guardar valida hora, días y cron", async () => {
    const bad = [
      { ...DAILY, hour: 24 },
      { ...DAILY, frequency: "weekly", weekdays: [] },
      { ...DAILY, frequency: "cron", cron_expr: "0 6 * *" },
      { ...DAILY, frequency: "interval", interval_days: 0 },
    ];
    for (const p_config of bad) {
      const res = await rpc(ctx.staffAdmin, "internal_catalog_sync_config_save", { p_config });
      expect(res.error, JSON.stringify(p_config)).not.toBeNull();
    }
  });

  it("pausar, reanudar y cancelar: sólo admin del panel interno; cancelar no borra", async () => {
    const enq = await rpc(ctx.admin, "catalog_sync_enqueue", { p_trigger: "cron" });
    expect(enq.error).toBeNull();
    const runId = enq.data as string;
    ctx.runs.push(runId);

    for (const c of [ctx.staffSupport, ctx.staffNoScope, ctx.owner]) {
      const res = await rpc(c, "internal_catalog_sync_control", { p_run: runId, p_action: "cancel" });
      expect(res.error).not.toBeNull();
    }

    const pause = await rpc(ctx.staffAdmin, "internal_catalog_sync_control", { p_run: runId, p_action: "pause" });
    expect(pause.error).toBeNull();
    const due = await rpc(ctx.admin, "catalog_sync_any_due");
    expect(due.data).toBe(false);

    const resume = await rpc(ctx.staffAdmin, "internal_catalog_sync_control", { p_run: runId, p_action: "resume" });
    expect(resume.error).toBeNull();

    const cancel = await rpc(ctx.staffAdmin, "internal_catalog_sync_control", { p_run: runId, p_action: "cancel" });
    expect(cancel.error).toBeNull();
    expect(cancel.data).toMatchObject({ status: "cancelled" });

    // Baja lógica: la corrida sigue y una escritura de la Edge no la revive.
    await ctx.admin.from("catalog_sync_runs").update({ status: "ok" }).eq("id", runId);
    const { data: run } = await ctx.admin.from("catalog_sync_runs").select("status").eq("id", runId).single();
    expect(run?.status).toBe("cancelled");

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("entity_id", runId)
      .eq("actor_user_id", ctx.staffAdminId);
    expect((audit ?? []).map((a) => a.action).sort()).toEqual([
      "catalog_sync_cancelled",
      "catalog_sync_paused",
      "catalog_sync_resumed",
    ]);
  });

  it("las funciones de la agenda son sólo de service_role", async () => {
    for (const c of [ctx.staffAdmin, ctx.owner]) {
      expect((await rpc(c, "catalog_sync_tick")).error).not.toBeNull();
      expect((await rpc(c, "catalog_sync_due")).error).not.toBeNull();
    }
  });
});
