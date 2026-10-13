"use client";

// Recorridos guiados y sugerencias del lado del negocio (F15 · H70, H74 ·
// ADR-089). Las RPC y tablas nuevas todavía no están en types/database.ts
// (regen pendiente al aplicar 20261108300000 a 20261108300400): se llaman con
// un cliente sin tipos. Las métricas son "best effort": si fallan, el
// recorrido sigue.
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useMyTenant } from "@/modules/tenants/hooks";
import { parseAvailableTours, type AvailableTour, type TrackEvent } from "@/lib/onboarding/tourEngine";
import { parseShownNudge, type ShownNudge } from "@/lib/onboarding/nudges";

type LooseResult = { data: unknown; error: { message: string } | null };
type Loose = {
  from: (t: string) => { insert: (rows: Record<string, unknown>[]) => PromiseLike<LooseResult> };
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<LooseResult>;
};
const loose = () => createClient() as unknown as Loose;

export const TOURS_QUERY_KEY = ["onboarding-tours"] as const;

export function useToursForMe(enabled = true) {
  const { data: tenant } = useMyTenant();
  return useQuery({
    queryKey: [...TOURS_QUERY_KEY, tenant?.tenantId],
    enabled: enabled && Boolean(tenant?.tenantId),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<AvailableTour[]> => {
      const { data, error } = await loose().rpc("tours_for_me");
      // Sin la migración aplicada no hay recorridos: no es un error para el usuario.
      if (error) return [];
      return parseAvailableTours(data);
    },
  });
}

export async function trackTourEvents(
  tenantId: string,
  t: { tourId: string; version: number; runId: string },
  events: TrackEvent[],
  route: string,
): Promise<void> {
  if (!events.length) return;
  const user = await getCurrentUser();
  if (!user) return;
  // Insert multi-fila: todas las claves en cada fila (PostgREST).
  const rows = events.map((e) => ({
    tenant_id: tenantId,
    user_id: user.id,
    tour_id: t.tourId,
    tour_version: t.version,
    run_id: t.runId,
    event: e.event,
    step_index: "step_index" in e ? e.step_index : null,
    route: route.slice(0, 200),
  }));
  try {
    await loose().from("onboarding_tour_events").insert(rows);
  } catch {
    /* métricas best effort */
  }
}

export async function fetchNextNudge(args: {
  event: string | null;
  session: string;
  route: string;
}): Promise<ShownNudge | null> {
  try {
    const { data, error } = await loose().rpc("nudge_next", {
      p_event: args.event,
      p_session: args.session,
      p_route: args.route.slice(0, 200),
    });
    if (error) return null;
    return parseShownNudge(data);
  } catch {
    return null;
  }
}

export async function trackNudgeEvent(
  tenantId: string,
  n: { nudge_id: string; version: number },
  event: "clicked" | "dismissed",
  session: string,
  route: string,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  try {
    await loose()
      .from("onboarding_nudge_events")
      .insert([
        {
          tenant_id: tenantId,
          user_id: user.id,
          nudge_id: n.nudge_id,
          nudge_version: n.version,
          event,
          session_id: session,
          route: route.slice(0, 200),
        },
      ]);
  } catch {
    /* best effort */
  }
}

// ── Eventos entre componentes (sin estado global) ──────────────────────────

export const TOUR_START_EVENT = "ninja:tour-start";
export const ONBOARDING_EVENT = "ninja:onboarding-event";
export const HELP_OPEN_EVENT = "ninja:help-open";

/** Abre un recorrido por clave (desde Ayuda o una sugerencia). */
export function requestTour(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { key } }));
}

/** Avisa un evento puntual (p. ej. venta fallida) para las sugerencias. */
export function emitOnboardingEvent(event: "venta_fallida"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT, { detail: { event } }));
}

export function requestHelpPanel(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT));
}
