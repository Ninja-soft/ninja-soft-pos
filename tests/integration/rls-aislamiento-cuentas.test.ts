// @vitest-environment node
// =============================================================================
// Aislamiento entre cuentas (ADR-152, migración 20261220100000).
//
// Un usuario dueño de dos negocios ve, con cada negocio activo, sólo las
// notificaciones y los datos de ese negocio (más los avisos de plataforma,
// sin negocio). Una notificación personal siempre lleva negocio. El staff
// interno que además tiene su propio negocio, desde el panel del negocio (sin
// el header x-ninja-scope), no ve datos de los clientes: perfiles, estado de
// lectura de otros, notas internas, emails del sistema.
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

const STAMP = `iso-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";
const INTERNAL = { "x-ninja-scope": "internal" };

// Fechas en hora argentina (UTC-3, sin horario de verano): el vencimiento de
// los avisos es "mañana a las 23:59 en Argentina", como lo carga el composer.
function arDate(offsetDays = 0): string {
  const d = new Date(Date.now() - 3 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
const AR_TOMORROW_END = `${arDate(1)}T23:59:00-03:00`;

type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  tenantC: string;
  dualId: string;
  dualEmail: string;
  ownerCId: string;
  ownerCEmail: string;
  staffId: string;
  staffEmail: string;
  notif: Record<"a" | "b" | "personalA" | "personalB" | "platform" | "c", string>;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

async function signIn(email: string, headers?: Record<string, string>): Promise<SupabaseClient> {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(headers ? { global: { headers } } : {}),
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function makeUser(email: string, appMeta: Record<string, unknown>): Promise<string> {
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: appMeta,
  });
  if (error) throw error;
  const id = data.user!.id;
  await ctx.admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  ctx.userIds.push(id);
  return id;
}

async function member(tenantId: string, userId: string, role = "owner") {
  const { error } = await ctx.admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: userId, role, status: "active" });
  if (error) throw error;
}

/** Cambia el negocio activo del usuario y devuelve una sesión con el JWT nuevo. */
async function switchTenant(userId: string, email: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const { error } = await ctx.admin.auth.admin.updateUserById(userId, {
    app_metadata: { current_tenant_id: tenantId, ...extra },
  });
  if (error) throw error;
  return signIn(email);
}

async function visibleIds(c: SupabaseClient): Promise<string[]> {
  const { data, error } = await c.from("notifications").select("id").in("id", Object.values(ctx.notif));
  expect(error).toBeNull();
  return ((data ?? []) as { id: string }[]).map((r) => r.id).sort();
}

describe.skipIf(!enabled)("aislamiento entre cuentas · ADR-152", () => {
  beforeAll(async () => {
    ctx.admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.userIds = [];

    const { data: tenants, error } = await ctx.admin
      .from("tenants")
      .insert([
        { name: `Iso A ${STAMP}`, slug: `isoa-${STAMP}`, status: "active" },
        { name: `Iso B ${STAMP}`, slug: `isob-${STAMP}`, status: "active" },
        { name: `Iso C ${STAMP}`, slug: `isoc-${STAMP}`, status: "active" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `isoa-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `isob-${STAMP}`)!.id;
    ctx.tenantC = tenants.find((t) => t.slug === `isoc-${STAMP}`)!.id;

    // Dueño de A y de B, con A activo.
    ctx.dualEmail = `dual-${STAMP}@test.local`;
    ctx.dualId = await makeUser(ctx.dualEmail, { current_tenant_id: ctx.tenantA });
    await member(ctx.tenantA, ctx.dualId);
    await member(ctx.tenantB, ctx.dualId);

    // Cliente C (otro dueño).
    ctx.ownerCEmail = `owner-c-${STAMP}@test.local`;
    ctx.ownerCId = await makeUser(ctx.ownerCEmail, { current_tenant_id: ctx.tenantC });
    await member(ctx.tenantC, ctx.ownerCId);

    // Staff interno que además es dueño de su propio negocio (A).
    ctx.staffEmail = `staff-${STAMP}@test.local`;
    ctx.staffId = await makeUser(ctx.staffEmail, {
      is_internal: true,
      internal_level: "admin",
      current_tenant_id: ctx.tenantA,
    });
    await member(ctx.tenantA, ctx.staffId);

    const base = { type: "news", severity: "info", expires_at: AR_TOMORROW_END };
    const ins = async (row: Record<string, unknown>) => {
      const { data, error: e } = await ctx.admin.from("notifications").insert({ ...base, ...row }).select("id").single();
      if (e) throw e;
      return (data as { id: string }).id;
    };
    ctx.notif = {
      a: await ins({ target_tenant_id: ctx.tenantA, target_role: "owner", title: `A ${STAMP}` }),
      b: await ins({ target_tenant_id: ctx.tenantB, target_role: "owner", title: `B ${STAMP}` }),
      personalA: await ins({ target_tenant_id: ctx.tenantA, target_user_id: ctx.dualId, title: `Pers A ${STAMP}` }),
      personalB: await ins({ target_tenant_id: ctx.tenantB, target_user_id: ctx.dualId, title: `Pers B ${STAMP}` }),
      platform: await ins({ title: `Plataforma ${STAMP}` }),
      c: await ins({ target_tenant_id: ctx.tenantC, title: `C ${STAMP}` }),
    };

    // Lectura de C (estado de lectura de otro usuario) y datos internos de C.
    await ctx.admin.from("notification_reads").insert({
      notification_id: ctx.notif.c,
      user_id: ctx.ownerCId,
      read_at: `${arDate()}T10:00:00-03:00`,
    });
    await ctx.admin.from("tenant_notes").insert({ tenant_id: ctx.tenantC, author_user_id: ctx.staffId, body: `Nota ${STAMP}` });
    await ctx.admin.from("system_emails").insert({
      tenant_id: ctx.tenantC,
      recipient: ctx.ownerCEmail,
      subject: `Email ${STAMP}`,
      status: "sent",
    });
  }, 120_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    const ids = Object.values(ctx.notif ?? {});
    if (ids.length) {
      await admin.from("notification_reads").delete().in("notification_id", ids);
      await admin.from("notifications").delete().in("id", ids);
    }
    for (const t of [ctx.tenantA, ctx.tenantB, ctx.tenantC].filter(Boolean)) {
      // audit_logs es inmutable (ADR-083): sus filas de prueba quedan.
      await admin.from("system_emails").delete().eq("tenant_id", t);
      await admin.from("tenant_notes").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  it("con A activo ve sólo las de A, sus personales de A y las de plataforma", async () => {
    const c = await signIn(ctx.dualEmail);
    expect(await visibleIds(c)).toEqual([ctx.notif.a, ctx.notif.personalA, ctx.notif.platform].sort());
  });

  it("al cambiar a B ve las de B y ninguna de A (tampoco las personales de A)", async () => {
    const c = await switchTenant(ctx.dualId, ctx.dualEmail, ctx.tenantB);
    expect(await visibleIds(c)).toEqual([ctx.notif.b, ctx.notif.personalB, ctx.notif.platform].sort());
    // Vuelve a A para el resto.
    await switchTenant(ctx.dualId, ctx.dualEmail, ctx.tenantA);
  });

  it("los datos operativos tampoco se mezclan entre sus dos negocios", async () => {
    const { data: prods, error } = await ctx.admin
      .from("products")
      .insert([
        { tenant_id: ctx.tenantA, name: `Prod A ${STAMP}`, price: 100 },
        { tenant_id: ctx.tenantB, name: `Prod B ${STAMP}`, price: 200 },
      ])
      .select("id, tenant_id");
    expect(error).toBeNull();
    try {
      const c = await signIn(ctx.dualEmail);
      const { data } = await c.from("products").select("tenant_id").ilike("name", `%${STAMP}%`);
      expect(((data ?? []) as { tenant_id: string }[]).map((r) => r.tenant_id)).toEqual([ctx.tenantA]);
      // Escribir en B con A activo: la RLS lo rechaza.
      const { error: insErr } = await c.from("products").insert({ tenant_id: ctx.tenantB, name: `Forzado ${STAMP}`, price: 1 });
      expect(insErr).not.toBeNull();
    } finally {
      await ctx.admin.from("products").delete().in("id", ((prods ?? []) as { id: string }[]).map((p) => p.id));
    }
  });

  it("una notificación personal sin negocio se rechaza (constraint)", async () => {
    const { error } = await ctx.admin
      .from("notifications")
      .insert({ type: "news", severity: "info", title: `Suelta ${STAMP}`, target_user_id: ctx.dualId });
    expect(error?.code).toBe("23514");
  });

  it("internal_notify exige el alcance interno y negocio para una notificación personal", async () => {
    const panel = await signIn(ctx.staffEmail);
    const noScope = await rpc(panel, "internal_notify", {
      p_tenant_id: ctx.tenantC, p_role: null, p_user_id: null, p_type: "news", p_severity: "info", p_title: `x ${STAMP}`,
    });
    expect(noScope.error?.message).toMatch(/forbidden/);

    const internal = await signIn(ctx.staffEmail, INTERNAL);
    const sinNegocio = await rpc(internal, "internal_notify", {
      p_tenant_id: null, p_role: null, p_user_id: ctx.ownerCId, p_type: "news", p_severity: "info", p_title: `y ${STAMP}`,
    });
    expect(sinNegocio.error?.message).toMatch(/user_target_needs_tenant/);
  });

  describe("staff interno con negocio propio, desde el panel del negocio", () => {
    it("no ve perfiles de otros usuarios; en /internal sí", async () => {
      const panel = await signIn(ctx.staffEmail);
      const { data } = await panel.from("users").select("id").in("id", [ctx.staffId, ctx.ownerCId]);
      expect(((data ?? []) as { id: string }[]).map((r) => r.id)).toEqual([ctx.staffId]);

      const internal = await signIn(ctx.staffEmail, INTERNAL);
      const { data: all } = await internal.from("users").select("id").in("id", [ctx.staffId, ctx.ownerCId]);
      expect((all ?? []).length).toBe(2);
    });

    it("no ve el estado de lectura de otros usuarios ni notificaciones de clientes", async () => {
      const panel = await signIn(ctx.staffEmail);
      const { data: reads } = await panel.from("notification_reads").select("id").eq("notification_id", ctx.notif.c);
      expect(reads ?? []).toHaveLength(0);
      const ids = await visibleIds(panel);
      expect(ids).not.toContain(ctx.notif.c);
      expect(ids).not.toContain(ctx.notif.b);
    });

    it("no ve notas internas ni emails del sistema de los clientes; en /internal sí", async () => {
      const panel = await signIn(ctx.staffEmail);
      const notes = await panel.from("tenant_notes").select("id").eq("tenant_id", ctx.tenantC);
      const mails = await panel.from("system_emails").select("id").eq("tenant_id", ctx.tenantC);
      expect(notes.data ?? []).toHaveLength(0);
      expect(mails.data ?? []).toHaveLength(0);

      const internal = await signIn(ctx.staffEmail, INTERNAL);
      const notesI = await internal.from("tenant_notes").select("id").eq("tenant_id", ctx.tenantC);
      const mailsI = await internal.from("system_emails").select("id").eq("tenant_id", ctx.tenantC);
      expect(notesI.data ?? []).toHaveLength(1);
      expect(mailsI.data ?? []).toHaveLength(1);
    });

    it("no puede escribir notas internas sin el alcance interno", async () => {
      const panel = await signIn(ctx.staffEmail);
      const { error } = await panel
        .from("tenant_notes")
        .insert({ tenant_id: ctx.tenantC, author_user_id: ctx.staffId, body: `Desde el panel ${STAMP}` });
      expect(error).not.toBeNull();
    });
  });

  it("guards de RLS en 0 (ADR-052, ADR-083, ADR-152)", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await rpc(ctx.admin, fn);
      expect(error, fn).toBeNull();
      expect(data, fn).toEqual([]);
    }
  });
});
