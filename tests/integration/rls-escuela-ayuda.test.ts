// @vitest-environment node
// =============================================================================
// Ayuda contextual y Escuela (F15 · H69, H71, H72 · ADR-086). Migraciones
// 20261108100000_ayuda_feedback, 20261108100100_escuela y
// 20261108100200_onboarding_activacion_rubro.
//
//  * help_article_feedback: cada usuario ve y escribe sólo sus votos en su
//    negocio; el rol lo pone el servidor; sin delete.
//  * school_progress: aislado por usuario y negocio (dueño y encargado ven a su
//    equipo); sin escritura directa; la prueba exige las lecciones, puntúa en
//    el servidor, certifica una vez y audita.
//  * onboarding_activation_status: señales del negocio propio.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción: crea y borra datos.
// audit_logs es inmutable (ADR-083): las filas de auditoría quedan en la base.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { COURSES } from "@/lib/school/courses";

const URL_ = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && ANON && SERVICE);

const STAMP = `esc-test-${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "Rls-test-1234!";

type User = { id: string; client: SupabaseClient };
type Ctx = {
  admin: SupabaseClient;
  tenantA: string;
  tenantB: string;
  owner: User;
  cashier1: User;
  cashier2: User;
  ownerB: User;
  userIds: string[];
};
const ctx = {} as Ctx;

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (c: SupabaseClient, fn: string, args: Record<string, unknown> = {}) =>
  c.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;
const from = (c: SupabaseClient, t: string) => c.from(t as never);

const POS = COURSES.find((c) => c.key === "pos-basico")!;
const RIGHT = Object.fromEntries(POS.quiz.map((q) => [q.id, q.answer]));
const WRONG = Object.fromEntries(POS.quiz.map((q) => [q.id, (q.answer + 1) % q.options.length]));

async function makeUser(admin: SupabaseClient, email: string, tenantId: string, role: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { current_tenant_id: tenantId },
  });
  if (error) throw error;
  const id = data.user!.id;
  await admin.from("users").upsert({ id, email, full_name: email.split("@")[0] });
  const { error: tuErr } = await admin.from("tenant_users").insert({ tenant_id: tenantId, user_id: id, role, status: "active" });
  if (tuErr) throw tuErr;
  const client = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw sErr;
  return { id, client };
}

describe.skipIf(!enabled)("ayuda y escuela · RLS y RPC", () => {
  beforeAll(async () => {
    const admin = createClient(URL_!, SERVICE!, { auth: { persistSession: false } });
    ctx.admin = admin;
    ctx.userIds = [];
    // Insert multi-fila: todas las claves en cada fila (PostgREST).
    const { data: tenants, error } = await admin
      .from("tenants")
      .insert([
        { name: `Esc A ${STAMP}`, slug: `esca-${STAMP}`, status: "active", industry: "otro" },
        { name: `Esc B ${STAMP}`, slug: `escb-${STAMP}`, status: "active", industry: "otro" },
      ])
      .select("id, slug");
    if (error || !tenants) throw error ?? new Error("tenants");
    ctx.tenantA = tenants.find((t) => t.slug === `esca-${STAMP}`)!.id;
    ctx.tenantB = tenants.find((t) => t.slug === `escb-${STAMP}`)!.id;

    ctx.owner = await makeUser(admin, `owner-${STAMP}@test.local`, ctx.tenantA, "owner");
    ctx.cashier1 = await makeUser(admin, `caj1-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.cashier2 = await makeUser(admin, `caj2-${STAMP}@test.local`, ctx.tenantA, "cashier");
    ctx.ownerB = await makeUser(admin, `owner-b-${STAMP}@test.local`, ctx.tenantB, "owner");
    ctx.userIds.push(ctx.owner.id, ctx.cashier1.id, ctx.cashier2.id, ctx.ownerB.id);
  }, 60_000);

  afterAll(async () => {
    const { admin } = ctx;
    if (!admin) return;
    for (const t of [ctx.tenantA, ctx.tenantB].filter(Boolean)) {
      await from(admin, "help_article_feedback").delete().eq("tenant_id", t);
      await from(admin, "school_progress").delete().eq("tenant_id", t);
      await admin.from("tenant_users").delete().eq("tenant_id", t);
      await admin.from("tenants").delete().eq("id", t);
    }
    for (const id of ctx.userIds) {
      await admin.from("users").delete().eq("id", id);
      await admin.auth.admin.deleteUser(id);
    }
  }, 60_000);

  // ── Feedback de la ayuda ──────────────────────────────────────────────────

  it("el cajero vota varios artículos de una (multi-fila) y el rol lo pone el servidor", async () => {
    const { error } = await from(ctx.cashier1.client, "help_article_feedback").insert([
      { tenant_id: ctx.tenantA, user_id: ctx.cashier1.id, article_id: "pos-anular-venta", article_version: 1, helpful: true, route: "/pos", role: "owner" },
      { tenant_id: ctx.tenantA, user_id: ctx.cashier1.id, article_id: "caja-cerrar", article_version: 1, helpful: false, route: "/pos", role: "owner" },
    ] as never);
    expect(error).toBeNull();
    const { data } = await from(ctx.admin, "help_article_feedback")
      .select("article_id, role")
      .eq("user_id", ctx.cashier1.id);
    const rows = data as unknown as { article_id: string; role: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === "cashier")).toBe(true);
  });

  it("cambia su voto con upsert", async () => {
    const { error } = await from(ctx.cashier1.client, "help_article_feedback").upsert(
      { tenant_id: ctx.tenantA, user_id: ctx.cashier1.id, article_id: "caja-cerrar", article_version: 2, helpful: true, route: "/caja" } as never,
      { onConflict: "tenant_id,user_id,article_id" },
    );
    expect(error).toBeNull();
    const { data } = await from(ctx.cashier1.client, "help_article_feedback")
      .select("helpful, article_version")
      .eq("article_id", "caja-cerrar")
      .maybeSingle();
    expect(data).toEqual({ helpful: true, article_version: 2 });
  });

  it("cada uno ve sólo sus votos: ni el compañero, ni el dueño, ni otro negocio", async () => {
    for (const u of [ctx.cashier2, ctx.owner, ctx.ownerB]) {
      const { data } = await from(u.client, "help_article_feedback").select("id").eq("user_id", ctx.cashier1.id);
      expect((data as unknown[] | null) ?? []).toHaveLength(0);
    }
    const { data } = await from(ctx.cashier1.client, "help_article_feedback").select("id");
    expect((data as unknown[]).length).toBe(2);
  });

  it("no puede votar por otro usuario ni en otro negocio (multi-fila)", async () => {
    const asOther = await from(ctx.cashier1.client, "help_article_feedback").insert([
      { tenant_id: ctx.tenantA, user_id: ctx.cashier2.id, article_id: "reportes", article_version: 1, helpful: true, route: null, role: null },
      { tenant_id: ctx.tenantA, user_id: ctx.cashier2.id, article_id: "clientes-alta", article_version: 1, helpful: true, route: null, role: null },
    ] as never);
    expect(asOther.error).not.toBeNull();
    const otherTenant = await from(ctx.cashier1.client, "help_article_feedback").insert([
      { tenant_id: ctx.tenantB, user_id: ctx.cashier1.id, article_id: "reportes", article_version: 1, helpful: true, route: null, role: null },
      { tenant_id: ctx.tenantB, user_id: ctx.cashier1.id, article_id: "clientes-alta", article_version: 1, helpful: true, route: null, role: null },
    ] as never);
    expect(otherTenant.error).not.toBeNull();
  });

  it("no se borra ni se cambia de dueño un voto", async () => {
    await from(ctx.cashier1.client, "help_article_feedback").delete().eq("user_id", ctx.cashier1.id);
    const { data } = await from(ctx.admin, "help_article_feedback").select("id").eq("user_id", ctx.cashier1.id);
    expect((data as unknown[]).length).toBe(2);
    const moved = await from(ctx.cashier1.client, "help_article_feedback")
      .update({ article_id: "reportes" } as never)
      .eq("article_id", "caja-cerrar");
    expect(moved.error).not.toBeNull();
  });

  // ── Escuela ───────────────────────────────────────────────────────────────

  it("el catálogo con respuestas no se lee por PostgREST", async () => {
    const { data, error } = await from(ctx.cashier1.client, "school_courses").select("key, quiz");
    expect(error !== null || ((data as unknown[] | null) ?? []).length === 0).toBe(true);
  });

  it("nadie se aprueba a mano: sin insert ni update directos (multi-fila)", async () => {
    const ins = await from(ctx.cashier1.client, "school_progress").insert([
      { tenant_id: ctx.tenantA, user_id: ctx.cashier1.id, course_key: "pos-basico", course_version: 1, lessons_done: POS.lessons, passed_at: new Date().toISOString(), certificate_code: "TRUCHO1" },
      { tenant_id: ctx.tenantA, user_id: ctx.cashier1.id, course_key: "caja-y-arqueo", course_version: 1, lessons_done: [], passed_at: new Date().toISOString(), certificate_code: "TRUCHO2" },
    ] as never);
    expect(ins.error).not.toBeNull();
  });

  it("lección inválida, curso inválido y prueba sin lecciones", async () => {
    expect((await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "pos-basico", p_lesson: "reportes" })).error?.message).toMatch(/invalid_lesson/);
    expect((await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "no-existe", p_lesson: "x" })).error?.message).toMatch(/invalid_course/);
    expect((await rpc(ctx.cashier1.client, "school_submit_quiz", { p_course: "pos-basico", p_answers: RIGHT })).error?.message).toMatch(/lessons_pending/);
  });

  it("marca lecciones (idempotente, en el orden del curso) y desmarca", async () => {
    for (const l of [...POS.lessons].reverse()) {
      const r = await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "pos-basico", p_lesson: l, p_done: true });
      expect(r.error).toBeNull();
    }
    const again = await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "pos-basico", p_lesson: POS.lessons[0], p_done: true });
    expect((again.data as { lessons_done: string[] }).lessons_done).toEqual(POS.lessons);
    const off = await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "pos-basico", p_lesson: POS.lessons[0], p_done: false });
    expect((off.data as { lessons_done: string[] }).lessons_done).toEqual(POS.lessons.slice(1));
    expect((await rpc(ctx.cashier1.client, "school_submit_quiz", { p_course: "pos-basico", p_answers: RIGHT })).error?.message).toMatch(/lessons_pending/);
    await rpc(ctx.cashier1.client, "school_mark_lesson", { p_course: "pos-basico", p_lesson: POS.lessons[0], p_done: true });
  });

  it("la prueba desaprobada no certifica", async () => {
    const r = await rpc(ctx.cashier1.client, "school_submit_quiz", { p_course: "pos-basico", p_answers: WRONG });
    expect(r.error).toBeNull();
    const res = r.data as { passed: boolean; score: number; certificate_code: string | null; results: { correct: boolean; explain: string }[] };
    expect(res.passed).toBe(false);
    expect(res.score).toBe(0);
    expect(res.certificate_code).toBeNull();
    expect(res.results[0]!.explain).toBeTruthy();
  });

  it("aprobada: certifica una vez, audita y el código no cambia al repetir", async () => {
    const r = await rpc(ctx.cashier1.client, "school_submit_quiz", { p_course: "pos-basico", p_answers: RIGHT });
    expect(r.error).toBeNull();
    const res = r.data as { passed: boolean; pct: number; certificate_code: string };
    expect(res.passed).toBe(true);
    expect(res.pct).toBe(100);
    expect(res.certificate_code).toMatch(/^[0-9A-F]{10}$/);

    const again = await rpc(ctx.cashier1.client, "school_submit_quiz", { p_course: "pos-basico", p_answers: WRONG });
    expect((again.data as { certificate_code: string }).certificate_code).toBe(res.certificate_code);

    const { data: audit } = await ctx.admin
      .from("audit_logs")
      .select("action")
      .eq("tenant_id", ctx.tenantA)
      .eq("actor_user_id", ctx.cashier1.id)
      .eq("action", "school_certified");
    expect((audit ?? []).length).toBe(1);

    const { data: mine } = await from(ctx.cashier1.client, "school_progress")
      .select("quiz_attempts, best_score_pct, last_score_pct, passed_at")
      .eq("course_key", "pos-basico")
      .maybeSingle();
    expect(mine).toMatchObject({ quiz_attempts: 3, best_score_pct: 100, last_score_pct: 0 });
  });

  it("progreso aislado: el compañero no lo ve, el dueño sí, otro negocio no", async () => {
    const peer = await from(ctx.cashier2.client, "school_progress").select("id").eq("user_id", ctx.cashier1.id);
    expect((peer.data as unknown[] | null) ?? []).toHaveLength(0);
    const owner = await from(ctx.owner.client, "school_progress").select("id").eq("user_id", ctx.cashier1.id);
    expect((owner.data as unknown[]).length).toBe(1);
    const other = await from(ctx.ownerB.client, "school_progress").select("id").eq("tenant_id", ctx.tenantA);
    expect((other.data as unknown[] | null) ?? []).toHaveLength(0);
  });

  it("no se edita el progreso por PostgREST", async () => {
    await from(ctx.owner.client, "school_progress")
      .update({ passed_at: null, certificate_code: null } as never)
      .eq("user_id", ctx.cashier1.id);
    const { data } = await from(ctx.admin, "school_progress").select("certificate_code").eq("user_id", ctx.cashier1.id).maybeSingle();
    expect((data as unknown as { certificate_code: string | null }).certificate_code).not.toBeNull();
  });

  it("checklist de activación: señal de la Escuela sólo en el negocio propio", async () => {
    const a = await rpc(ctx.owner.client, "onboarding_activation_status");
    expect(a.error).toBeNull();
    expect(a.data).toMatchObject({ escuela: true, equipo: true, caja: false, arca: false });
    const b = await rpc(ctx.ownerB.client, "onboarding_activation_status");
    expect(b.data).toMatchObject({ escuela: false, equipo: false });
  });
});
