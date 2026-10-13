// =============================================================================
// Sugerencias por evento (F15 · H74 · ADR-089). Espejo puro de nudge_next
// (migración 20261108300200): orden, cooldown, máximo de impresiones,
// expiración, "no mostrar más" y el límite por sesión y por día. El servidor
// decide y registra la impresión; esto documenta la regla y la testea.
// =============================================================================
import type { OnboardingEvent } from "./schema";

export interface NudgeConfig {
  id: string;
  key: string;
  event: OnboardingEvent;
  priority: number;
  cooldown_hours: number;
  max_impressions: number;
  starts_at: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
}

export interface NudgeEventRow {
  nudge_id: string;
  event: "shown" | "clicked" | "dismissed";
  session_id: string | null;
  created_at: string;
}

export interface NudgeLimits {
  per_session: number;
  per_day: number;
}

export interface NudgeContext {
  now: Date;
  /** Evento que avisó el navegador (sólo venta_fallida vale). */
  pushEvent: OnboardingEvent | null;
  /** Eventos de estado vigentes para el negocio (sin productos, etc.). */
  activeEvents: ReadonlySet<OnboardingEvent>;
  /** Sugerencias cuya audiencia incluye al usuario. */
  audienceOk: (n: NudgeConfig) => boolean;
  /** Sugerencias asignadas por el staff (correctivo abierto). */
  assigned: ReadonlySet<string>;
  sessionId: string | null;
  history: NudgeEventRow[];
  limits: NudgeLimits;
}

const HOUR = 3_600_000;

/** Inicio del día calendario en Buenos Aires (UTC-3, sin horario de verano). */
export function startOfDayBA(now: Date): Date {
  const shifted = new Date(now.getTime() - 3 * HOUR);
  const d = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(d + 3 * HOUR);
}

export function limitReached(ctx: Pick<NudgeContext, "now" | "history" | "sessionId" | "limits">): boolean {
  const day0 = startOfDayBA(ctx.now).getTime();
  const shown = ctx.history.filter((e) => e.event === "shown");
  if (shown.filter((e) => new Date(e.created_at).getTime() >= day0).length >= ctx.limits.per_day) return true;
  if (ctx.sessionId && shown.filter((e) => e.session_id === ctx.sessionId).length >= ctx.limits.per_session) {
    return true;
  }
  return false;
}

export function inCooldown(n: NudgeConfig, history: NudgeEventRow[], now: Date): boolean {
  const since = now.getTime() - n.cooldown_hours * HOUR;
  return history.some(
    (e) => e.nudge_id === n.id && e.event === "shown" && new Date(e.created_at).getTime() > since,
  );
}

export function isLive(n: NudgeConfig, now: Date): boolean {
  if (n.status !== "published") return false;
  if (n.starts_at && new Date(n.starts_at).getTime() > now.getTime()) return false;
  if (n.expires_at && new Date(n.expires_at).getTime() <= now.getTime()) return false;
  return true;
}

export function pickNudge(nudges: NudgeConfig[], ctx: NudgeContext): NudgeConfig | null {
  if (limitReached(ctx)) return null;
  const push = ctx.pushEvent === "venta_fallida" ? ctx.pushEvent : null;
  const eligible = nudges.filter((n) => {
    if (!isLive(n, ctx.now)) return false;
    if (inCooldown(n, ctx.history, ctx.now)) return false;
    if (ctx.assigned.has(n.id)) return true;
    if (!ctx.audienceOk(n)) return false;
    if (!(n.event === push || ctx.activeEvents.has(n.event))) return false;
    const mine = ctx.history.filter((e) => e.nudge_id === n.id);
    if (mine.some((e) => e.event === "dismissed")) return false;
    if (mine.filter((e) => e.event === "shown").length >= n.max_impressions) return false;
    return true;
  });
  eligible.sort(
    (a, b) =>
      Number(ctx.assigned.has(b.id)) - Number(ctx.assigned.has(a.id)) ||
      b.priority - a.priority ||
      a.created_at.localeCompare(b.created_at),
  );
  return eligible[0] ?? null;
}

// ── Lado del navegador ────────────────────────────────────────────────────

export interface ShownNudge {
  nudge_id: string;
  key: string;
  version: number;
  title: string;
  body: string | null;
  event: OnboardingEvent;
  cta_label: string | null;
  cta_href: string | null;
  support_fallback: boolean;
  assigned: boolean;
}

export function parseShownNudge(raw: unknown): ShownNudge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.nudge_id !== "string" || typeof r.title !== "string") return null;
  return {
    nudge_id: r.nudge_id,
    key: String(r.key ?? ""),
    version: Number(r.version ?? 1),
    title: r.title,
    body: typeof r.body === "string" ? r.body : null,
    event: String(r.event ?? "manual") as OnboardingEvent,
    cta_label: typeof r.cta_label === "string" ? r.cta_label : null,
    cta_href: typeof r.cta_href === "string" ? r.cta_href : null,
    support_fallback: r.support_fallback === true,
    assigned: r.assigned === true,
  };
}

/** CTA: ruta interna o "tour:<key>" (abre ese recorrido). Nada externo. */
export function ctaTarget(href: string | null): { kind: "route"; href: string } | { kind: "tour"; key: string } | null {
  if (!href) return null;
  const tour = /^tour:([a-z0-9][a-z0-9-]{1,59})$/.exec(href);
  if (tour) return { kind: "tour", key: tour[1]! };
  if (/^\/[a-z0-9/_?=&.-]*$/.test(href) && !href.startsWith("//")) return { kind: "route", href };
  return null;
}

/**
 * ¿Pedir una sugerencia al llegar a esta pantalla? Una vez por pantalla y
 * sesión, nunca con un recorrido en curso ni con una venta a medio cargar.
 */
export function shouldAskNudge(opts: {
  route: string;
  asked: ReadonlySet<string>;
  tourRunning: boolean;
  cartHasItems: boolean;
}): boolean {
  if (opts.tourRunning) return false;
  if (opts.cartHasItems) return false;
  if (opts.route.startsWith("/internal") || opts.route.startsWith("/auth")) return false;
  return !opts.asked.has(opts.route);
}
