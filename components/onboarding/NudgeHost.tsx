"use client";

// Sugerencias por evento (F15 · H74 · ADR-089). Pide al servidor la mejor
// sugerencia vigente una vez por pantalla y sesión (nunca con un recorrido en
// curso ni con una venta a medio cargar) y cuando la app avisa un evento
// puntual (venta fallida). El servidor aplica audiencia, cooldown, máximo de
// impresiones, expiración y el límite por sesión y por día; acá sólo se
// muestra. Tarjeta no modal, anunciada con aria-live, sin sombra.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { Lightbulb, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useCartStore } from "@/modules/pos/store";
import {
  ONBOARDING_EVENT,
  fetchNextNudge,
  requestHelpPanel,
  requestTour,
  trackNudgeEvent,
} from "@/modules/onboarding/guidance";
import { ctaTarget, shouldAskNudge, type ShownNudge } from "@/lib/onboarding/nudges";
import { TOUR_RUN_STORAGE_KEY } from "@/lib/onboarding/tourEngine";

const SESSION_KEY = "ninja-nudge-session";
const ASKED_KEY = "ninja-nudge-asked";
const ASK_DELAY_MS = 2500;

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function sessionId(): string {
  const s = store();
  const prev = s?.getItem(SESSION_KEY);
  if (prev && /^[A-Za-z0-9-]{8,64}$/.test(prev)) return prev;
  let id: string;
  try {
    id = crypto.randomUUID();
  } catch {
    id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  s?.setItem(SESSION_KEY, id);
  return id;
}

function askedRoutes(): Set<string> {
  try {
    const raw = store()?.getItem(ASKED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function markAsked(route: string) {
  const set = askedRoutes();
  set.add(route);
  store()?.setItem(ASKED_KEY, JSON.stringify(Array.from(set).slice(-50)));
}

export function NudgeHost({ role }: { role: string | null }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { data: tenant } = useMyTenant();
  const [nudge, setNudge] = useState<ShownNudge | null>(null);
  const busy = useRef(false);
  const tenantId = tenant?.tenantId ?? null;

  const ask = useCallback(
    async (event: "venta_fallida" | null) => {
      if (busy.current || !tenantId) return;
      busy.current = true;
      try {
        const n = await fetchNextNudge({ event, session: sessionId(), route: pathname });
        if (n) setNudge(n);
      } finally {
        busy.current = false;
      }
    },
    [tenantId, pathname],
  );

  // Al llegar a una pantalla (con pausa para no competir con la carga).
  useEffect(() => {
    if (!role || !tenantId || nudge) return;
    const t = setTimeout(() => {
      const ok = shouldAskNudge({
        route: pathname,
        asked: askedRoutes(),
        tourRunning: Boolean(store()?.getItem(TOUR_RUN_STORAGE_KEY)),
        cartHasItems: useCartStore.getState().lines.length > 0,
      });
      if (!ok) return;
      markAsked(pathname);
      void ask(null);
    }, ASK_DELAY_MS);
    return () => clearTimeout(t);
  }, [pathname, role, tenantId, nudge, ask]);

  // Eventos puntuales que avisa la app.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const ev = (e as CustomEvent<{ event?: string }>).detail?.event;
      if (ev === "venta_fallida") void ask("venta_fallida");
    };
    window.addEventListener(ONBOARDING_EVENT, onEvent);
    return () => window.removeEventListener(ONBOARDING_EVENT, onEvent);
  }, [ask]);

  if (!nudge) return null;

  const target = ctaTarget(nudge.cta_href);
  const close = () => setNudge(null);
  const record = (event: "clicked" | "dismissed") => {
    if (tenantId) void trackNudgeEvent(tenantId, nudge, event, sessionId(), pathname);
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label="Sugerencia"
      className="fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[45] rounded-md border border-border bg-popover p-4 text-popover-foreground sm:inset-x-auto sm:right-6 sm:w-[340px]"
    >
      <div className="flex items-start gap-3">
        <Lightbulb size={18} className="mt-0.5 shrink-0 text-ninja-flameSoft" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{nudge.title}</p>
          {nudge.body && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{nudge.body}</p>}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar sugerencia"
          className="-m-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            record("dismissed");
            close();
          }}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          No mostrar más
        </button>
        <div className="ml-auto flex gap-2">
          {nudge.support_fallback && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                record("clicked");
                close();
                requestHelpPanel();
              }}
            >
              Pedir ayuda
            </Button>
          )}
          {nudge.cta_label && target && (
            <Button
              size="sm"
              onClick={() => {
                record("clicked");
                close();
                if (target.kind === "tour") requestTour(target.key);
                else router.push(target.href as Route);
              }}
            >
              {nudge.cta_label}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
