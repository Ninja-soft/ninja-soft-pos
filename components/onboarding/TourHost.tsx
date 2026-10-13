"use client";

// Motor de recorridos guiados en la UI (F15 · H70 · ADR-089). Liviano y
// propio: busca el ancla `data-tour` de cada paso, dibuja un foco con paneles
// planos (sin sombra ni máscara) y un globo accesible. La lógica (qué
// recorrido arranca, en qué paso está, cómo se muestra) es pura y está en
// lib/onboarding/tourEngine.ts.
//
// Accesibilidad: el globo es un diálogo con título y descripción; recibe el
// foco en cada paso y lo devuelve al terminar. Esc sale, flechas izquierda y
// derecha navegan. La ventana centrada atrapa el foco (Tab y Shift+Tab).
// Si se abre otro diálogo de la app (p. ej. "Nuevo producto"), el recorrido
// se pausa y sigue cuando se cierra.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  TOURS_QUERY_KEY,
  TOUR_START_EVENT,
  trackTourEvents,
  useToursForMe,
} from "@/modules/onboarding/guidance";
import {
  TOUR_RUN_STORAGE_KEY,
  dismissRun,
  keyAction,
  nextStep,
  parseRun,
  pickAutoTour,
  placeTooltip,
  prevStep,
  resolveStepView,
  serializeRun,
  spotlightPanels,
  startRun,
  type AnchorState,
  type AvailableTour,
  type Rect,
  type TourRun,
  type TrackEvent,
} from "@/lib/onboarding/tourEngine";

const ANCHOR_WAIT_MS = 2000;
const POLL_MS = 250;
const AUTO_DELAY_MS = 1500;
const AUTO_FLAG = "ninja-tour-auto";

function safeSession(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function newRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
  }
}

function findAnchor(anchor: string | undefined): HTMLElement | null {
  if (!anchor || typeof document === "undefined") return null;
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`);
  for (const el of Array.from(nodes)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** ¿Hay un diálogo de la app abierto (no del recorrido)? */
function foreignDialogOpen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[role="dialog"][data-state="open"]:not([data-tour-ui])'));
}

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

export function TourHost({ role }: { role: string | null }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const qc = useQueryClient();
  const { data: tenant } = useMyTenant();
  const { data: tours } = useToursForMe(Boolean(role));
  const [run, setRun] = useState<TourRun | null>(null);
  const [anchorState, setAnchorState] = useState<AnchorState>("waiting");
  const [rect, setRect] = useState<Rect | null>(null);
  const [paused, setPaused] = useState(false);
  const [viewport, setViewport] = useState({ w: 1024, h: 768 });
  const [cardSize, setCardSize] = useState({ width: 360, height: 180 });
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const viewed = useRef<Set<string>>(new Set());
  const titleId = useId();
  const bodyId = useId();

  const tour: AvailableTour | null = useMemo(
    () => (run ? tours?.find((t) => t.tour_id === run.tourId && t.version === run.version) ?? null : null),
    [run, tours],
  );
  const step = tour && run ? tour.steps[run.index] ?? null : null;

  const send = useCallback(
    (r: TourRun, events: TrackEvent[]) => {
      if (!tenant?.tenantId || !events.length) return;
      void trackTourEvents(tenant.tenantId, { tourId: r.tourId, version: r.version, runId: r.runId }, events, pathname);
    },
    [tenant?.tenantId, pathname],
  );

  const finish = useCallback(() => {
    setRun(null);
    safeSession()?.removeItem(TOUR_RUN_STORAGE_KEY);
    qc.invalidateQueries({ queryKey: TOURS_QUERY_KEY });
    const prevFocus = returnFocus.current;
    returnFocus.current = null;
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }, [qc]);

  const begin = useCallback(
    (t: AvailableTour) => {
      if (typeof document !== "undefined") returnFocus.current = document.activeElement as HTMLElement | null;
      const { run: r, events } = startRun(t, newRunId());
      setRun(r);
      send(r, events);
    },
    [send],
  );

  // Las transiciones se calculan con el estado actual (no dentro del updater
  // de setState: en modo estricto React lo llama dos veces y duplicaría las
  // métricas).
  const advance = useCallback(
    (done = false) => {
      if (!run) return;
      const { run: r, events } = nextStep(run, done);
      send(r, events);
      if (r.status !== "running") finish();
      else setRun(r);
    },
    [run, send, finish],
  );

  const back = useCallback(() => {
    if (run) setRun(prevStep(run));
  }, [run]);

  const dismiss = useCallback(() => {
    if (!run) return;
    const { run: r, events } = dismissRun(run);
    send(r, events);
    finish();
  }, [run, send, finish]);

  // Retomar un recorrido en curso (navegación o recarga).
  useEffect(() => {
    if (run || !tours?.length) return;
    const saved = parseRun(safeSession()?.getItem(TOUR_RUN_STORAGE_KEY) ?? null);
    if (saved && tours.some((t) => t.tour_id === saved.tourId && t.version === saved.version)) {
      setRun(saved);
    }
    // Sólo al cargar la lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tours]);

  // Guardar el paso actual.
  useEffect(() => {
    const s = safeSession();
    if (!s) return;
    if (run && run.status === "running") s.setItem(TOUR_RUN_STORAGE_KEY, serializeRun(run));
  }, [run]);

  // Arranque automático: una vez por sesión y negocio.
  useEffect(() => {
    if (run || !tours?.length || !tenant?.tenantId) return;
    const s = safeSession();
    const flag = `${AUTO_FLAG}:${tenant.tenantId}`;
    if (s?.getItem(flag) || s?.getItem(TOUR_RUN_STORAGE_KEY)) return;
    const pick = pickAutoTour(tours);
    if (!pick) return;
    const t = setTimeout(() => {
      s?.setItem(flag, "1");
      begin(pick);
    }, AUTO_DELAY_MS);
    return () => clearTimeout(t);
  }, [tours, tenant?.tenantId, run, begin]);

  // Inicio a pedido (Ayuda, sugerencias).
  useEffect(() => {
    const onStart = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      const t = tours?.find((x) => x.key === key);
      if (!t) return;
      if (run) {
        const { run: r, events } = dismissRun(run);
        send(r, events);
      }
      begin(t);
    };
    window.addEventListener(TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(TOUR_START_EVENT, onStart);
  }, [tours, run, begin, send]);

  // Ancla, pausa y tamaño de pantalla (sondeo liviano sólo con recorrido).
  const anchor = step?.anchor;
  const stepKey = run ? `${run.runId}:${run.index}` : "";
  useEffect(() => {
    if (!run || !step) return;
    const started = Date.now();
    let scrolled = false;
    setAnchorState("waiting");
    setRect(null);
    // Los setters devuelven el estado anterior si nada cambió: el sondeo no
    // vuelve a dibujar la pantalla cada 250 ms.
    const tick = () => {
      setPaused(foreignDialogOpen());
      const w = window.innerWidth;
      const h = window.innerHeight;
      setViewport((v) => (v.w === w && v.h === h ? v : { w, h }));
      if (!anchor) return;
      const el = findAnchor(anchor);
      if (el) {
        if (!scrolled) {
          scrolled = true;
          const r = el.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center" });
        }
        const next = toRect(el.getBoundingClientRect());
        setRect((cur) => (cur && sameRect(cur, next) ? cur : next));
        setAnchorState("found");
      } else {
        setRect(null);
        setAnchorState(Date.now() - started > ANCHOR_WAIT_MS ? "missing" : "waiting");
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
    // stepKey cubre run.index y run.runId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, anchor, pathname]);

  const view = step ? resolveStepView(step, pathname, anchorState) : null;
  const visible = Boolean(run && step && view && view.kind !== "waiting" && !paused);

  // Métrica: paso visto (una vez por recorrido y paso, en su pantalla).
  useEffect(() => {
    if (!run || !visible || !view || view.kind === "navigate") return;
    const k = `${run.runId}:${run.index}`;
    if (viewed.current.has(k)) return;
    viewed.current.add(k);
    send(run, [{ event: "step_view", step_index: run.index }]);
  }, [run, visible, view, send]);

  // "Hacer ahora": tocar el elemento resaltado avanza.
  useEffect(() => {
    if (!visible || !step || step.advance !== "click" || view?.kind !== "anchored") return;
    const el = findAnchor(step.anchor);
    if (!el) return;
    const onClick = () => setTimeout(() => advance(true), 0);
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [visible, step, view?.kind, advance]);

  // Foco al globo en cada paso.
  useEffect(() => {
    if (visible) cardRef.current?.focus({ preventScroll: true });
  }, [visible, stepKey, view?.kind]);

  // Medir el globo para ubicarlo.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== cardSize.width || h !== cardSize.height) setCardSize({ width: w, height: h });
  }, [visible, stepKey, view?.kind, cardSize.width, cardSize.height]);

  // Esc en cualquier lugar mientras el recorrido está a la vista.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (keyAction(e.key) === "dismiss") {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  if (!visible || !run || !step || !tour || !view || typeof document === "undefined") return null;

  const narrow = viewport.w < 640;
  const isModal = view.kind === "modal";
  const isLast = run.index >= run.total - 1;
  const spotlight = view.kind === "anchored" && view.placement === "spotlight" && rect;
  const ring = view.kind === "anchored" && rect;
  const pos =
    view.kind === "anchored" && rect && !narrow
      ? placeTooltip(rect, cardSize, viewport.w, viewport.h)
      : null;

  const onCardKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const a = keyAction(e.key);
    if (a === "next" && view.kind !== "navigate") {
      e.preventDefault();
      advance(false);
    } else if (a === "prev") {
      e.preventDefault();
      back();
    } else if (e.key === "Tab" && isModal) {
      // Trampa de foco de la ventana centrada.
      const f = Array.from(
        cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href]") ?? [],
      );
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div data-tour-ui>
      {isModal && <div aria-hidden className="fixed inset-0 z-[65] bg-black/60" onClick={dismiss} />}
      {spotlight &&
        spotlightPanels(rect, viewport.w, viewport.h).map((p, i) => (
          <div
            key={i}
            aria-hidden
            className={cn("fixed z-[65] bg-black/60", step.block ? "pointer-events-auto" : "pointer-events-none")}
            style={{ top: p.top, left: p.left, width: p.width, height: p.height }}
          />
        ))}
      {ring && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[66] rounded-md outline outline-2 outline-ninja-flame"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div
        ref={cardRef}
        data-tour-ui
        role="dialog"
        aria-modal={isModal || undefined}
        aria-labelledby={titleId}
        aria-describedby={step.body ? bodyId : undefined}
        tabIndex={-1}
        onKeyDown={onCardKey}
        className={cn(
          "fixed z-[70] rounded-md border border-border bg-popover p-4 text-popover-foreground outline-none",
          narrow
            ? "inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))]"
            : "w-[360px]",
          !narrow && isModal && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          !narrow && view.kind === "navigate" && "bottom-6 right-6",
          !narrow && view.kind === "anchored" && !pos && "bottom-6 right-6",
        )}
        style={pos ? { top: pos.top, left: pos.left } : undefined}
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {tour.title} · Paso {run.index + 1} de {run.total}
          </p>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Salir del recorrido"
            className="-m-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <h2 id={titleId} className="mt-1 text-base font-semibold text-foreground">
          {step.title}
        </h2>
        {step.body && (
          <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {step.body}
          </p>
        )}
        {view.kind === "modal" && view.fallback && (
          <p className="mt-2 text-xs text-muted-foreground">
            Este paso no se ve en esta pantalla. Podés seguir cuando quieras.
          </p>
        )}
        {view.kind === "anchored" && step.advance === "click" && (
          <p className="mt-2 text-xs font-medium text-foreground">Tocá lo resaltado para seguir.</p>
        )}
        <div className="mt-4 flex items-center gap-2">
          {run.index > 0 && (
            <Button variant="ghost" size="sm" onClick={back}>
              Atrás
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {view.kind === "navigate" ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => advance(false)}>
                  Saltar
                </Button>
                <Button size="sm" onClick={() => router.push(view.href as Route)}>
                  {view.label}
                </Button>
              </>
            ) : (
              !(step.block && step.advance === "click" && view.kind === "anchored") && (
                <Button size="sm" onClick={() => advance(false)}>
                  {isLast ? "Terminar" : "Siguiente"}
                </Button>
              )
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
