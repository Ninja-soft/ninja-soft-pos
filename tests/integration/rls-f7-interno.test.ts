// @vitest-environment node
// =============================================================================
// F7 interno (ADR-084, migraciones 20261107100000 a 20261107100300):
//   · impersonation_sessions: sólo el staff bajo internal_scope() lee; canje de
//     un uso atado a la sesión de Auth; banner sólo en esa sesión; cierre.
//   · internal_tenant_members / internal_member_admin: permisos por nivel,
//     motivo, último dueño, suspender corta el acceso, auditoría.
//   · internal_tenant_360: agregados sólo para el staff interno.
//   · internal_notify_segment: un aviso por negocio del segmento, el negocio
//     fuera del segmento no lo ve, soporte no envía, lote borrable.
//   · rls_internal_scope_leaks() = 0.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea datos. audit_logs es
// inmutable (H118): el cleanup no la toca y tolera fallas.
// =============================================================================
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `f7i-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; email: string; client: SupabaseClient; plain: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  cashier: User;
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
): Promise<User> {
  const { admin } = ctx;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  if (internalLevel(appMeta)) await admin.from("users").update({ internal_level: internalLevel(appMeta) }).eq("id", id);
  if (membership) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
    if (tuErr) throw tuErr;
  }
  ctx.userIds.push(id);
  return { id, email, client: await signIn(email, true), plain: await signIn(email, false) };
}
function internalLevel(m: Record<string, unknown>): string | null {
  return typeof m.internal_level === "string" ? m.internal_level : null;
}

async function memberStatus(tenantId: string, userId: string) {
  const { data } = await ctx.admin
    .from("tenant_users")
    .select("role, status")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single();
  return data as { role: string; status: string };
}

// Abre un registro de impersonation como lo hace la Edge (service_role).
async function openImpersonation(target: User, minutes = 30) {
  const nonce = randomBytes(32).toString("hex");
  const { data, error } = await ctx.admin
    .from("impersonation_sessions")
    .insert({
      tenant_id: ctx.tenantA,
      staff_user_id: ctx.staffAdmin.id,
      target_user_id: target.id,
      reason: "soporte por ticket de prueba",
      duration_minutes: minutes,
      nonce_hash: createHash("sha256").update(nonce, "utf8").digest("hex"),
      expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id, nonce };
}

describe.skipIf(!enabled)("F7 interno · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];

    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `F7I A ${STAMP}`, slug: `f7ia-${STAMP}`, status: "active", industry: "kiosco" },
        { name: `F7I B ${STAMP}`, slug: `f7ib-${STAMP}`, status: "active", industry: "textil" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `f7ia-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `f7ib-${STAMP}`)!.id;

    const { data: plan } = await admin.from("plans").select("id").eq("key", "start").is("tenant_id", null).single();
    const { error: subErr } = await admin.from("subscriptions").insert([
      { tenant_id: ctx.tenantA, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
      { tenant_id: ctx.tenantB, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
    ]);
    if (subErr) throw subErr;

    ctx.owner = await makeUser(`owner-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    ctx.cashier = await makeUser(`cajero-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    ctx.ownerB = await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    ctx.staffAdmin = await makeUser(`staff-adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.staffSuper = await makeUser(`staff-sup-${STAMP}@test.local`, { is_internal: true, internal_level: "super_admin" });
    ctx.staffSupport = await makeUser(`staff-sop-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
  }, 180_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    const safe = async (p: PromiseLike<unknown>) => {
      try {
        await p;
      } catch {
        /* cleanup best effort (audit_logs inmutable) */
      }
    };
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await safe(admin.from("notifications").delete().eq("target_tenant_id", t));
      await safe(admin.from("impersonation_sessions").delete().eq("tenant_id", t));
      await safe(admin.from("subscriptions").delete().eq("tenant_id", t));
      await safe(admin.from("tenant_users").delete().eq("tenant_id", t));
      await safe(admin.from("tenants").delete().eq("id", t));
    }
    for (const id of ctx.userIds) {
      await safe(admin.from("users").delete().eq("id", id));
      await safe(admin.auth.admin.deleteUser(id));
    }
  }, 120_000);

  // ── Aislamiento ───────────────────────────────────────────────────────────
  it("un tenant común nunca ve lo interno, ni con el header de scope", async () => {
    await openImpersonation(ctx.owner);
    for (const c of [ctx.owner.client, ctx.owner.plain, ctx.cashier.client, ctx.ownerB.plain]) {
      const { data } = await c.from("impersonation_sessions" as never).select("id");
      expect(data ?? []).toHaveLength(0);
      for (const [fn, args] of [
        ["internal_tenant_members", { p_tenant: ctx.tenantA }],
        ["internal_tenant_360", { p_tenant: ctx.tenantA }],
        ["internal_segment_tenants", { p_segment: { plans: ["start"] } }],
      ] as const) {
        const r = await rpc(c, fn, args);
        expect(r.error?.message).toMatch(/forbidden/);
      }
    }
  });

  it("el staff sin el header de scope interno tampoco", async () => {
    const { data } = await ctx.staffAdmin.plain.from("impersonation_sessions" as never).select("id");
    expect(data ?? []).toHaveLength(0);
    const r = await rpc(ctx.staffAdmin.plain, "internal_tenant_360", { p_tenant: ctx.tenantA });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("el staff bajo internal_scope lee los accesos del negocio", async () => {
    const { data, error } = await ctx.staffSupport.client
      .from("impersonation_sessions" as never)
      .select("id, tenant_id")
      .eq("tenant_id", ctx.tenantA);
    expect(error).toBeNull();
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });

  it("nadie inserta accesos desde el cliente (ni el staff)", async () => {
    const row = {
      tenant_id: ctx.tenantA,
      staff_user_id: ctx.staffAdmin.id,
      target_user_id: ctx.owner.id,
      reason: "intento directo",
      duration_minutes: 30,
      nonce_hash: "b".repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const c of [ctx.staffSuper.client, ctx.owner.plain]) {
      const { error } = await c.from("impersonation_sessions" as never).insert(row as never);
      expect(error).not.toBeNull();
    }
  });

  // ── Impersonation ─────────────────────────────────────────────────────────
  it("canje de un uso: sólo la cuenta destino; el banner sólo en esa sesión; cierre", async () => {
    const { nonce } = await openImpersonation(ctx.owner);

    const wrong = await rpc(ctx.cashier.plain, "impersonation_claim", { p_nonce: nonce });
    expect(wrong.error?.message).toMatch(/invalid_link/);

    // Sesión "del staff" = una sesión nueva de la cuenta del dueño.
    const staffSession = await signIn(ctx.owner.email, false);
    const ok = await rpc(staffSession, "impersonation_claim", { p_nonce: nonce });
    expect(ok.error).toBeNull();

    const again = await rpc(staffSession, "impersonation_claim", { p_nonce: nonce });
    expect(again.error?.message).toMatch(/link_used/);

    const banner = await rpc(staffSession, "my_impersonation");
    expect((banner.data as { tenant_id: string } | null)?.tenant_id).toBe(ctx.tenantA);

    // El dueño real, con su propia sesión, no ve el banner.
    const own = await rpc(ctx.owner.plain, "my_impersonation");
    expect(own.data).toBeNull();

    const end = await rpc(staffSession, "impersonation_end");
    expect(end.error).toBeNull();
    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .in("action", ["impersonation_started", "impersonation_ended"]);
    expect((audit ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("un link vencido no se canjea y el cron lo cierra", async () => {
    const { id, nonce } = await openImpersonation(ctx.owner, 5);
    await ctx.admin
      .from("impersonation_sessions")
      .update({ expires_at: new Date(Date.now() + 1000).toISOString(), created_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", id);
    await new Promise((r) => setTimeout(r, 1500));
    const s = await signIn(ctx.owner.email, false);
    const r = await rpc(s, "impersonation_claim", { p_nonce: nonce });
    expect(r.error?.message).toMatch(/link_expired/);
    const n = await rpc(ctx.admin, "impersonation_expire_due");
    expect(n.error).toBeNull();
    const { data } = await ctx.admin.from("impersonation_sessions").select("end_reason").eq("id", id).single();
    expect((data as { end_reason: string }).end_reason).toBe("expired");
  });

  it("cerrar desde el panel: soporte no, admin sí", async () => {
    const { id } = await openImpersonation(ctx.owner);
    const sop = await rpc(ctx.staffSupport.client, "internal_impersonation_end", { p_id: id });
    expect(sop.error?.message).toMatch(/forbidden/);
    const adm = await rpc(ctx.staffAdmin.client, "internal_impersonation_end", { p_id: id });
    expect(adm.error).toBeNull();
    const { data } = await ctx.admin.from("impersonation_sessions").select("end_reason").eq("id", id).single();
    expect((data as { end_reason: string }).end_reason).toBe("revoked");
  });

  // ── Miembros ──────────────────────────────────────────────────────────────
  it("lista de miembros para cualquier nivel de staff", async () => {
    const r = await rpc(ctx.staffSupport.client, "internal_tenant_members", { p_tenant: ctx.tenantA });
    expect(r.error).toBeNull();
    const emails = (r.data as { email: string }[]).map((m) => m.email);
    expect(emails).toContain(ctx.owner.email);
    expect(emails).not.toContain(ctx.ownerB.email);
  });

  it("acciones sobre miembros: nivel, motivo, último dueño y auditoría", async () => {
    const base = { p_tenant: ctx.tenantA, p_user: ctx.cashier.id };
    const sop = await rpc(ctx.staffSupport.client, "internal_member_admin", { ...base, p_action: "suspend", p_reason: "prueba de soporte" });
    expect(sop.error?.message).toMatch(/forbidden/);
    const noReason = await rpc(ctx.staffAdmin.client, "internal_member_admin", { ...base, p_action: "suspend", p_reason: "x" });
    expect(noReason.error?.message).toMatch(/reason_required/);

    const sus = await rpc(ctx.staffAdmin.client, "internal_member_admin", { ...base, p_action: "suspend", p_reason: "pedido del dueño" });
    expect(sus.error).toBeNull();
    expect((await memberStatus(ctx.tenantA, ctx.cashier.id)).status).toBe("suspended");

    const re = await rpc(ctx.staffAdmin.client, "internal_member_admin", { ...base, p_action: "reactivate", p_reason: "pedido del dueño" });
    expect(re.error).toBeNull();
    expect((await memberStatus(ctx.tenantA, ctx.cashier.id)).status).toBe("active");

    const role = await rpc(ctx.staffAdmin.client, "internal_member_admin", { ...base, p_action: "set_role", p_role: "manager", p_reason: "ascenso pedido" });
    expect(role.error).toBeNull();
    expect((await memberStatus(ctx.tenantA, ctx.cashier.id)).role).toBe("manager");

    const toOwner = await rpc(ctx.staffAdmin.client, "internal_member_admin", { ...base, p_action: "set_role", p_role: "owner", p_reason: "cambio de dueño" });
    expect(toOwner.error?.message).toMatch(/forbidden_super_admin_only/);

    const lastOwner = await rpc(ctx.staffSuper.client, "internal_member_admin", {
      p_tenant: ctx.tenantA,
      p_user: ctx.owner.id,
      p_action: "set_role",
      p_role: "manager",
      p_reason: "dejar sin dueño",
    });
    expect(lastOwner.error?.message).toMatch(/last_owner/);

    const reset = await rpc(ctx.staffSupport.client, "internal_member_admin", { ...base, p_action: "reset_access", p_reason: "olvidó la clave" });
    expect(reset.error).toBeNull();

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action, reason, actor_user_id")
      .eq("tenant_id", ctx.tenantA)
      .eq("entity_id", ctx.cashier.id)
      .like("action", "member_%_internal");
    const actions = (audit ?? []).map((a) => (a as { action: string }).action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "member_suspended_internal",
        "member_reactivated_internal",
        "member_role_changed_internal",
        "member_access_reset_internal",
      ]),
    );
    expect((audit ?? []).every((a) => Boolean((a as { reason: string | null }).reason))).toBe(true);
  });

  it("el staff no se toca a sí mismo y no actúa sobre otro negocio por error", async () => {
    const self = await rpc(ctx.staffAdmin.client, "internal_member_admin", {
      p_tenant: ctx.tenantA,
      p_user: ctx.staffAdmin.id,
      p_action: "suspend",
      p_reason: "auto suspensión",
    });
    expect(self.error?.message).toMatch(/cannot_change_self/);
    const other = await rpc(ctx.staffAdmin.client, "internal_member_admin", {
      p_tenant: ctx.tenantB,
      p_user: ctx.cashier.id,
      p_action: "suspend",
      p_reason: "negocio equivocado",
    });
    expect(other.error?.message).toMatch(/member_not_found/);
  });

  // ── Ficha 360 ─────────────────────────────────────────────────────────────
  it("ficha 360 con agregados del negocio", async () => {
    const r = await rpc(ctx.staffSupport.client, "internal_tenant_360", { p_tenant: ctx.tenantA });
    expect(r.error).toBeNull();
    const d = r.data as { members: { total: number }; modules: unknown[]; errors: unknown[] };
    expect(d.members.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(d.modules)).toBe(true);
    expect(Array.isArray(d.errors)).toBe(true);
  });

  // ── Anuncios por segmento ─────────────────────────────────────────────────
  it("segmento: un aviso por negocio, el de fuera no lo ve, soporte no envía", async () => {
    const seg = { industries: ["kiosco"], created_from: new Date().toISOString().slice(0, 10) };
    const args = {
      p_segment: seg,
      p_role: null,
      p_type: "news",
      p_severity: "info",
      p_title: `Novedad ${STAMP}`,
      p_body: null,
      p_action_label: null,
      p_action_url: null,
      p_requires_ack: false,
      p_expires_at: null,
      p_display_until: null,
    };
    const sop = await rpc(ctx.staffSupport.client, "internal_notify_segment", args);
    expect(sop.error?.message).toMatch(/forbidden/);
    const empty = await rpc(ctx.staffAdmin.client, "internal_notify_segment", { ...args, p_segment: {} });
    expect(empty.error?.message).toMatch(/empty_segment/);

    const ok = await rpc(ctx.staffAdmin.client, "internal_notify_segment", args);
    expect(ok.error).toBeNull();
    const res = ok.data as { batch_id: string; sent: number };
    expect(res.sent).toBeGreaterThanOrEqual(1);

    const { data: rows } = await ctx.admin
      .from("notifications")
      .select("target_tenant_id")
      .eq("segment_batch_id", res.batch_id);
    const targets = (rows ?? []).map((r) => (r as { target_tenant_id: string }).target_tenant_id);
    expect(targets).toContain(ctx.tenantA);
    expect(targets).not.toContain(ctx.tenantB);

    const { data: seenA } = await ctx.owner.plain.from("notifications").select("id, title").eq("title", `Novedad ${STAMP}`);
    expect(seenA ?? []).toHaveLength(1);
    const { data: seenB } = await ctx.ownerB.plain.from("notifications").select("id").eq("title", `Novedad ${STAMP}`);
    expect(seenB ?? []).toHaveLength(0);

    const del = await rpc(ctx.staffAdmin.client, "internal_delete_notification_batch", { p_batch: res.batch_id });
    expect(del.error).toBeNull();
    const { data: afterDel } = await ctx.owner.plain.from("notifications").select("id").eq("title", `Novedad ${STAMP}`);
    expect(afterDel ?? []).toHaveLength(0);
  });

  it("rls_internal_scope_leaks() sigue en 0", async () => {
    const { data: leaks, error } = await ctx.admin.rpc("rls_internal_scope_leaks" as never);
    expect(error).toBeNull();
    expect(leaks ?? []).toHaveLength(0);
  });
});
