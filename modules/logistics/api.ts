"use client";

// Reparto propio (ADR-161 · H145): flota, repartidores, orígenes, hojas de
// ruta y configuración de Logística. Lectura por tabla con RLS (logistics.view)
// o por RPC (detalle de la hoja, repartidores) y toda escritura por RPC
// SECURITY DEFINER. Fotos en el bucket privado logistics-media con URL
// firmada. Las tablas nuevas no están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";
import {
  logisticsSettings,
  type FailureReason,
  type LogisticsSettings,
  type RouteStatus,
  type StopStatus,
  type VehicleKind,
  type VehicleStatus,
} from "@/lib/logistics/logic";
import type { GeoAddress } from "@/lib/geo/address";
import { capabilityAllowed, type BaseRole } from "@/lib/permissions/capabilities";
import { useMyCapabilities } from "@/modules/permissions/hooks";
import { useMyTenant } from "@/modules/tenants/hooks";
import { DISPATCHES_KEY } from "@/modules/orders/hooks";

export const LOGISTICS_BUCKET = "logistics-media";

export interface VehiclePhoto {
  id: string;
  path: string;
  kind: "frente" | "lateral" | "carga" | "documento" | "otro";
  caption: string | null;
  sort: number;
  deleted_at: string | null;
}

export interface Vehicle {
  id: string;
  home_store_id: string | null;
  name: string;
  kind: VehicleKind;
  plate: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  capacity_kg: number | null;
  capacity_m3: number | null;
  capacity_packages: number | null;
  max_stops: number | null;
  carrier_name: string | null;
  carrier_cuit: string | null;
  trailer_plate: string | null;
  insurance_until: string | null;
  vtv_until: string | null;
  senasa_until: string | null;
  status: VehicleStatus;
  default_driver_user_id: string | null;
  cover_photo_path: string | null;
  notes: string | null;
  created_at: string;
  photos: VehiclePhoto[];
}

export interface DriverProfile {
  id: string;
  user_id: string;
  phone: string | null;
  license_number: string | null;
  license_class: string | null;
  license_until: string | null;
  default_vehicle_id: string | null;
  active: boolean;
  notes: string | null;
}

export interface DriverRow {
  user_id: string;
  name: string;
  email: string | null;
  base_role: BaseRole;
  is_driver_role: boolean;
  role_name: string;
  profile: DriverProfile | null;
  active_routes: number;
}

export interface LogisticsOrigin {
  id: string;
  store_id: string;
  warehouse_id: string | null;
  name: string;
  address: GeoAddress | null;
  address_text: string | null;
  lat: number | null;
  lng: number | null;
  loading_hours: string | null;
  is_default: boolean;
}

export interface RouteRow {
  id: string;
  number: number;
  store_id: string;
  origin_id: string | null;
  service_date: string;
  vehicle_id: string | null;
  driver_user_id: string | null;
  helper_user_id: string | null;
  status: RouteStatus;
  optimize_mode: "manual" | "heuristica";
  planned_distance_m: number | null;
  started_at: string | null;
  closed_at: string | null;
  summary: { stops: number; delivered: number; failed: number; skipped: number } | null;
  notes: string | null;
  vehicle: { name: string; plate: string | null; kind: VehicleKind } | null;
  stops: { id: string; status: StopStatus; deleted_at: string | null }[];
}

export interface RouteItem {
  name: string;
  qty: number;
  unit: string | null;
  sku: string | null;
}

export interface RouteDispatch {
  id: string;
  number: number;
  status: string;
  outcome: "pendiente" | "entregado" | "no_entregado" | "quitado";
  customer_name: string | null;
  notes: string | null;
  sale_number: number | null;
  items: RouteItem[];
  remito: { id: string; pto_vta: number; number: number; cot_number: string | null; signed_copy_path: string | null } | null;
}

export interface RouteEvent {
  id: string;
  type: "entregado" | "no_entregado";
  occurred_at: string;
  reason_label: string | null;
  note: string | null;
  lat: number | null;
  lng: number | null;
  distance_to_stop_m: number | null;
  photo_paths: string[];
  signature_path: string | null;
  remito_photo_path: string | null;
  received_by_name: string | null;
  received_by_doc: string | null;
}

export interface RouteStop {
  id: string;
  seq: number;
  kind: string;
  status: StopStatus;
  customer_id: string | null;
  address_text: string | null;
  ship_to: GeoAddress | null;
  lat: number | null;
  lng: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  failure_reason_label: string | null;
  dispatches: RouteDispatch[];
  last_event: RouteEvent | null;
}

export interface RouteDetail {
  route: Omit<RouteRow, "vehicle" | "stops"> & { return_to_origin: boolean; load_checked_at: string | null };
  store: { id: string; name: string; address: string | null } | null;
  origin: { id: string; name: string; address_text: string | null; lat: number | null; lng: number | null } | null;
  vehicle: {
    id: string;
    name: string;
    plate: string | null;
    kind: VehicleKind;
    brand: string | null;
    model: string | null;
    cover_photo_path: string | null;
    capacity_kg: number | null;
    capacity_packages: number | null;
  } | null;
  driver: { user_id: string; name: string } | null;
  helper: { user_id: string; name: string } | null;
  settings: LogisticsSettings;
  stops: RouteStop[];
}

export interface RouteCandidate {
  id: string;
  number: number;
  status: string;
  customer_name: string | null;
  ship_address: string | null;
  ship_to: GeoAddress | null;
  delivery_attempts: number;
  last_failure_reason: string | null;
  created_at: string;
  sale: { number: number } | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function normalizeVehicle(v: Vehicle): Vehicle {
  return {
    ...v,
    capacity_kg: n(v.capacity_kg),
    capacity_m3: n(v.capacity_m3),
    photos: [...(v.photos ?? [])].filter((p) => !p.deleted_at).sort((a, b) => a.sort - b.sort),
  };
}

export function normalizeRouteDetail(raw: unknown): RouteDetail {
  const d = raw as RouteDetail & { settings: unknown };
  return {
    ...d,
    settings: logisticsSettings(d.settings),
    stops: (d.stops ?? []).map((s) => ({
      ...s,
      dispatches: (s.dispatches ?? []).map((x) => ({ ...x, items: (x.items ?? []).map((i) => ({ ...i, qty: Number(i.qty) })) })),
    })),
  };
}

export const logisticsApi = {
  settings: async (): Promise<LogisticsSettings> => logisticsSettings(await rpc<unknown>("logistics_settings_get", {})),
  saveSettings: async (s: Partial<LogisticsSettings>): Promise<LogisticsSettings> =>
    logisticsSettings(await rpc<unknown>("logistics_settings_save", { p: s })),

  vehicles: async (): Promise<Vehicle[]> => {
    const { data, error } = await createClient()
      .from("vehicles" as never)
      .select("*, photos:vehicle_photos(id, path, kind, caption, sort, deleted_at)")
      .is("deleted_at", null)
      .order("name");
    if (error) throw error;
    return ((data ?? []) as unknown as Vehicle[]).map(normalizeVehicle);
  },
  saveVehicle: (id: string | null, p: Record<string, unknown>) => rpc<Vehicle>("vehicle_save", { p_id: id, p }),
  deleteVehicle: (id: string) => rpc<void>("vehicle_delete", { p_id: id }),
  addVehiclePhoto: async (tenantId: string, vehicleId: string, file: File, kind: VehiclePhoto["kind"]) => {
    const blob = await resizeToWebp(file, 1400, 0.82);
    const path = `${tenantId}/vehicles/${vehicleId}/${crypto.randomUUID()}.webp`;
    const up = await createClient().storage.from(LOGISTICS_BUCKET).upload(path, blob, { contentType: "image/webp", upsert: false });
    if (up.error) throw new Error("photo_upload_failed");
    return rpc<VehiclePhoto>("vehicle_photo_add", { p_vehicle: vehicleId, p_path: path, p_kind: kind, p_caption: null });
  },
  setVehiclePhoto: (photoId: string, action: "cover" | "delete") => rpc<void>("vehicle_photo_set", { p_photo: photoId, p_action: action }),

  drivers: async (): Promise<DriverRow[]> => rpc<DriverRow[]>("logistics_drivers", {}),
  saveDriverProfile: (userId: string, p: Record<string, unknown>) => rpc<DriverProfile>("driver_profile_save", { p_user: userId, p }),

  origins: async (): Promise<LogisticsOrigin[]> => {
    const { data, error } = await createClient()
      .from("logistics_origins" as never)
      .select("id, store_id, warehouse_id, name, address, address_text, lat, lng, loading_hours, is_default")
      .is("deleted_at", null)
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as LogisticsOrigin[];
  },
  saveOrigin: (id: string | null, p: Record<string, unknown>) => rpc<LogisticsOrigin>("logistics_origin_save", { p_id: id, p }),
  deleteOrigin: (id: string) => rpc<void>("logistics_origin_delete", { p_id: id }),

  routes: async (opts: { from: string; to: string; storeId: string | null }): Promise<RouteRow[]> => {
    let q = createClient()
      .from("delivery_routes" as never)
      .select(
        "id, number, store_id, origin_id, service_date, vehicle_id, driver_user_id, helper_user_id, status, optimize_mode, " +
          "planned_distance_m, started_at, closed_at, summary, notes, vehicle:vehicles(name, plate, kind), stops:route_stops(id, status, deleted_at)",
      )
      .is("deleted_at", null)
      .gte("service_date", opts.from)
      .lte("service_date", opts.to)
      .order("service_date", { ascending: false })
      .order("number", { ascending: false })
      .limit(200);
    if (opts.storeId) q = q.eq("store_id", opts.storeId);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as RouteRow[]).map((r) => ({ ...r, stops: (r.stops ?? []).filter((s) => !s.deleted_at) }));
  },
  routeDetail: async (id: string): Promise<RouteDetail> => normalizeRouteDetail(await rpc<unknown>("route_detail", { p_route: id })),
  candidates: async (storeId: string): Promise<RouteCandidate[]> => {
    const { data, error } = await createClient()
      .from("dispatches" as never)
      .select("id, number, status, customer_name, ship_address, ship_to, delivery_attempts, last_failure_reason, created_at, sale:sales(number)")
      .is("deleted_at", null)
      .is("route_id", null)
      .is("shipment_id", null)
      .eq("delivery_type", "envio")
      .eq("fulfillment_store_id", storeId)
      .in("status", ["pendiente", "armando", "listo"])
      .order("created_at")
      .limit(300);
    if (error) throw error;
    return (data ?? []) as unknown as RouteCandidate[];
  },
  saveRoute: (id: string | null, p: Record<string, unknown>) => rpc<RouteRow>("delivery_route_save", { p_id: id, p }),
  addDispatches: (routeId: string, ids: string[]) =>
    rpc<{ added: number; stops: number }>("route_add_dispatches", { p_route: routeId, p_dispatch_ids: ids }),
  removeStop: (stopId: string) => rpc<void>("route_remove_stop", { p_stop: stopId }),
  reorder: (routeId: string, ids: string[], mode: "manual" | "heuristica", distanceM: number | null) =>
    rpc<void>("route_reorder", { p_route: routeId, p_stop_ids: ids, p_mode: mode, p_distance_m: distanceM }),
  setStatus: (routeId: string, to: RouteStatus) => rpc<void>("route_set_status", { p_route: routeId, p_to: to }),
  cancel: (routeId: string, reason: string) => rpc<void>("route_cancel", { p_route: routeId, p_reason: reason }),

  signedUrl: async (path: string): Promise<string | null> => {
    const { data } = await createClient().storage.from(LOGISTICS_BUCKET).createSignedUrl(path, 600);
    return data?.signedUrl ?? null;
  },
};

// ── Hooks ───────────────────────────────────────────────────────────────────

/** ¿Puede? Capacidades efectivas del servidor (mientras cargan, las del rol). */
export function useCan(cap: string): boolean {
  const { data: me } = useMyTenant();
  const { data: caps } = useMyCapabilities(Boolean(me));
  return capabilityAllowed(caps?.base ?? (me?.role as BaseRole | undefined) ?? null, caps?.capabilities ?? null, cap);
}

export function useLogisticsSettings(enabled = true) {
  return useQuery({ queryKey: ["logistics", "settings"], queryFn: logisticsApi.settings, enabled, staleTime: 60_000 });
}

export function useVehicles(enabled = true) {
  return useQuery({ queryKey: ["logistics", "vehicles"], queryFn: logisticsApi.vehicles, enabled });
}

export function useDrivers(enabled = true) {
  return useQuery({ queryKey: ["logistics", "drivers"], queryFn: logisticsApi.drivers, enabled, staleTime: 30_000 });
}

export function useOrigins(enabled = true) {
  return useQuery({ queryKey: ["logistics", "origins"], queryFn: logisticsApi.origins, enabled });
}

export function useRoutes(opts: { from: string; to: string; storeId: string | null }, enabled = true) {
  return useQuery({ queryKey: ["logistics", "routes", opts], queryFn: () => logisticsApi.routes(opts), enabled, refetchInterval: 30_000 });
}

export function useRouteDetail(id: string | null) {
  return useQuery({
    queryKey: ["logistics", "route", id],
    queryFn: () => logisticsApi.routeDetail(id!),
    enabled: Boolean(id),
    refetchInterval: 20_000,
  });
}

export function useRouteCandidates(storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["logistics", "candidates", storeId],
    queryFn: () => logisticsApi.candidates(storeId!),
    enabled: enabled && Boolean(storeId),
  });
}

/** URL firmada (10 minutos) de una foto del bucket logistics-media. */
export function useSignedUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["logistics", "signed", path],
    queryFn: () => logisticsApi.signedUrl(path!),
    enabled: Boolean(path),
    staleTime: 8 * 60_000,
    gcTime: 9 * 60_000,
  });
}

export function useLogisticsMutations() {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: ["logistics"] });
  const invAll = () => {
    inv();
    void qc.invalidateQueries({ queryKey: DISPATCHES_KEY });
    void qc.invalidateQueries({ queryKey: ["remitos"] });
  };
  return {
    saveSettings: useMutation({ mutationFn: logisticsApi.saveSettings, onSuccess: inv }),
    saveVehicle: useMutation({ mutationFn: (v: { id: string | null; p: Record<string, unknown> }) => logisticsApi.saveVehicle(v.id, v.p), onSuccess: inv }),
    deleteVehicle: useMutation({ mutationFn: logisticsApi.deleteVehicle, onSuccess: inv }),
    addVehiclePhoto: useMutation({
      mutationFn: (v: { tenantId: string; vehicleId: string; file: File; kind: VehiclePhoto["kind"] }) =>
        logisticsApi.addVehiclePhoto(v.tenantId, v.vehicleId, v.file, v.kind),
      onSuccess: inv,
    }),
    setVehiclePhoto: useMutation({ mutationFn: (v: { id: string; action: "cover" | "delete" }) => logisticsApi.setVehiclePhoto(v.id, v.action), onSuccess: inv }),
    saveDriverProfile: useMutation({
      mutationFn: (v: { userId: string; p: Record<string, unknown> }) => logisticsApi.saveDriverProfile(v.userId, v.p),
      onSuccess: inv,
    }),
    saveOrigin: useMutation({ mutationFn: (v: { id: string | null; p: Record<string, unknown> }) => logisticsApi.saveOrigin(v.id, v.p), onSuccess: inv }),
    deleteOrigin: useMutation({ mutationFn: logisticsApi.deleteOrigin, onSuccess: inv }),
    saveRoute: useMutation({ mutationFn: (v: { id: string | null; p: Record<string, unknown> }) => logisticsApi.saveRoute(v.id, v.p), onSuccess: invAll }),
    addDispatches: useMutation({ mutationFn: (v: { routeId: string; ids: string[] }) => logisticsApi.addDispatches(v.routeId, v.ids), onSuccess: invAll }),
    removeStop: useMutation({ mutationFn: logisticsApi.removeStop, onSuccess: invAll }),
    reorder: useMutation({
      mutationFn: (v: { routeId: string; ids: string[]; mode: "manual" | "heuristica"; distanceM: number | null }) =>
        logisticsApi.reorder(v.routeId, v.ids, v.mode, v.distanceM),
      onSuccess: inv,
    }),
    setStatus: useMutation({ mutationFn: (v: { routeId: string; to: RouteStatus }) => logisticsApi.setStatus(v.routeId, v.to), onSuccess: invAll }),
    cancel: useMutation({ mutationFn: (v: { routeId: string; reason: string }) => logisticsApi.cancel(v.routeId, v.reason), onSuccess: invAll }),
  };
}

export type { FailureReason };
