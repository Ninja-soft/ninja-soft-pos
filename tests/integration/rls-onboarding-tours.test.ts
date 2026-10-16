// @vitest-environment node
// =============================================================================
// Recorridos guiados, sugerencias y cuentas trabadas (F15 · H70, H71, H74 ·
// ADR-089). Migraciones 20261108300000 a 20261108300400.
//
//  * La configuración (tours, versiones, sugerencias, límites, asignaciones)
//    no la lee ni la escribe un negocio, ni forjando el header del panel.
//  * tours_for_me respeta audiencia (rubro, rol) y asignaciones correctivas.
//  * Métricas: insert multi-fila con todas las claves, aisladas por usuario y
//    negocio; el servidor completa el id del paso y rechaza pasos inválidos.
//  * nudge_next: prioridad, cooldown, límite por sesión y por día, venta
//    fallida; `shown` no se carga desde el cliente.
//  * Staff: guardar, publicar con versión, auditar; soporte no edita pero
//    dispara correctivos; métricas y activación sólo con internal_scope().
//  * Guardarraíles rls_internal_scope_leaks y rls_bare_current_tenant_policies.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// audit_logs es inmutable (ADR-083): las filas de auditoría quedan.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `obt-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient; scoped: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  ownerA: User;
  cashierA: User;
  ownerB: User;
  staffAdmin: User;
  staffSupport: User;
  userIds: string[];
  tourKey: string;
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;
const from = (c: SupabaseClient, t: string) => c.from(t as never);

async function signIn(email: string, scoped: boolean): Promise<SupabaseClient> {
  const client = createClient(URL_!, ANON!, {
    auth: { persistSession: false },
    ...(scoped ? { global: { headers: { "x-ninja-scope": "internal" } } } : {}),
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
  if (typeof appMeta.internal_level === "string") {
    await admin.from("users").update({ internal_level: appMeta.internal_level } as never).eq("id", id);
  }
  if (membership) {
    const { error: tuErr } = await admin
      .from("tenant_users")
      .insert({ tenant_id: membership.tenantId, user_id: id, role: membership.role, status: "active" });
    if (tuErr) throw tuErr;
  }
  ctx.userIds.push(id);
  return { id, client: await signIn(email, false), scoped: await signIn(email, true) };
}

type TourOut = { tour_id: string; key: string; version: number; assigned: boolean; steps: unknown[] };

async function seededTourId(key: string): Promise<string> {
  const { data } = await from(ctx.admin, "onboarding_tours").select("id").eq("key", key).single();
  return (data as unknown as { id: string }).id;
}

describe.skipIf(!enabled)("recorridos y sugerencias · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    ctx.tourKey = `prueba-${STAMP}`;

    // Insert multi-fila: todas las claves en cada fila (PostgREST).
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `OBT A ${STAMP}`, slug: `obta-${STAMP}`, status: "active", industry: "heladeria" },
        { name: `OBT B ${STAMP}`, slug: `obtb-${STAMP}`, status: "active", industry: "kiosco" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `obta-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `obtb-${STAMP}`)!.id;

    const { data: plan } = await admin.from("plans").select("id").eq("key", "start").is("tenant_id", null).single();
    const { error: subErr } = await admin.from("subscriptions").insert([
      { tenant_id: ctx.tenantA, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
      { tenant_id: ctx.tenantB, plan_id: plan!.id, status: "active", billing_cycle: "monthly" },
    ]);
    if (subErr) throw subErr;

    ctx.ownerA = await makeUser(`owner-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "owner" });
    ctx.cashierA = await makeUser(`caj-a-${STAMP}@test.local`, { current_tenant_id: ctx.tenantA }, { tenantId: ctx.tenantA, role: "cashier" });
    ctx.ownerB = await makeUser(`owner-b-${STAMP}@test.local`, { current_tenant_id: ctx.tenantB }, { tenantId: ctx.tenantB, role: "owner" });
    ctx.staffAdmin = await makeUser(`staff-adm-${STAMP}@test.local`, { is_internal: true, internal_level: "admin" });
    ctx.staffSupport = await makeUser(`staff-sop-${STAMP}@test.local`, { is_internal: true, internal_level: "support" });
  }, 90_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await from(admin, "onboarding_tour_events").delete().eq("tenant_id", t);
      await from(admin, "onboarding_nudge_events").delete().eq("tenant_id", t);
      await from(admin, "onboarding_assignments").delete().eq("tenant_id", t);
      await admin.from("subscriptions").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    if (ctx.tourKey) await from(admin, "onboarding_tours").delete().eq("key", ctx.tourKey);
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 90_000);

  // ── Configuración interna ───────────────────────────────────────────────

  it("un negocio no lee la configuración, ni forjando el header del panel", async () => {
    for (const c of [ctx.ownerA.client, ctx.ownerA.scoped]) {
      for (const t of [
        "onboarding_tours",
        "onboarding_tour_versions",
        "onboarding_nudges",
        "onboarding_nudge_settings",
        "onboarding_assignments",
      ]) {
        const { data } = await from(c, t).select("*");
        expect(data ?? []).toHaveLength(0);
      }
    }
  });

  it("un negocio no escribe la configuración ni llama las RPC internas", async () => {
    const { error: insErr } = await from(ctx.ownerA.client, "onboarding_tours").insert({
      key: `x-${STAMP}`,
      title: "Intruso",
      steps: [{ id: "a", title: "Paso", placement: "modal" }],
    } as never);
    expect(insErr).not.toBeNull();
    const save = await rpc(ctx.ownerA.client, "internal_tour_save", {
      p_id: null,
      p_key: `x-${STAMP}`,
      p_title: "Intruso",
      p_description: null,
      p_trigger: "manual",
      p_audience: {},
      p_priority: 1,
      p_steps: [{ id: "a", title: "Paso", placement: "modal" }],
    });
    expect(save.error?.message).toMatch(/forbidden/);
    for (const fn of ["internal_activation_overview", "internal_nudge_metrics"]) {
      expect((await rpc(ctx.ownerA.scoped, fn)).error?.message).toMatch(/forbidden/);
    }
  });

  it("el staff con el panel lee los recorridos sembrados; sin el header, no", async () => {
    const { data } = await from(ctx.staffAdmin.scoped, "onboarding_tours").select("key, status, published_version");
    const keys = ((data ?? []) as unknown as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["primer-cobro", "heladeria-favoritos-sabores"]));
    const { data: plain } = await from(ctx.staffAdmin.client, "onboarding_tours").select("key");
    expect(plain ?? []).toHaveLength(0);
  });

  // ── Audiencia ──────────────────────────────────────────────────────────

  it("tours_for_me: la heladería ve su recorrido y el de primer cobro; el kiosco sólo primer cobro; el cajero ninguno", async () => {
    const a = (await rpc(ctx.ownerA.client, "tours_for_me")).data as TourOut[];
    expect(a.map((t) => t.key)).toEqual(["heladeria-favoritos-sabores", "primer-cobro"]);
    const b = (await rpc(ctx.ownerB.client, "tours_for_me")).data as TourOut[];
    expect(b.map((t) => t.key)).toEqual(["primer-cobro"]);
    const caj = (await rpc(ctx.cashierA.client, "tours_for_me")).data as TourOut[];
    expect(caj).toEqual([]);
  });

  // ── Métricas aisladas ──────────────────────────────────────────────────

  it("el dueño carga eventos multi-fila; el servidor pone el id del paso", async () => {
    const tourId = await seededTourId("primer-cobro");
    const run = randomUUID();
    const base = { tenant_id: ctx.tenantA, user_id: ctx.ownerA.id, tour_id: tourId, tour_version: 1, run_id: run, route: "/pos" };
    const { error } = await from(ctx.ownerA.client, "onboarding_tour_events").insert([
      { ...base, event: "start", step_index: null, step_id: null },
      { ...base, event: "step_view", step_index: 0, step_id: "inventado" },
      { ...base, event: "step_view", step_index: 1, step_id: null },
    ] as never);
    expect(error).toBeNull();
    const { data } = await from(ctx.ownerA.client, "onboarding_tour_events")
      .select("event, step_index, step_id")
      .eq("run_id", run)
      .order("step_index", { ascending: true, nullsFirst: true });
    const rows = data as unknown as { event: string; step_index: number | null; step_id: string | null }[];
    expect(rows.map((r) => r.step_id)).toEqual([null, "bienvenida", "productos"]);
  });

  it("rechaza un paso fuera del recorrido y una versión que no existe", async () => {
    const tourId = await seededTourId("primer-cobro");
    const base = { tenant_id: ctx.tenantA, user_id: ctx.ownerA.id, tour_id: tourId, run_id: randomUUID(), route: "/pos" };
    const bad = await from(ctx.ownerA.client, "onboarding_tour_events").insert({ ...base, tour_version: 1, event: "step_view", step_index: 19 } as never);
    expect(bad.error?.message).toMatch(/invalid_step/);
    const ver = await from(ctx.ownerA.client, "onboarding_tour_events").insert({ ...base, tour_version: 99, event: "start" } as never);
    expect(ver.error?.message).toMatch(/tour_version_not_found/);
  });

  it("nadie carga eventos a nombre de otro negocio u otro usuario", async () => {
    const tourId = await seededTourId("primer-cobro");
    const row = { tour_id: tourId, tour_version: 1, run_id: randomUUID(), event: "start" };
    const other = await from(ctx.ownerB.client, "onboarding_tour_events").insert({ ...row, tenant_id: ctx.tenantA, user_id: ctx.ownerB.id } as never);
    expect(other.error).not.toBeNull();
    const imp = await from(ctx.cashierA.client, "onboarding_tour_events").insert({ ...row, tenant_id: ctx.tenantA, user_id: ctx.ownerA.id } as never);
    expect(imp.error).not.toBeNull();
  });

  it("cada uno ve sólo sus eventos: ni el cajero del mismo negocio ni otro negocio", async () => {
    for (const u of [ctx.cashierA, ctx.ownerB]) {
      const { data } = await from(u.client, "onboarding_tour_events").select("id").eq("tenant_id", ctx.tenantA);
      expect(data ?? []).toHaveLength(0);
    }
    const { error } = await from(ctx.ownerA.client, "onboarding_tour_events").delete().eq("tenant_id", ctx.tenantA);
    const { data: still } = await from(ctx.ownerA.client, "onboarding_tour_events").select("id");
    expect(error !== null || (still ?? []).length > 0).toBe(true);
  });

  // ── Sugerencias ────────────────────────────────────────────────────────

  it("`shown` no se carga desde el cliente", async () => {
    const { data: n } = await from(ctx.admin, "onboarding_nudges").select("id").eq("key", "sin-productos").single();
    const { error } = await from(ctx.ownerA.client, "onboarding_nudge_events").insert({
      tenant_id: ctx.tenantA,
      user_id: ctx.ownerA.id,
      nudge_id: (n as unknown as { id: string }).id,
      nudge_version: 1,
      event: "shown",
      session_id: "sesion-falsa-1",
    } as never);
    expect(error?.message).toMatch(/shown_is_server_side/);
  });

  it("nudge_next: prioridad, límite por sesión, cooldown y tope diario", async () => {
    const s1 = `ses-${STAMP}-1`;
    const first = (await rpc(ctx.ownerA.client, "nudge_next", { p_event: null, p_session: s1, p_route: "/dashboard" })).data as { key: string } | null;
    expect(first?.key).toBe("sin-productos");
    const again = await rpc(ctx.ownerA.client, "nudge_next", { p_event: null, p_session: s1, p_route: "/pos" });
    expect(again.data).toBeNull();
    const second = (await rpc(ctx.ownerA.client, "nudge_next", { p_event: null, p_session: `ses-${STAMP}-2`, p_route: "/pos" })).data as { key: string } | null;
    expect(second?.key).toBe("sin-primera-venta");
    const third = (await rpc(ctx.ownerA.client, "nudge_next", { p_event: null, p_session: `ses-${STAMP}-3`, p_route: "/pos" })).data as { key: string } | null;
    expect(third?.key).toBe("caja-cerrada");
    const capped = await rpc(ctx.ownerA.client, "nudge_next", { p_event: null, p_session: `ses-${STAMP}-4`, p_route: "/pos" });
    expect(capped.data).toBeNull();
  });

  it("venta fallida le llega al cajero con ayuda de soporte", async () => {
    const r = (await rpc(ctx.cashierA.client, "nudge_next", { p_event: "venta_fallida", p_session: `ses-${STAMP}-c`, p_route: "/pos" })).data as {
      key: string;
      support_fallback: boolean;
    } | null;
    expect(r?.key).toBe("venta-fallida");
    expect(r?.support_fallback).toBe(true);
    // Las impresiones del dueño no las ve el cajero.
    const { data } = await from(ctx.cashierA.client, "onboarding_nudge_events").select("user_id");
    expect(((data ?? []) as unknown as { user_id: string }[]).every((x) => x.user_id === ctx.cashierA.id)).toBe(true);
  });

  // ── Staff ──────────────────────────────────────────────────────────────

  it("soporte no edita recorridos", async () => {
    const r = await rpc(ctx.staffSupport.scoped, "internal_tour_save", {
      p_id: null,
      p_key: ctx.tourKey,
      p_title: "Prueba",
      p_description: null,
      p_trigger: "manual",
      p_audience: {},
      p_priority: 10,
      p_steps: [{ id: "uno", title: "Uno", placement: "modal" }],
    });
    expect(r.error?.message).toMatch(/forbidden/);
  });

  it("admin guarda, publica con versión, no republica sin cambios y audita", async () => {
    const steps = [{ id: "uno", title: "Uno", placement: "modal" }];
    const saved = await rpc(ctx.staffAdmin.scoped, "internal_tour_save", {
      p_id: null,
      p_key: ctx.tourKey,
      p_title: "Prueba",
      p_description: null,
      p_trigger: "manual",
      p_audience: { industries: ["kiosco"] },
      p_priority: 10,
      p_steps: steps,
    });
    expect(saved.error).toBeNull();
    const id = saved.data as string;
    const bad = await rpc(ctx.staffAdmin.scoped, "internal_tour_save", {
      p_id: id,
      p_key: ctx.tourKey,
      p_title: "Prueba",
      p_description: null,
      p_trigger: "manual",
      p_audience: {},
      p_priority: 10,
      p_steps: [{ id: "uno", title: "Uno", placement: "tooltip" }],
    });
    expect(bad.error?.message).toMatch(/invalid_steps/);

    expect((await rpc(ctx.staffAdmin.scoped, "internal_tour_publish", { p_id: id })).data).toBe(1);
    expect((await rpc(ctx.staffAdmin.scoped, "internal_tour_publish", { p_id: id })).error?.message).toMatch(/nothing_to_publish/);
    await rpc(ctx.staffAdmin.scoped, "internal_tour_save", {
      p_id: id,
      p_key: ctx.tourKey,
      p_title: "Prueba 2",
      p_description: null,
      p_trigger: "manual",
      p_audience: { industries: ["kiosco"] },
      p_priority: 10,
      p_steps: steps,
    });
    expect((await rpc(ctx.staffAdmin.scoped, "internal_tour_publish", { p_id: id })).data).toBe(2);

    // El kiosco lo ve (audiencia), con la versión publicada.
    const b = (await rpc(ctx.ownerB.client, "tours_for_me")).data as TourOut[];
    expect(b.find((t) => t.key === ctx.tourKey)?.version).toBe(2);

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("entity_id", id)
      .in("action", ["onboarding_tour_created", "onboarding_tour_saved", "onboarding_tour_published"]);
    expect((audit ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("soporte dispara un correctivo; el negocio lo recibe y se consume al descartarlo", async () => {
    const tourId = await seededTourId("heladeria-favoritos-sabores");
    // Fuera de la audiencia del kiosco, pero asignado.
    const assigned = await rpc(ctx.staffSupport.scoped, "internal_onboarding_assign", {
      p_tenant: ctx.tenantB,
      p_kind: "tour",
      p_ref: tourId,
      p_reason: "Sin primera venta a 5 días",
      p_role: null,
      p_days: 7,
    });
    expect(assigned.error).toBeNull();
    const b = (await rpc(ctx.ownerB.client, "tours_for_me")).data as TourOut[];
    expect(b.find((t) => t.key === "heladeria-favoritos-sabores")?.assigned).toBe(true);

    const { error } = await from(ctx.ownerB.client, "onboarding_tour_events").insert([
      { tenant_id: ctx.tenantB, user_id: ctx.ownerB.id, tour_id: tourId, tour_version: 1, run_id: randomUUID(), event: "dismiss", step_index: 0, route: "/dashboard" },
    ] as never);
    expect(error).toBeNull();
    const after = (await rpc(ctx.ownerB.client, "tours_for_me")).data as TourOut[];
    expect(after.find((t) => t.key === "heladeria-favoritos-sabores")).toBeUndefined();

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("tenant_id, reason")
      .eq("entity_id", assigned.data as string)
      .eq("action", "onboarding_corrective_assigned");
    expect(audit).toEqual([{ tenant_id: ctx.tenantB, reason: "Sin primera venta a 5 días" }]);
  });

  it("métricas y activación para el staff", async () => {
    const tourId = await seededTourId("primer-cobro");
    const m = (await rpc(ctx.staffSupport.scoped, "internal_tour_metrics", { p_id: tourId })).data as {
      versions: { version: number; starts: number }[];
      steps: { step_index: number; views: number; abandoned: number }[];
    };
    expect(m.versions.find((v) => v.version === 1)?.starts).toBeGreaterThanOrEqual(1);
    expect(m.steps.find((s) => s.step_index === 1)?.abandoned).toBeGreaterThanOrEqual(1);

    const ov = (await rpc(ctx.staffSupport.scoped, "internal_activation_overview")).data as {
      tenant_id: string;
      signals: Record<string, unknown>;
      tours_started: number;
    }[];
    const rowA = ov.find((r) => r.tenant_id === ctx.tenantA)!;
    expect(rowA.signals.producto).toBe(false);
    expect(rowA.tours_started).toBeGreaterThanOrEqual(1);
  });

  it("onboarding_status y onboarding_activation_status mantienen sus claves", async () => {
    const s = (await rpc(ctx.ownerA.client, "onboarding_status")).data as Record<string, unknown>;
    // ADR-154 suma marca, email y pagos a la puesta en marcha.
    expect(Object.keys(s).sort()).toEqual(["email", "fiscal", "marca", "mp", "pagos", "producto", "ticket", "venta"]);
    const a = (await rpc(ctx.ownerA.client, "onboarding_activation_status")).data as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(expect.arrayContaining(["agenda", "arca", "caja", "equipo", "escuela", "mesas"]));
  });

  it("guardarraíles en 0", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies"]) {
      const { data, error } = await ctx.admin.rpc(fn as never);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});
