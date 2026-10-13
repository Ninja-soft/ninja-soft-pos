// Recorridos guiados, sugerencias y cuentas trabadas (F15 · H70, H71, H74 ·
// ADR-089): motor de recorridos, segmentación, cooldowns y límites, score de
// activación, contenido sembrado y chequeos estáticos de las migraciones.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  dismissRun,
  keyAction,
  nextStep,
  parseAvailableTours,
  parseRun,
  pickAutoTour,
  placeTooltip,
  prevStep,
  resolveStepView,
  routeMatches,
  serializeRun,
  spotlightPanels,
  startRun,
  type AvailableTour,
} from "@/lib/onboarding/tourEngine";
import {
  KNOWN_ANCHORS,
  audienceSchema,
  nudgeDraftSchema,
  tourStepSchema,
  tourStepsSchema,
  type TourStep,
} from "@/lib/onboarding/schema";
import { audienceMatches, audienceSummary, compactAudience } from "@/lib/onboarding/audience";
import {
  ctaTarget,
  inCooldown,
  limitReached,
  parseShownNudge,
  pickNudge,
  shouldAskNudge,
  startOfDayBA,
  type NudgeConfig,
  type NudgeContext,
  type NudgeEventRow,
} from "@/lib/onboarding/nudges";
import {
  activationScore,
  parseActivationRows,
  stuckAccounts,
  stuckReasons,
  type ActivationRow,
} from "@/lib/onboarding/activationScore";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const ROOT = join(__dirname, "..", "..");
const MIG = (f: string) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
const MIGRATIONS = [
  "20261108300000_features_tours_sugerencias.sql",
  "20261108300100_tours_sugerencias_esquema.sql",
  "20261108300200_tours_sugerencias_rpc.sql",
  "20261108300300_activacion_cuentas_trabadas.sql",
  "20261108300400_tours_sugerencias_semilla.sql",
];

const steps = (n: number): TourStep[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Paso ${i}`, placement: "modal", advance: "next" }));

function tour(p: Partial<AvailableTour> = {}): AvailableTour {
  return {
    tour_id: p.key ?? "t1",
    key: "t1",
    version: 1,
    title: "T",
    description: null,
    trigger_event: "sin_primera_venta",
    priority: 50,
    steps: steps(3),
    assigned: false,
    trigger_active: true,
    completed: false,
    dismissed: false,
    ...p,
  };
}

// ── Motor ────────────────────────────────────────────────────────────────

describe("motor de recorridos", () => {
  it("arranca solo el correctivo asignado antes que cualquier otro", () => {
    const pick = pickAutoTour([
      tour({ key: "a", tour_id: "a", priority: 90 }),
      tour({ key: "b", tour_id: "b", priority: 10, assigned: true, completed: true, trigger_active: false }),
    ]);
    expect(pick?.key).toBe("b");
  });

  it("sin asignación: mayor prioridad con evento vigente, sin terminar ni descartar", () => {
    const list = [
      tour({ key: "a", tour_id: "a", priority: 60, completed: true }),
      tour({ key: "b", tour_id: "b", priority: 55, dismissed: true }),
      tour({ key: "c", tour_id: "c", priority: 50, trigger_active: false }),
      tour({ key: "d", tour_id: "d", priority: 40 }),
      tour({ key: "e", tour_id: "e", priority: 99, trigger_event: "manual" }),
      tour({ key: "f", tour_id: "f", priority: 98, trigger_event: "venta_fallida" }),
    ];
    expect(pickAutoTour(list)?.key).toBe("d");
    expect(pickAutoTour([])).toBeNull();
  });

  it("start, siguiente con tarea, atrás, completar y métricas", () => {
    const { run, events } = startRun(tour(), "run-1");
    expect(events).toEqual([{ event: "start" }]);
    expect(run).toMatchObject({ index: 0, total: 3, status: "running" });
    const a = nextStep(run, true);
    expect(a.events).toEqual([{ event: "step_done", step_index: 0 }]);
    expect(a.run.index).toBe(1);
    expect(prevStep(a.run).index).toBe(0);
    expect(prevStep(run)).toBe(run);
    const b = nextStep(a.run);
    expect(b.events).toEqual([]);
    const c = nextStep(b.run);
    expect(c.run.status).toBe("completed");
    expect(c.events).toEqual([{ event: "complete" }]);
    expect(nextStep(c.run).events).toEqual([]);
  });

  it("descartar registra el paso donde se fue", () => {
    const { run } = startRun(tour(), "r");
    const moved = nextStep(run).run;
    const d = dismissRun(moved);
    expect(d.run.status).toBe("dismissed");
    expect(d.events).toEqual([{ event: "dismiss", step_index: 1 }]);
    expect(dismissRun(d.run).events).toEqual([]);
  });

  it("rutas por segmento", () => {
    expect(routeMatches("/pos", "/pos")).toBe(true);
    expect(routeMatches("/pos/", "/pos")).toBe(true);
    expect(routeMatches("/pos/mesa", "/pos")).toBe(true);
    expect(routeMatches("/posventa", "/pos")).toBe(false);
    expect(routeMatches("/configuracion?seccion=pagos", "/configuracion")).toBe(true);
    expect(routeMatches("/x", undefined)).toBe(true);
  });

  it("cómo se ve cada paso: ir a la pantalla, globo, foco, espera y ventana de respaldo", () => {
    const s: TourStep = {
      id: "caja",
      title: "Abrí la caja",
      placement: "spotlight",
      anchor: "pos-caja",
      route: "/pos",
      advance: "click",
      action: { label: "Ir a Vender", href: "/pos" },
    };
    expect(resolveStepView(s, "/productos", "missing")).toEqual({ kind: "navigate", href: "/pos", label: "Ir a Vender" });
    expect(resolveStepView({ ...s, action: undefined }, "/productos", "found")).toEqual({
      kind: "navigate",
      href: "/pos",
      label: "Ir a esa pantalla",
    });
    expect(resolveStepView(s, "/pos", "found")).toEqual({ kind: "anchored", placement: "spotlight" });
    expect(resolveStepView({ ...s, placement: "tooltip" }, "/pos", "found")).toEqual({ kind: "anchored", placement: "tooltip" });
    expect(resolveStepView(s, "/pos", "waiting")).toEqual({ kind: "waiting" });
    expect(resolveStepView(s, "/pos", "missing")).toEqual({ kind: "modal", fallback: true });
    expect(resolveStepView({ id: "m", title: "Hola", placement: "modal", advance: "next" }, "/x", "missing")).toEqual({
      kind: "modal",
      fallback: false,
    });
  });

  it("teclado: Esc sale, flechas navegan, Enter queda para los botones", () => {
    expect(keyAction("Escape")).toBe("dismiss");
    expect(keyAction("ArrowRight")).toBe("next");
    expect(keyAction("ArrowLeft")).toBe("prev");
    expect(keyAction("Enter")).toBeNull();
    expect(keyAction("F12")).toBeNull();
  });

  it("foco con cuatro paneles planos que dejan libre el elemento", () => {
    const panels = spotlightPanels({ top: 100, left: 50, width: 200, height: 40 }, 1000, 800, 6);
    expect(panels).toEqual([
      { top: 0, left: 0, width: 1000, height: 94 },
      { top: 146, left: 0, width: 1000, height: 654 },
      { top: 94, left: 0, width: 44, height: 52 },
      { top: 94, left: 256, width: 744, height: 52 },
    ]);
  });

  it("el globo va abajo si entra, si no arriba, siempre dentro de la pantalla", () => {
    const box = { width: 360, height: 180 };
    expect(placeTooltip({ top: 100, left: 100, width: 100, height: 40 }, box, 1200, 800)).toMatchObject({ side: "bottom", top: 152 });
    const up = placeTooltip({ top: 700, left: 1100, width: 80, height: 40 }, box, 1200, 800);
    expect(up.side).toBe("top");
    expect(up.top).toBe(508);
    expect(up.left).toBe(1200 - 16 - 360);
  });

  it("guarda y retoma el recorrido en curso; rechaza basura", () => {
    const { run } = startRun(tour(), "r");
    expect(parseRun(serializeRun(run))).toEqual(run);
    expect(parseRun("{")).toBeNull();
    expect(parseRun(null)).toBeNull();
    expect(parseRun(JSON.stringify({ ...run, index: 5 }))).toBeNull();
    expect(parseRun(JSON.stringify({ ...run, status: "completed" }))).toBeNull();
  });

  it("parsea la respuesta de tours_for_me y descarta recorridos vacíos", () => {
    const out = parseAvailableTours([
      { tour_id: "x", key: "k", version: 2, title: "T", steps: steps(1), assigned: true, trigger_event: "registro" },
      { tour_id: "y", key: "v", steps: [] },
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "k", version: 2, assigned: true, completed: false });
    expect(parseAvailableTours({})).toEqual([]);
  });
});

// ── Esquema (espejo de onboarding_steps_valid) ──────────────────────────────

describe("esquema de pasos y audiencia", () => {
  it("globo y foco necesitan ancla; avanzar al tocar también", () => {
    expect(tourStepSchema.safeParse({ id: "a", title: "Hola", placement: "tooltip" }).success).toBe(false);
    expect(tourStepSchema.safeParse({ id: "a", title: "Hola", placement: "modal", advance: "click" }).success).toBe(false);
    expect(tourStepSchema.safeParse({ id: "a", title: "Hola", placement: "spotlight", anchor: "pos-caja", advance: "click" }).success).toBe(true);
  });

  it("sólo rutas internas, sin em dash, ids únicos, 1 a 20 pasos", () => {
    const base = { id: "a", title: "Hola", placement: "modal" as const };
    expect(tourStepSchema.safeParse({ ...base, action: { label: "Ir", href: "https://evil.example" } }).success).toBe(false);
    expect(tourStepSchema.safeParse({ ...base, action: { label: "Ir ya", href: "/configuracion?seccion=pagos" } }).success).toBe(true);
    expect(tourStepSchema.safeParse({ ...base, title: "Hola — chau" }).success).toBe(false);
    expect(tourStepSchema.safeParse({ ...base, route: "/POS" }).success).toBe(false);
    expect(tourStepsSchema.safeParse([base, base]).success).toBe(false);
    expect(tourStepsSchema.safeParse([]).success).toBe(false);
    expect(tourStepsSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ ...base, id: `p${i}` }))).success).toBe(false);
  });

  it("audiencia estricta: claves conocidas, roles válidos y rango de días", () => {
    expect(audienceSchema.safeParse({ industries: ["heladeria"], roles: ["owner"] }).success).toBe(true);
    expect(audienceSchema.safeParse({ pais: ["ar"] }).success).toBe(false);
    expect(audienceSchema.safeParse({ roles: ["staff"] }).success).toBe(false);
    expect(audienceSchema.safeParse({ min_days: 10, max_days: 3 }).success).toBe(false);
  });

  it("sugerencia: botón con texto y destino, tour:clave o ruta interna, vigencia ordenada", () => {
    const base = {
      key: "x-y",
      title: "Hola hola",
      event: "sin_productos" as const,
      audience: {},
      priority: 1,
      cooldown_hours: 1,
      max_impressions: 1,
      support_fallback: false,
    };
    expect(nudgeDraftSchema.safeParse({ ...base, cta_label: "Ver", cta_href: null }).success).toBe(false);
    expect(nudgeDraftSchema.safeParse({ ...base, cta_label: "Ver", cta_href: "tour:primer-cobro" }).success).toBe(true);
    expect(nudgeDraftSchema.safeParse({ ...base, cta_label: "Ver", cta_href: "javascript:alert(1)" }).success).toBe(false);
    expect(
      nudgeDraftSchema.safeParse({ ...base, starts_at: "2026-10-10T00:00:00Z", expires_at: "2026-10-01T00:00:00Z" }).success,
    ).toBe(false);
  });
});

// ── Segmentación ─────────────────────────────────────────────────────────

describe("segmentación (espejo de onboarding_audience_match)", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const heladeria = { planFamily: "start", status: "trial", industry: "heladeria", createdAt: "2026-10-12T12:00:00Z" };

  it("vacío = todos; cada lista filtra; rubro nulo cuenta como otro", () => {
    expect(audienceMatches({}, heladeria, "cashier", now)).toBe(true);
    expect(audienceMatches({ industries: ["heladeria"], roles: ["owner", "manager"] }, heladeria, "owner", now)).toBe(true);
    expect(audienceMatches({ industries: ["heladeria"], roles: ["owner", "manager"] }, heladeria, "cashier", now)).toBe(false);
    expect(audienceMatches({ plans: ["pro"] }, heladeria, "owner", now)).toBe(false);
    expect(audienceMatches({ statuses: ["active"] }, heladeria, "owner", now)).toBe(false);
    expect(audienceMatches({ industries: ["otro"] }, { ...heladeria, industry: null }, "owner", now)).toBe(true);
  });

  it("antigüedad del alta y features del plan", () => {
    expect(audienceMatches({ max_days: 7 }, heladeria, "owner", now)).toBe(true);
    expect(audienceMatches({ min_days: 3 }, heladeria, "owner", now)).toBe(false);
    expect(audienceMatches({ features: ["mesas"] }, { ...heladeria, features: { mesas: false } }, "owner", now)).toBe(false);
    expect(audienceMatches({ features: ["mesas"] }, heladeria, "owner", now)).toBe(true);
  });

  it("resumen legible y compactado sin listas vacías", () => {
    expect(audienceSummary({})).toBe("Todos los negocios");
    expect(audienceSummary({ industries: ["heladeria"], max_days: 7 }, { industries: { heladeria: "Heladería" } })).toBe(
      "Rubro Heladería · Alta hace 7 días o menos",
    );
    expect(compactAudience({ plans: [], roles: ["owner"], min_days: 0 })).toEqual({ roles: ["owner"], min_days: 0 });
  });
});

// ── Sugerencias: cooldown y límites ───────────────────────────────────────

describe("sugerencias (espejo de nudge_next)", () => {
  const now = new Date("2026-10-13T15:00:00Z"); // 12:00 en Buenos Aires
  const n = (p: Partial<NudgeConfig>): NudgeConfig => ({
    id: p.key ?? "n",
    key: "n",
    event: "sin_productos",
    priority: 50,
    cooldown_hours: 24,
    max_impressions: 3,
    starts_at: null,
    expires_at: null,
    status: "published",
    created_at: "2026-10-01T00:00:00Z",
    ...p,
  });
  const shown = (id: string, hoursAgo: number, session: string | null = "s0"): NudgeEventRow => ({
    nudge_id: id,
    event: "shown",
    session_id: session,
    created_at: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(),
  });
  const ctx = (p: Partial<NudgeContext> = {}): NudgeContext => ({
    now,
    pushEvent: null,
    activeEvents: new Set(["sin_productos", "sin_caja_abierta"]),
    audienceOk: () => true,
    assigned: new Set(),
    sessionId: "s1",
    history: [],
    limits: { per_session: 1, per_day: 3 },
    ...p,
  });

  it("gana la de mayor prioridad con su evento vigente", () => {
    const list = [
      n({ key: "a", priority: 40, event: "sin_caja_abierta" }),
      n({ key: "b", priority: 70 }),
      n({ key: "c", priority: 99, event: "trial_por_vencer" }),
    ];
    expect(pickNudge(list, ctx())?.key).toBe("b");
  });

  it("cooldown, máximo de impresiones y no mostrar más", () => {
    const a = n({ key: "a", cooldown_hours: 12 });
    expect(inCooldown(a, [shown("a", 11)], now)).toBe(true);
    expect(inCooldown(a, [shown("a", 13)], now)).toBe(false);
    expect(pickNudge([a], ctx({ history: [shown("a", 11, "old")], limits: { per_session: 1, per_day: 9 } }))).toBeNull();
    const b = n({ key: "b", max_impressions: 2, cooldown_hours: 1 });
    const hist = [shown("b", 30, "x"), shown("b", 50, "y")];
    expect(pickNudge([b], ctx({ history: hist }))).toBeNull();
    const dismissed: NudgeEventRow = { nudge_id: "b", event: "dismissed", session_id: null, created_at: now.toISOString() };
    expect(pickNudge([n({ key: "b" })], ctx({ history: [dismissed] }))).toBeNull();
  });

  it("vigencia: antes del inicio o después de expirar no aparece; pausada tampoco", () => {
    expect(pickNudge([n({ key: "a", starts_at: "2026-10-14T00:00:00Z" })], ctx())).toBeNull();
    expect(pickNudge([n({ key: "a", expires_at: "2026-10-13T14:00:00Z" })], ctx())).toBeNull();
    expect(pickNudge([n({ key: "a", status: "paused" })], ctx())).toBeNull();
  });

  it("límite por sesión y por día (día de Buenos Aires)", () => {
    expect(startOfDayBA(now).toISOString()).toBe("2026-10-13T03:00:00.000Z");
    expect(startOfDayBA(new Date("2026-10-13T02:00:00Z")).toISOString()).toBe("2026-10-12T03:00:00.000Z");
    const list = [n({ key: "z" })];
    expect(limitReached(ctx({ history: [shown("q", 1, "s1")] }))).toBe(true);
    expect(pickNudge(list, ctx({ history: [shown("q", 1, "s1")] }))).toBeNull();
    const three = [shown("q", 1, "a"), shown("r", 2, "b"), shown("t", 3, "c")];
    expect(pickNudge(list, ctx({ history: three }))).toBeNull();
    // Las de ayer (antes de las 00:00 de Buenos Aires) no cuentan.
    const yesterday = [shown("q", 13, "a"), shown("r", 14, "b"), shown("t", 15, "c")];
    expect(pickNudge(list, ctx({ history: yesterday }))?.key).toBe("z");
  });

  it("venta fallida sólo cuando la avisa el navegador; otros eventos no se aceptan del cliente", () => {
    const vf = n({ key: "vf", event: "venta_fallida", priority: 90 });
    expect(pickNudge([vf], ctx())).toBeNull();
    expect(pickNudge([vf], ctx({ pushEvent: "venta_fallida" }))?.key).toBe("vf");
    const trial = n({ key: "t", event: "trial_por_vencer" });
    expect(pickNudge([trial], ctx({ pushEvent: "trial_por_vencer" }))).toBeNull();
  });

  it("el correctivo asignado gana y saltea audiencia, evento y máximo, pero respeta el cooldown", () => {
    const a = n({ key: "a", event: "manual", max_impressions: 1, cooldown_hours: 1 });
    const c = ctx({ assigned: new Set(["a"]), audienceOk: () => false, history: [shown("a", 5, "old")], limits: { per_session: 1, per_day: 9 } });
    expect(pickNudge([a, n({ key: "b", priority: 100 })], c)?.key).toBe("a");
    expect(pickNudge([a], { ...c, history: [shown("a", 0.5, "old")] })).toBeNull();
  });

  it("CTA: ruta interna o tour, nunca un link externo", () => {
    expect(ctaTarget("/productos")).toEqual({ kind: "route", href: "/productos" });
    expect(ctaTarget("tour:primer-cobro")).toEqual({ kind: "tour", key: "primer-cobro" });
    expect(ctaTarget("https://evil.example")).toBeNull();
    expect(ctaTarget("//evil.example")).toBeNull();
    expect(ctaTarget(null)).toBeNull();
  });

  it("pedir sugerencia: una vez por pantalla, nunca con recorrido ni con carrito", () => {
    const base = { route: "/pos", asked: new Set<string>(), tourRunning: false, cartHasItems: false };
    expect(shouldAskNudge(base)).toBe(true);
    expect(shouldAskNudge({ ...base, asked: new Set(["/pos"]) })).toBe(false);
    expect(shouldAskNudge({ ...base, tourRunning: true })).toBe(false);
    expect(shouldAskNudge({ ...base, cartHasItems: true })).toBe(false);
    expect(shouldAskNudge({ ...base, route: "/internal/x" })).toBe(false);
  });

  it("parsea la respuesta de nudge_next", () => {
    expect(parseShownNudge(null)).toBeNull();
    expect(parseShownNudge({ nudge_id: "x", title: "Hola", support_fallback: true })).toMatchObject({
      nudge_id: "x",
      version: 1,
      support_fallback: true,
      cta_href: null,
    });
  });
});

// ── Score de activación y cuentas trabadas ───────────────────────────────

describe("activación y cuentas trabadas", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const row = (p: Partial<ActivationRow> = {}, sig: Record<string, unknown> = {}): ActivationRow =>
    parseActivationRows([
      {
        tenant_id: "t",
        name: "Negocio",
        industry: "kiosco",
        status: "active",
        plan_family: "start",
        created_at: "2026-10-08T12:00:00Z",
        trial_ends_at: null,
        signals: sig,
        tours_started: 0,
        tours_completed: 0,
        nudges_clicked: 0,
        open_assignments: 0,
        ...p,
      },
    ])[0]!;

  it("puntaje por partes, de 0 a 100", () => {
    expect(activationScore(row(), null, now)).toMatchObject({ score: 0, level: "trabado" });
    const full = row({}, {
      producto: true,
      medios: true,
      fiscal: true,
      ticket: true,
      caja: true,
      venta: true,
      equipo: true,
      first_sale_at: "2026-10-09T00:00:00Z",
      shifts_7d: 2,
    });
    const r = activationScore(full, { active_users: 2, last_login_at: "2026-10-13T10:00:00Z", sales_7d_count: 4 }, now);
    expect(r.score).toBe(100);
    expect(r.level).toBe("activado");
    expect(r.parts.reduce((a, p) => a + p.max, 0)).toBe(100);
    const mid = activationScore(row({}, { producto: true, medios: true, fiscal: true, caja: true }), { active_users: 1, last_login_at: null, sales_7d_count: 0 }, now);
    expect(mid).toMatchObject({ score: 40, level: "en_camino" });
  });

  it("sin primera venta a X días, sin productos, sin caja y sin ingresos", () => {
    const reasons = stuckReasons(row(), { active_users: 1, last_login_at: "2026-10-01T00:00:00Z", sales_7d_count: 0 }, { now });
    expect(reasons.map((r) => r.key)).toEqual(["sin_primera_venta", "sin_productos", "sin_caja", "sin_ingresos"]);
    expect(reasons[0]!.label).toBe("Sin primera venta a 5 días del alta");
    expect(reasons[0]!.suggest).toEqual({ kind: "tour", key: "primer-cobro" });
    // Con un umbral de 7 días todavía no cuenta la primera venta.
    expect(stuckReasons(row(), null, { now, noSaleDays: 7 }).map((r) => r.key)).not.toContain("sin_primera_venta");
  });

  it("prueba por vencer sin ventas; suspendidos y cancelados no cuentan", () => {
    const trial = row({ status: "trial", trial_ends_at: "2026-10-15T12:00:00Z" }, { producto: true, caja: true });
    expect(stuckReasons(trial, { active_users: 1, last_login_at: "2026-10-13T00:00:00Z", sales_7d_count: 0 }, { now }).map((r) => r.key)).toEqual([
      "sin_primera_venta",
      "trial_sin_uso",
    ]);
    expect(stuckReasons(row({ status: "suspended" }), null, { now })).toEqual([]);
  });

  it("un negocio que ya vendió y se usa no está trabado; el orden prioriza más motivos", () => {
    const ok = row({ tenant_id: "ok" }, { producto: true, caja: true, venta: true, first_sale_at: "2026-10-09T00:00:00Z" });
    const bad = row({ tenant_id: "bad", created_at: "2026-10-01T00:00:00Z" });
    const meh = row({ tenant_id: "meh" }, { producto: true, caja: true });
    const health = new Map([
      ["ok", { active_users: 1, last_login_at: "2026-10-13T00:00:00Z", sales_7d_count: 3 }],
      ["meh", { active_users: 1, last_login_at: "2026-10-13T00:00:00Z", sales_7d_count: 0 }],
    ]);
    const out = stuckAccounts([ok, meh, bad], health, { now });
    expect(out.map((a) => a.row.tenant_id)).toEqual(["bad", "meh"]);
  });
});

// ── Contenido sembrado y anclas ──────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(f)) out.push(p);
  }
  return out;
}

function seededTours(): Map<string, TourStep[]> {
  const sql = MIG("20261108300400_tours_sugerencias_semilla.sql");
  const out = new Map<string, TourStep[]>();
  const re = /\('([a-z0-9-]+)',\s*'[^']+',\s*'[^']+',\s*'[a-z_]+',\s*\d+,\s*'[^']*'::jsonb,\s*\$steps\$([\s\S]*?)\$steps\$::jsonb\)/g;
  for (const m of sql.matchAll(re)) out.set(m[1]!, JSON.parse(m[2]!) as TourStep[]);
  return out;
}

describe("recorridos sembrados", () => {
  const tours = seededTours();

  it("hay dos recorridos y sus pasos pasan el esquema", () => {
    expect([...tours.keys()]).toEqual(["primer-cobro", "heladeria-favoritos-sabores"]);
    for (const [, s] of tours) expect(tourStepsSchema.safeParse(s).success).toBe(true);
  });

  it("cada ancla usada existe en la lista conocida y en el TSX", () => {
    const tsx = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const a of KNOWN_ANCHORS) expect(tsx).toContain(`data-tour="${a}"`);
    for (const [, s] of tours) {
      for (const step of s) if (step.anchor) expect(KNOWN_ANCHORS as readonly string[]).toContain(step.anchor);
    }
  });

  it("criterio H70: la heladería pasa por favoritos, sabores, medios de pago y primer cobro", () => {
    const h = tours.get("heladeria-favoritos-sabores")!;
    const ids = h.map((s) => s.id);
    for (const k of ["favoritos", "sabores", "medios", "cobrar"]) expect(ids).toContain(k);
    expect(ids.indexOf("favoritos")).toBeLessThan(ids.indexOf("cobrar"));
    const sql = MIG("20261108300400_tours_sugerencias_semilla.sql");
    expect(sql).toMatch(/'registro',\s*60,\s*'\{"industries": \["heladeria"\]/);
  });

  it("primer cobro: todo rubro (sin filtro de rubro) y arranca sin primera venta", () => {
    const sql = MIG("20261108300400_tours_sugerencias_semilla.sql");
    expect(sql).toMatch(/'primer-cobro',[\s\S]*?'sin_primera_venta',\s*50,\s*'\{"roles": \["owner", "manager"\]\}'/);
  });

  it("sugerencias sembradas para los eventos de H74", () => {
    const sql = MIG("20261108300400_tours_sugerencias_semilla.sql");
    for (const e of ["sin_productos", "sin_caja_abierta", "sin_primera_venta", "trial_por_vencer", "venta_fallida", "registro"]) {
      expect(sql).toContain(`'${e}'`);
    }
    expect(sql).not.toContain("—");
  });
});

// ── Migraciones ──────────────────────────────────────────────────────────

describe("migraciones de recorridos y sugerencias", () => {
  const all = MIGRATIONS.map(MIG).join("\n");

  it("features BASE en los cuatro planes, con copy", () => {
    const sql = MIG(MIGRATIONS[0]!);
    expect(sql).toMatch(/\('tours',[\s\S]*?'extras', true, \d+\)/);
    expect(sql).toMatch(/\('sugerencias',[\s\S]*?'extras', true, \d+\)/);
    expect(sql).toMatch(/'start', 'pro', 'business', 'enterprise'/);
    expect(FEATURE_INFO.tours?.minPlan).toBe("Start");
    expect(FEATURE_INFO.sugerencias?.minPlan).toBe("Start");
  });

  it("gating real en el servidor", () => {
    expect(all).toMatch(/tenant_has_feature_for\(new\.tenant_id, 'tours'\)/);
    expect(all).toMatch(/tenant_has_feature_for\(new\.tenant_id, 'sugerencias'\)/);
    expect(all).toMatch(/tenant_has_feature_for\(v_tenant, 'tours'\)/);
    expect(all).toMatch(/tenant_has_feature_for\(v_tenant, 'sugerencias'\)/);
  });

  it("policies con (select current_tenant_id()) y (select internal_scope()), nunca is_internal()", () => {
    const policies = all.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(9);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal\(\)/);
      expect(p.replace(/\(select current_tenant_id\(\)\)/g, "")).not.toMatch(/current_tenant_id\(\)/);
      expect(p.replace(/\(select internal_scope\(\)\)/g, "")).not.toMatch(/internal_scope\(\)/);
    }
  });

  it("toda RPC interna exige internal_scope y escribe audit_logs", () => {
    const rpc = MIG(MIGRATIONS[2]!) + MIG(MIGRATIONS[3]!);
    for (const fn of [
      "internal_tour_save",
      "internal_tour_publish",
      "internal_tour_set_status",
      "internal_nudge_save",
      "internal_nudge_set_status",
      "internal_nudge_settings_save",
      "internal_onboarding_assign",
      "internal_onboarding_assignment_cancel",
    ]) {
      const body = rpc.split(`create or replace function ${fn}(`)[1]!.split("$$;")[0]!;
      expect(body, fn).toMatch(/onboarding_assert_editor\(\)|internal_scope\(\)/);
      expect(body, fn).toMatch(/insert into audit_logs/);
    }
    expect(all).not.toMatch(/delete from audit_logs/i);
  });

  it("onboarding_status y onboarding_activation_status delegan en una sola definición", () => {
    const sql = MIG(MIGRATIONS[3]!);
    expect(sql.match(/onboarding_tenant_signals\(current_tenant_id\(\)\)/g)).toHaveLength(2);
    expect(sql).toMatch(/revoke all on function onboarding_tenant_signals\(uuid\) from public, anon, authenticated/);
  });

  it("los validadores SQL y Zod piden lo mismo", () => {
    const sql = MIG(MIGRATIONS[1]!);
    expect(sql).toContain("'^[a-z0-9][a-z0-9-]{0,39}$'"); // id de paso
    expect(sql).toContain("'^/[a-z0-9/_-]*$'"); // ruta
    expect(sql).toContain("'^/[a-z0-9/_?=&.-]*$'"); // destino del botón
    expect(sql).toMatch(/jsonb_array_length\(p_steps\) > 20/);
    expect(sql).toMatch(/'plans', 'statuses', 'industries', 'roles', 'features', 'min_days', 'max_days'/);
  });
});
