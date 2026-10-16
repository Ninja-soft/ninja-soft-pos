"use client";

// Mapa, planificación y seguimiento del reparto (ADR-164 · H146). Lectura por
// RPC con logistics.track (route_live, route_track) y escritura por RPC
// (route_plan_confirm, route_set_path, route_alert_ack,
// route_tracking_settings_save). La Edge `routing` (OpenRouteService) es
// opcional: sin clave, sin cupo o con error, el panel usa la heurística local.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { trackingSettings, type TrackingSettings } from "@/lib/logistics/tracking";
import type { LatLngTuple, PlannedRoute } from "@/supabase/functions/_shared/routing/core";
import type { RouteStatus, StopStatus, VehicleKind } from "@/lib/logistics/logic";
import type { GeoAddress } from "@/lib/geo/address";
import { DISPATCHES_KEY } from "@/modules/orders/hooks";

export interface LiveStop {
  id: string;
  seq: number;
  status: StopStatus;
  lat: number | null;
  lng: number | null;
  contact_name: string | null;
  address_text: string | null;
  locality: string | null;
  planned_offset_s: number | null;
  arrived_at: string | null;
  completed_at: string | null;
  failure_reason_label: string | null;
  dispatches: number;
}

export interface LivePosition {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading: number | null;
  battery: number | null;
  charging: boolean | null;
  recorded_at: string;
  received_at: string;
  off_route_m: number | null;
  off_route_since: string | null;
}

export interface LiveAlert {
  id: string;
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  max_distance_m: number | null;
  lat: number | null;
  lng: number | null;
}

export interface LiveRoute {
  id: string;
  number: number;
  status: RouteStatus;
  store_id: string;
  service_date: string;
  started_at: string | null;
  closed_at: string | null;
  optimize_mode: "manual" | "heuristica" | "ors";
  return_to_origin: boolean;
  planned_distance_m: number | null;
  planned_duration_s: number | null;
  planned_path: LatLngTuple[] | null;
  vehicle: {
    id: string;
    name: string;
    plate: string | null;
    kind: VehicleKind;
    brand: string | null;
    model: string | null;
    color: string | null;
    cover_photo_path: string | null;
    capacity_kg: number | null;
    capacity_packages: number | null;
  } | null;
  driver: { user_id: string; name: string; phone: string | null } | null;
  origin: { id: string; name: string; lat: number | null; lng: number | null } | null;
  last: LivePosition | null;
  alert: LiveAlert | null;
  stops: LiveStop[];
}

export interface PlanCandidate {
  id: string;
  number: number;
  status: string;
  store_id: string;
  fulfillment_store_id: string;
  arrived_at: string | null;
  customer_name: string | null;
  ship_address: string | null;
  ship_to: GeoAddress | null;
  address_id: string | null;
  delivery_attempts: number;
  sale: { number: number; customer_id: string | null } | null;
  items: { qty: number }[];
}

export interface OptimizeRequest {
  origin: { lat: number; lng: number };
  stops: { id: string; lat: number; lng: number; packages: number }[];
  vehicles: { id: string; kind: string | null; capacityPackages: number | null; maxStops: number | null }[];
  serviceS: number;
  returnToOrigin: boolean;
}

export type OptimizeResponse =
  | { provider: "ors"; routes: PlannedRoute[]; unassigned: string[] }
  | { provider: "none"; reason: string };

export interface ConfirmRoute {
  vehicle_id: string;
  driver_user_id: string | null;
  dispatch_ids: string[];
  distance_m: number;
  duration_s: number;
  path: LatLngTuple[];
  offsets: Record<string, number>;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function normalizeLive(raw: unknown): LiveRoute[] {
  return ((raw ?? []) as LiveRoute[]).map((r) => ({
    ...r,
    planned_path: Array.isArray(r.planned_path) ? r.planned_path.map((p) => [Number(p[0]), Number(p[1])] as LatLngTuple) : null,
    last: r.last ? { ...r.last, speed_mps: num(r.last.speed_mps) } : null,
    vehicle: r.vehicle ? { ...r.vehicle, capacity_kg: num(r.vehicle.capacity_kg) } : null,
    stops: r.stops ?? [],
  }));
}

/** ¿La Edge routing tiene OpenRouteService? (sin la Edge desplegada, no). */
async function routingStatus(): Promise<boolean> {
  try {
    const { data, error } = await createClient().functions.invoke("routing", { body: { action: "status" } });
    if (error) return false;
    return Boolean((data as { ors?: boolean } | null)?.ors);
  } catch {
    return false;
  }
}

export const mapApi = {
  live: async (date: string, storeId: string | null): Promise<LiveRoute[]> =>
    normalizeLive(await rpc<unknown>("route_live", { p_date: date, p_store: storeId })),
  track: async (routeId: string): Promise<LatLngTuple[]> => {
    const r = await rpc<{ points: [number, number, number][] }>("route_track", { p_route: routeId, p_max: 1500 });
    return (r.points ?? []).map((p) => [Number(p[0]), Number(p[1])] as LatLngTuple);
  },
  ackAlert: (id: string) => rpc<void>("route_alert_ack", { p_alert: id }),
  trackingSettings: async (): Promise<TrackingSettings> => trackingSettings(await rpc<unknown>("route_tracking_settings_get", {})),
  saveTrackingSettings: async (s: Partial<TrackingSettings>): Promise<TrackingSettings> =>
    trackingSettings(await rpc<unknown>("route_tracking_settings_save", { p: s })),
  planCandidates: async (storeId: string): Promise<PlanCandidate[]> => {
    const { data, error } = await createClient()
      .from("dispatches" as never)
      .select(
        "id, number, status, store_id, fulfillment_store_id, arrived_at, customer_name, ship_address, ship_to, address_id, delivery_attempts, " +
          "sale:sales(number, customer_id), items:dispatch_items(qty)",
      )
      .is("deleted_at", null)
      .is("route_id", null)
      .is("shipment_id", null)
      .eq("delivery_type", "envio")
      .eq("fulfillment_store_id", storeId)
      .in("status", ["pendiente", "armando", "listo"])
      .order("created_at")
      .limit(400);
    if (error) throw error;
    // Las que vienen de otra sucursal entran cuando llegaron (como en route_add_dispatches).
    return ((data ?? []) as unknown as PlanCandidate[])
      .filter((d) => d.store_id === d.fulfillment_store_id || d.arrived_at)
      .map((d) => ({ ...d, items: (d.items ?? []).map((i) => ({ qty: Number(i.qty) })) }));
  },
  routingAvailable: routingStatus,
  optimize: async (req: OptimizeRequest): Promise<OptimizeResponse> => {
    try {
      const { data, error } = await createClient().functions.invoke("routing", { body: { action: "optimize", ...req } });
      if (error || !data) return { provider: "none", reason: "edge_error" };
      const d = data as { ok?: boolean; provider?: string; routes?: PlannedRoute[]; unassigned?: string[]; reason?: string };
      if (d.ok && d.provider === "ors" && Array.isArray(d.routes)) return { provider: "ors", routes: d.routes, unassigned: d.unassigned ?? [] };
      return { provider: "none", reason: d.reason ?? "no_ors" };
    } catch {
      return { provider: "none", reason: "edge_error" };
    }
  },
  directions: async (
    points: LatLngTuple[],
    kind: string | null,
  ): Promise<{ distanceM: number; durationS: number; path: LatLngTuple[]; legs: { distanceM: number; durationS: number }[] } | null> => {
    try {
      const { data, error } = await createClient().functions.invoke("routing", { body: { action: "directions", points, kind } });
      const d = data as { ok?: boolean; provider?: string; distanceM: number; durationS: number; path: LatLngTuple[]; legs: { distanceM: number; durationS: number }[] } | null;
      if (error || !d?.ok || d.provider !== "ors") return null;
      return d;
    } catch {
      return null;
    }
  },
  confirmPlan: (p: {
    store_id: string;
    origin_id: string | null;
    service_date: string;
    mode: "heuristica" | "ors";
    params: Record<string, unknown>;
    routes: ConfirmRoute[];
  }) => rpc<{ plan_id: string; routes: { id: string; number: number; stops: number }[] }>("route_plan_confirm", { p }),
  setPath: (routeId: string, p: { path: LatLngTuple[]; distance_m: number | null; duration_s: number | null; offsets: Record<string, number> }) =>
    rpc<{ ok: boolean; points: number }>("route_set_path", { p_route: routeId, p }),
};

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Mapa en vivo: polling cada 15 s (ADR-149 §11). */
export function useRouteLive(date: string, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["logistics", "live", date, storeId],
    queryFn: () => mapApi.live(date, storeId),
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useRouteTrack(routeId: string | null, live: boolean) {
  return useQuery({
    queryKey: ["logistics", "track", routeId],
    queryFn: () => mapApi.track(routeId!),
    enabled: Boolean(routeId),
    refetchInterval: live ? 30_000 : false,
  });
}

export function useTrackingSettings(enabled = true) {
  return useQuery({ queryKey: ["logistics", "tracking"], queryFn: mapApi.trackingSettings, enabled, staleTime: 5 * 60_000 });
}

export function useRoutingAvailable(enabled = true) {
  return useQuery({ queryKey: ["logistics", "routing-status"], queryFn: mapApi.routingAvailable, enabled, staleTime: 10 * 60_000, retry: 0 });
}

export function usePlanCandidates(storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["logistics", "plan-candidates", storeId],
    queryFn: () => mapApi.planCandidates(storeId!),
    enabled: enabled && Boolean(storeId),
  });
}

export function useMapMutations() {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["logistics"] });
  return {
    ackAlert: useMutation({ mutationFn: mapApi.ackAlert, onSuccess: inv }),
    saveTracking: useMutation({ mutationFn: mapApi.saveTrackingSettings, onSuccess: inv }),
    confirmPlan: useMutation({
      mutationFn: mapApi.confirmPlan,
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
      },
    }),
    setPath: useMutation({
      mutationFn: (v: { routeId: string; p: Parameters<typeof mapApi.setPath>[1] }) => mapApi.setPath(v.routeId, v.p),
      onSuccess: inv,
    }),
  };
}
