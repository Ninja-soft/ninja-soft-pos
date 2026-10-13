// =============================================================================
// Motor de recorridos guiados (F15 · H70 · ADR-089). Puro y sin dependencias:
// decide qué recorrido arranca solo, en qué paso está, cómo se muestra cada
// paso según la pantalla actual y dónde va el globo. El componente
// (components/onboarding/TourHost.tsx) sólo mide el DOM y dibuja.
// =============================================================================
import type { OnboardingEvent, TourStep } from "./schema";

export interface AvailableTour {
  tour_id: string;
  key: string;
  version: number;
  title: string;
  description: string | null;
  trigger_event: OnboardingEvent;
  priority: number;
  steps: TourStep[];
  assigned: boolean;
  trigger_active: boolean;
  completed: boolean;
  dismissed: boolean;
}

export type RunStatus = "running" | "completed" | "dismissed";

export interface TourRun {
  tourId: string;
  key: string;
  version: number;
  runId: string;
  index: number;
  total: number;
  status: RunStatus;
}

/** Evento de métrica que genera una transición (lo carga el host). */
export type TrackEvent =
  | { event: "start" }
  | { event: "step_view"; step_index: number }
  | { event: "step_done"; step_index: number }
  | { event: "complete" }
  | { event: "dismiss"; step_index: number };

export function parseAvailableTours(raw: unknown): AvailableTour[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      tour_id: String(t.tour_id ?? ""),
      key: String(t.key ?? ""),
      version: Number(t.version ?? 1),
      title: String(t.title ?? ""),
      description: typeof t.description === "string" ? t.description : null,
      trigger_event: String(t.trigger_event ?? "manual") as OnboardingEvent,
      priority: Number(t.priority ?? 0),
      steps: Array.isArray(t.steps) ? (t.steps as TourStep[]) : [],
      assigned: t.assigned === true,
      trigger_active: t.trigger_active === true,
      completed: t.completed === true,
      dismissed: t.dismissed === true,
    }))
    .filter((t) => t.tour_id && t.steps.length > 0);
}

/**
 * Recorrido que arranca solo. Primero los correctivos asignados por el staff
 * (el servidor los consume al completar o descartar); después, de mayor a
 * menor prioridad, los que tienen su evento vigente y el usuario no terminó ni
 * descartó. `manual` y los eventos del navegador nunca arrancan solos.
 */
export function pickAutoTour(tours: AvailableTour[]): AvailableTour | null {
  const assigned = tours.filter((t) => t.assigned);
  if (assigned.length) return [...assigned].sort((a, b) => b.priority - a.priority)[0]!;
  const auto = tours.filter(
    (t) =>
      t.trigger_active &&
      !t.completed &&
      !t.dismissed &&
      t.trigger_event !== "manual" &&
      t.trigger_event !== "venta_fallida",
  );
  if (!auto.length) return null;
  return [...auto].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))[0]!;
}

export function startRun(tour: AvailableTour, runId: string): { run: TourRun; events: TrackEvent[] } {
  return {
    run: {
      tourId: tour.tour_id,
      key: tour.key,
      version: tour.version,
      runId,
      index: 0,
      total: tour.steps.length,
      status: "running",
    },
    events: [{ event: "start" }],
  };
}

/** Avanza. `done` = el usuario hizo la tarea (tocó el ancla). */
export function nextStep(run: TourRun, done = false): { run: TourRun; events: TrackEvent[] } {
  if (run.status !== "running") return { run, events: [] };
  const events: TrackEvent[] = done ? [{ event: "step_done", step_index: run.index }] : [];
  if (run.index >= run.total - 1) {
    return { run: { ...run, status: "completed" }, events: [...events, { event: "complete" }] };
  }
  return { run: { ...run, index: run.index + 1 }, events };
}

export function prevStep(run: TourRun): TourRun {
  if (run.status !== "running" || run.index === 0) return run;
  return { ...run, index: run.index - 1 };
}

export function dismissRun(run: TourRun): { run: TourRun; events: TrackEvent[] } {
  if (run.status !== "running") return { run, events: [] };
  return { run: { ...run, status: "dismissed" }, events: [{ event: "dismiss", step_index: run.index }] };
}

/** ¿La ruta actual es la del paso? Por segmentos: /pos coincide con /pos/x, no con /posventa. */
export function routeMatches(pathname: string, route: string | undefined | null): boolean {
  if (!route) return true;
  const clean = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const a = clean(pathname.split("?")[0] ?? "");
  const b = clean(route);
  return a === b || a.startsWith(`${b}/`);
}

export type AnchorState = "found" | "waiting" | "missing";

export type StepView =
  | { kind: "navigate"; href: string; label: string }
  | { kind: "anchored"; placement: "tooltip" | "spotlight" }
  | { kind: "modal"; fallback: boolean }
  | { kind: "waiting" };

/**
 * Cómo se muestra el paso:
 *  - otra pantalla: tarjeta "Ir a ..." (hacer ahora);
 *  - ancla en pantalla: globo o foco;
 *  - ancla que no aparece (sin permiso, sin datos, pantalla chica): ventana
 *    centrada con el mismo texto, así el recorrido nunca se traba.
 */
export function resolveStepView(step: TourStep, pathname: string, anchor: AnchorState): StepView {
  if (step.route && !routeMatches(pathname, step.route)) {
    const href = step.action?.href ?? step.route;
    return { kind: "navigate", href, label: step.action?.label ?? "Ir a esa pantalla" };
  }
  if (step.placement === "modal" || !step.anchor) return { kind: "modal", fallback: false };
  if (anchor === "found") return { kind: "anchored", placement: step.placement === "spotlight" ? "spotlight" : "tooltip" };
  if (anchor === "waiting") return { kind: "waiting" };
  return { kind: "modal", fallback: true };
}

/** Atajos de teclado del globo. Enter y Espacio quedan para los botones. */
export function keyAction(key: string): "next" | "prev" | "dismiss" | null {
  if (key === "Escape" || key === "Esc") return "dismiss";
  if (key === "ArrowRight") return "next";
  if (key === "ArrowLeft") return "prev";
  return null;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Cuatro paneles planos alrededor del elemento (sin sombra ni máscara). */
export function spotlightPanels(target: Rect, vw: number, vh: number, pad = 6): Rect[] {
  const top = Math.max(0, target.top - pad);
  const left = Math.max(0, target.left - pad);
  const right = Math.min(vw, target.left + target.width + pad);
  const bottom = Math.min(vh, target.top + target.height + pad);
  return [
    { top: 0, left: 0, width: vw, height: top },
    { top: bottom, left: 0, width: vw, height: Math.max(0, vh - bottom) },
    { top, left: 0, width: left, height: Math.max(0, bottom - top) },
    { top, left: right, width: Math.max(0, vw - right), height: Math.max(0, bottom - top) },
  ];
}

/**
 * Posición del globo: abajo del elemento si entra, si no arriba, siempre
 * dentro de la pantalla con 16 px de margen. En pantallas angostas (< 640 px)
 * el host lo muestra como hoja inferior y no usa esta función.
 */
export function placeTooltip(
  target: Rect,
  box: { width: number; height: number },
  vw: number,
  vh: number,
  gap = 12,
  margin = 16,
): { top: number; left: number; side: "bottom" | "top" } {
  const below = target.top + target.height + gap;
  const above = target.top - gap - box.height;
  const side: "bottom" | "top" = below + box.height <= vh - margin || above < margin ? "bottom" : "top";
  const rawTop = side === "bottom" ? below : above;
  const top = Math.min(Math.max(margin, rawTop), Math.max(margin, vh - margin - box.height));
  const center = target.left + target.width / 2 - box.width / 2;
  const left = Math.min(Math.max(margin, center), Math.max(margin, vw - margin - box.width));
  return { top, left, side };
}

// ── Persistencia del recorrido en curso (sobrevive a navegar y recargar) ──

const RUN_KEY = "ninja-tour-run";

export function serializeRun(run: TourRun): string {
  return JSON.stringify(run);
}

export function parseRun(raw: string | null): TourRun | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<TourRun>;
    if (
      typeof r.tourId !== "string" ||
      typeof r.runId !== "string" ||
      typeof r.index !== "number" ||
      typeof r.total !== "number" ||
      r.status !== "running" ||
      r.index < 0 ||
      r.index >= r.total
    ) {
      return null;
    }
    return r as TourRun;
  } catch {
    return null;
  }
}

export const TOUR_RUN_STORAGE_KEY = RUN_KEY;
