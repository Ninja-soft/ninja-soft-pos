// =============================================================================
// _shared/routing/core.ts (ADR-164 · F22 · H146)
//
// Lógica pura de la Edge `routing` (OpenRouteService, opcional): armar el
// pedido de optimización (VROOM) y de trazado por calles, y pasar sus
// respuestas a hojas con paradas en orden, km, duración, llegada estimada y
// recorrido [[lat, lng]]. Sin Deno.* ni fetch: la usan la Edge, el panel y los
// tests de Vitest. ORS usa [lng, lat]; todo lo nuestro es [lat, lng].
// =============================================================================

export type LatLngTuple = [number, number];

/** Cupos por negocio de la Edge routing (sólo los pedidos que llegan a ORS). */
export const ROUTING_LIMITS = {
  optimize: { perMinute: 10, perDay: 100 },
  directions: { perMinute: 20, perDay: 400 },
} as const;

/** Topes del plan gratuito de ORS que respetamos antes de llamar. */
export const ORS_MAX_JOBS = 150;
export const ORS_MAX_VEHICLES = 20;
export const ORS_MAX_WAYPOINTS = 50;

export const ORS_BASE = "https://api.openrouteservice.org";

export interface PlanStopInput {
  id: string;
  lat: number;
  lng: number;
  /** Bultos de la parada (capacidad del camión). */
  packages: number;
}

export interface PlanVehicleInput {
  id: string;
  /** moto, auto, utilitario, camion... (camión usa el perfil de vehículo pesado). */
  kind?: string | null;
  capacityPackages?: number | null;
  maxStops?: number | null;
}

export interface OptimizeInput {
  origin: { lat: number; lng: number };
  stops: PlanStopInput[];
  vehicles: PlanVehicleInput[];
  /** Minutos que se queda en cada parada. */
  serviceS: number;
  returnToOrigin: boolean;
}

export interface PlannedRoute {
  vehicleId: string;
  /** Paradas en el orden en que se visitan. */
  stopIds: string[];
  distanceM: number;
  durationS: number;
  /** Segundos desde la salida hasta llegar a cada parada. */
  offsets: Record<string, number>;
  /** Recorrido [[lat, lng], ...]; vacío si el proveedor no lo dio. */
  path: LatLngTuple[];
}

export interface OptimizeResult {
  routes: PlannedRoute[];
  unassigned: string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validPoint(lat: unknown, lng: unknown): boolean {
  return finite(lat) && finite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/** Perfil de ORS según el vehículo. */
export function orsProfile(kind: string | null | undefined): "driving-car" | "driving-hgv" | "cycling-regular" | "foot-walking" {
  if (kind === "camion") return "driving-hgv";
  if (kind === "bici") return "cycling-regular";
  if (kind === "a_pie") return "foot-walking";
  return "driving-car";
}

/**
 * Pedido de optimización (VROOM de ORS). VROOM pide ids enteros: devolvemos
 * las tablas para traducir la respuesta.
 */
export function buildOptimizationBody(input: OptimizeInput): {
  body: Record<string, unknown>;
  jobIds: string[];
  vehicleIds: string[];
} {
  const start: [number, number] = [input.origin.lng, input.origin.lat];
  const jobIds = input.stops.map((s) => s.id);
  const vehicleIds = input.vehicles.map((v) => v.id);
  const service = Math.max(0, Math.round(input.serviceS));
  const jobs = input.stops.map((s, i) => ({
    id: i + 1,
    location: [s.lng, s.lat],
    amount: [Math.max(1, Math.round(s.packages))],
    service,
  }));
  const vehicles = input.vehicles.map((v, i) => {
    const out: Record<string, unknown> = {
      id: i + 1,
      profile: orsProfile(v.kind),
      start,
      capacity: [v.capacityPackages && v.capacityPackages > 0 ? Math.round(v.capacityPackages) : 100000],
    };
    if (input.returnToOrigin) out.end = start;
    if (v.maxStops && v.maxStops > 0) out.max_tasks = Math.round(v.maxStops);
    return out;
  });
  return { body: { jobs, vehicles, options: { g: true } }, jobIds, vehicleIds };
}

/** Polyline codificada (Google, precisión 5 por defecto) a [[lat, lng], ...]. */
export function decodePolyline(str: string, precision = 5): LatLngTuple[] {
  const out: LatLngTuple[] = [];
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lng = 0;
  // Un número: grupos de 5 bits con el bit 0x20 de "sigue". Fuera del texto
  // charCodeAt da NaN y corta (texto roto no cuelga).
  const next = (): number => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < str.length) {
    lat += next();
    if (index > str.length) break;
    lng += next();
    if (index > str.length) break;
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

/** Codifica [[lat, lng], ...] (para los tests y para mandar recorridos cortos). */
export function encodePolyline(points: readonly LatLngTuple[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = "";
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [la, ln] of points) {
    const lat = Math.round(la * factor);
    const lng = Math.round(ln * factor);
    out += enc(lat - prevLat) + enc(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

/** Metros entre dos puntos en un plano local (alcanza dentro de una ciudad). */
function planar(a: LatLngTuple, b: LatLngTuple, k: number): [number, number] {
  return [(b[1] - a[1]) * k, (b[0] - a[0]) * 110574];
}

/** Douglas-Peucker en metros: menos puntos con la misma forma. */
export function simplifyPath(points: readonly LatLngTuple[], toleranceM = 8, maxPoints = 2000): LatLngTuple[] {
  if (points.length <= 2) return [...points];
  const k = Math.cos((points[0]![0] * Math.PI) / 180) * 111320;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = points[s]!;
    const [bx, by] = planar(a, points[e]!, k);
    const len2 = bx * bx + by * by;
    let best = -1;
    let bestD = 0;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = planar(a, points[i]!, k);
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
      const dx = px - t * bx;
      const dy = py - t * by;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0 && bestD > toleranceM) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  let out = points.filter((_, i) => keep[i] === 1);
  if (out.length > maxPoints) {
    const step = Math.ceil(out.length / maxPoints);
    out = out.filter((_, i) => i % step === 0 || i === out.length - 1);
  }
  return out;
}

interface VroomStep {
  type?: string;
  id?: number;
  job?: number;
  arrival?: number;
  location?: [number, number];
}
interface VroomRoute {
  vehicle?: number;
  steps?: VroomStep[];
  distance?: number;
  duration?: number;
  service?: number;
  geometry?: string;
}

/** Respuesta de VROOM a hojas con nuestros ids. */
export function parseOptimization(raw: unknown, jobIds: readonly string[], vehicleIds: readonly string[]): OptimizeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { routes?: VroomRoute[]; unassigned?: { id?: number; job?: number }[] };
  if (!Array.isArray(r.routes)) return null;
  const routes: PlannedRoute[] = [];
  for (const route of r.routes) {
    const vehicleId = vehicleIds[(route.vehicle ?? 0) - 1];
    if (!vehicleId) continue;
    const stopIds: string[] = [];
    const offsets: Record<string, number> = {};
    for (const step of route.steps ?? []) {
      if (step.type !== "job") continue;
      const id = jobIds[(step.id ?? step.job ?? 0) - 1];
      if (!id) continue;
      stopIds.push(id);
      offsets[id] = Math.max(0, Math.round(step.arrival ?? 0));
    }
    if (!stopIds.length) continue;
    const path = typeof route.geometry === "string" && route.geometry ? simplifyPath(decodePolyline(route.geometry)) : [];
    routes.push({
      vehicleId,
      stopIds,
      distanceM: Math.max(0, Math.round(route.distance ?? 0)),
      durationS: Math.max(0, Math.round((route.duration ?? 0) + (route.service ?? 0))),
      offsets,
      path,
    });
  }
  const unassigned = (r.unassigned ?? [])
    .map((u) => jobIds[(u.id ?? u.job ?? 0) - 1])
    .filter((x): x is string => Boolean(x));
  return { routes, unassigned };
}

/** Pedido de trazado por calles (Directions de ORS, GeoJSON). */
export function buildDirectionsBody(points: readonly LatLngTuple[]): Record<string, unknown> {
  return {
    coordinates: points.map(([lat, lng]) => [lng, lat]),
    instructions: false,
    preference: "recommended",
  };
}

export interface DirectionsResult {
  distanceM: number;
  durationS: number;
  path: LatLngTuple[];
  /** Por tramo (entre un punto y el siguiente). */
  legs: { distanceM: number; durationS: number }[];
}

export function parseDirections(raw: unknown): DirectionsResult | null {
  const f = (raw as { features?: unknown[] } | null)?.features?.[0] as
    | {
        geometry?: { coordinates?: [number, number][] };
        properties?: { summary?: { distance?: number; duration?: number }; segments?: { distance?: number; duration?: number }[] };
      }
    | undefined;
  const coords = f?.geometry?.coordinates;
  if (!f || !Array.isArray(coords) || coords.length < 2) return null;
  const path = simplifyPath(coords.filter((c) => validPoint(c[1], c[0])).map(([lng, lat]) => [lat, lng] as LatLngTuple));
  return {
    distanceM: Math.round(f.properties?.summary?.distance ?? 0),
    durationS: Math.round(f.properties?.summary?.duration ?? 0),
    path,
    legs: (f.properties?.segments ?? []).map((s) => ({ distanceM: Math.round(s.distance ?? 0), durationS: Math.round(s.duration ?? 0) })),
  };
}

/** Valida lo que manda el panel para optimizar. null = pedido inválido. */
export function optimizeInputFromBody(v: unknown): OptimizeInput | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const o = b.origin as { lat?: unknown; lng?: unknown } | undefined;
  if (!o || !validPoint(o.lat, o.lng)) return null;
  const stops = Array.isArray(b.stops) ? b.stops : [];
  const vehicles = Array.isArray(b.vehicles) ? b.vehicles : [];
  if (!stops.length || stops.length > ORS_MAX_JOBS || !vehicles.length || vehicles.length > ORS_MAX_VEHICLES) return null;
  const cleanStops: PlanStopInput[] = [];
  for (const s of stops) {
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || x.id.length > 80 || !validPoint(x.lat, x.lng)) return null;
    cleanStops.push({ id: x.id, lat: x.lat as number, lng: x.lng as number, packages: finite(x.packages) ? Math.max(1, x.packages) : 1 });
  }
  const cleanVehicles: PlanVehicleInput[] = [];
  for (const s of vehicles) {
    const x = s as Record<string, unknown>;
    if (typeof x.id !== "string" || x.id.length > 80) return null;
    cleanVehicles.push({
      id: x.id,
      kind: typeof x.kind === "string" ? x.kind : null,
      capacityPackages: finite(x.capacityPackages) ? x.capacityPackages : null,
      maxStops: finite(x.maxStops) ? x.maxStops : null,
    });
  }
  return {
    origin: { lat: o.lat as number, lng: o.lng as number },
    stops: cleanStops,
    vehicles: cleanVehicles,
    serviceS: finite(b.serviceS) ? Math.min(3600, Math.max(0, b.serviceS)) : 300,
    returnToOrigin: b.returnToOrigin !== false,
  };
}
