// Planificar el reparto entre varios camiones (ADR-164 · H146, L3 de
// ADR-149 §7.4). PURO: sin React ni Supabase, sin red. Es la heurística local
// que se usa siempre que no hay OpenRouteService (o falla):
//   1. Las entregas de un mismo cliente y dirección son una parada.
//   2. Se agrupan por localidad y las localidades se recorren en abanico
//      alrededor del origen (barrido por ángulo), para que cada camión se
//      quede con una zona continua.
//   3. Cada camión recibe su parte según su capacidad en bultos y su tope de
//      paradas; lo que no entra en ningún camión queda sin asignar.
//   4. Cada hoja se ordena con vecino más cercano y 2-opt (orderByProximity)
//      y se estiman km por calle (línea recta por un factor urbano), duración
//      y llegada a cada parada.
import { distanceM, orderByProximity, type LatLng } from "@/lib/logistics/logic";
import { normText } from "@/lib/geo/address";
import type { LatLngTuple, PlannedRoute } from "@/supabase/functions/_shared/routing/core";

export type { LatLngTuple, PlannedRoute } from "@/supabase/functions/_shared/routing/core";

/** Las calles no son línea recta: factor promedio en ciudad. */
export const URBAN_FACTOR = 1.35;

export interface PlanDispatch {
  id: string;
  customerId: string | null;
  /** Clave de la dirección (address_id o el texto en minúsculas). */
  addressKey: string;
  lat: number | null;
  lng: number | null;
  locality: string | null;
  packages: number;
  label: string;
  address: string;
}

export interface PlanStop {
  /** Clave de la parada (cliente + dirección). */
  key: string;
  dispatchIds: string[];
  lat: number | null;
  lng: number | null;
  locality: string | null;
  packages: number;
  label: string;
  address: string;
}

export interface PlanVehicle {
  id: string;
  name: string;
  kind?: string | null;
  capacityPackages: number | null;
  maxStops: number | null;
}

export interface PlanOptions {
  avgSpeedKmh: number;
  serviceMinutes: number;
  returnToOrigin: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = { avgSpeedKmh: 25, serviceMinutes: 5, returnToOrigin: true };

export interface PlanRoute extends PlannedRoute {
  /** Paradas (claves) en orden. */
  stopIds: string[];
  packages: number;
}

export type UnassignedReason = "capacidad" | "sin_camion";

export interface PlanResult {
  routes: PlanRoute[];
  unassigned: { key: string; reason: UnassignedReason }[];
  /** Milisegundos que tardó (el criterio de H146 pide menos de 2 s para 40 entregas). */
  ms: number;
}

/** Junta en una parada las entregas del mismo cliente y la misma dirección. */
export function groupStops(dispatches: readonly PlanDispatch[]): PlanStop[] {
  const map = new Map<string, PlanStop>();
  for (const d of dispatches) {
    const key = `${d.customerId ?? "-"}|${d.addressKey}`;
    const cur = map.get(key);
    if (cur) {
      cur.dispatchIds.push(d.id);
      cur.packages += Math.max(1, d.packages);
      if (cur.lat === null && d.lat !== null) {
        cur.lat = d.lat;
        cur.lng = d.lng;
      }
    } else {
      map.set(key, {
        key,
        dispatchIds: [d.id],
        lat: d.lat,
        lng: d.lng,
        locality: d.locality,
        packages: Math.max(1, d.packages),
        label: d.label,
        address: d.address,
      });
    }
  }
  return [...map.values()];
}

const hasGeo = (s: { lat: number | null; lng: number | null }): s is { lat: number; lng: number } =>
  s.lat !== null && s.lng !== null && Number.isFinite(s.lat) && Number.isFinite(s.lng);

function localityKey(s: PlanStop): string {
  return normText(s.locality ?? "") || "~sin_localidad";
}

/** Ángulo (0 a 2π) de un punto visto desde el origen. */
function angle(origin: LatLng, p: LatLng): number {
  const a = Math.atan2(p.lat - origin.lat, (p.lng - origin.lng) * Math.cos((origin.lat * Math.PI) / 180));
  return a < 0 ? a + 2 * Math.PI : a;
}

/** Km por calle, minutos y llegada a cada parada para un orden dado. */
export function routeMetrics(
  origin: LatLng | null,
  ordered: readonly PlanStop[],
  opts: PlanOptions,
): { distanceM: number; durationS: number; offsets: Record<string, number>; path: LatLngTuple[] } {
  const speed = (Math.max(5, opts.avgSpeedKmh) * 1000) / 3600;
  const service = Math.max(0, opts.serviceMinutes) * 60;
  let prev: LatLng | null = origin;
  let t = 0;
  let dist = 0;
  const offsets: Record<string, number> = {};
  const path: LatLngTuple[] = origin ? [[origin.lat, origin.lng]] : [];
  for (const s of ordered) {
    if (hasGeo(s)) {
      const leg = prev ? (distanceM(prev, s) ?? 0) * URBAN_FACTOR : 0;
      dist += leg;
      t += leg / speed;
      prev = { lat: s.lat, lng: s.lng };
      path.push([s.lat, s.lng]);
    } else {
      // Sin ubicación: un tramo promedio de 2 km para no prometer de más.
      dist += 2000;
      t += 2000 / speed;
    }
    offsets[s.key] = Math.round(t);
    t += service;
  }
  if (opts.returnToOrigin && origin && prev && ordered.length) {
    const back = (distanceM(prev, origin) ?? 0) * URBAN_FACTOR;
    dist += back;
    t += back / speed;
    path.push([origin.lat, origin.lng]);
  }
  return { distanceM: Math.round(dist), durationS: Math.round(t), offsets, path };
}

/** Ordena una hoja (vecino más cercano y 2-opt) y calcula sus números. */
export function buildRoute(vehicleId: string, origin: LatLng | null, stops: readonly PlanStop[], opts: PlanOptions): PlanRoute {
  const order = orderByProximity(
    origin,
    stops.map((s) => ({ id: s.key, lat: s.lat, lng: s.lng, locality: s.locality })),
    opts.returnToOrigin,
  );
  const byKey = new Map(stops.map((s) => [s.key, s]));
  const ordered = order.ids.map((k) => byKey.get(k)!).filter(Boolean);
  return withOrder(vehicleId, origin, ordered, opts);
}

/** Números de una hoja con el orden que ya tiene (después de mover a mano). */
export function withOrder(vehicleId: string, origin: LatLng | null, ordered: readonly PlanStop[], opts: PlanOptions): PlanRoute {
  const m = routeMetrics(origin, ordered, opts);
  return {
    vehicleId,
    stopIds: ordered.map((s) => s.key),
    packages: ordered.reduce((a, s) => a + s.packages, 0),
    ...m,
  };
}

/** Cuánto le entra a un camión (bultos y paradas). Infinity = sin tope. */
function room(v: PlanVehicle): { packages: number; stops: number } {
  return {
    packages: v.capacityPackages && v.capacityPackages > 0 ? v.capacityPackages : Number.POSITIVE_INFINITY,
    stops: v.maxStops && v.maxStops > 0 ? v.maxStops : Number.POSITIVE_INFINITY,
  };
}

/**
 * Reparte las paradas entre los camiones. Devuelve una hoja por camión que
 * recibió algo (en el orden de los camiones) y lo que no entró.
 */
export function planRoutes(
  origin: LatLng | null,
  stops: readonly PlanStop[],
  vehicles: readonly PlanVehicle[],
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
): PlanResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (!vehicles.length) {
    return { routes: [], unassigned: stops.map((s) => ({ key: s.key, reason: "sin_camion" })), ms: 0 };
  }
  // Localidades con su centro y su ángulo desde el origen.
  const groups = new Map<string, PlanStop[]>();
  for (const s of stops) groups.set(localityKey(s), [...(groups.get(localityKey(s)) ?? []), s]);
  const center = (list: PlanStop[]): LatLng | null => {
    const g = list.filter(hasGeo) as (PlanStop & LatLng)[];
    if (!g.length) return null;
    return { lat: g.reduce((a, p) => a + p.lat, 0) / g.length, lng: g.reduce((a, p) => a + p.lng, 0) / g.length };
  };
  const ref = origin ?? center(stops.filter(hasGeo) as PlanStop[]) ?? { lat: 0, lng: 0 };
  const clusters = [...groups.entries()].map(([k, list]) => {
    const c = center(list);
    // Dentro de la localidad, también en abanico (para partirla bien si no entra).
    const sorted = [...list].sort((a, b) => {
      if (!hasGeo(a) || !hasGeo(b)) return hasGeo(a) ? -1 : hasGeo(b) ? 1 : 0;
      return angle(ref, a) - angle(ref, b);
    });
    return { key: k, list: sorted, angle: c ? angle(ref, c) : Number.POSITIVE_INFINITY };
  });
  clusters.sort((a, b) => a.angle - b.angle || a.key.localeCompare(b.key));
  // El barrido arranca en el hueco más grande entre localidades (así no se
  // parte una zona entre el primer y el último camión).
  const withAngle = clusters.filter((c) => Number.isFinite(c.angle));
  if (withAngle.length > 1) {
    let gapAt = 0;
    let gap = -1;
    for (let i = 0; i < withAngle.length; i++) {
      const a = withAngle[i]!.angle;
      const b = i + 1 < withAngle.length ? withAngle[i + 1]!.angle : withAngle[0]!.angle + 2 * Math.PI;
      if (b - a > gap) {
        gap = b - a;
        gapAt = i + 1;
      }
    }
    const rotated = [...withAngle.slice(gapAt), ...withAngle.slice(0, gapAt)];
    clusters.splice(0, withAngle.length, ...rotated);
  }
  const flat = clusters.flatMap((c) => c.list);

  // Parte justa de cada camión según su capacidad (o pareja si no tienen).
  const rooms = vehicles.map(room);
  const totalPk = flat.reduce((a, s) => a + s.packages, 0);
  const finiteCaps = rooms.map((r) => r.packages).filter(Number.isFinite);
  const allFinite = finiteCaps.length === rooms.length;
  const capSum = allFinite ? finiteCaps.reduce((a, b) => a + b, 0) : 0;
  const share = rooms.map((r) =>
    allFinite && capSum > 0 ? Math.min(r.packages, Math.ceil((totalPk * r.packages) / capSum)) : Math.ceil(totalPk / rooms.length),
  );

  const loads = vehicles.map(() => ({ packages: 0, stops: [] as PlanStop[] }));
  const unassigned: { key: string; reason: UnassignedReason }[] = [];
  const fitsHard = (i: number, s: PlanStop) =>
    loads[i]!.packages + s.packages <= rooms[i]!.packages && loads[i]!.stops.length + 1 <= rooms[i]!.stops;
  const place = (i: number, s: PlanStop) => {
    loads[i]!.packages += s.packages;
    loads[i]!.stops.push(s);
  };
  // Barrido: el camión actual se llena hasta su parte y sigue el próximo; lo
  // que sobra va al camión con más lugar libre.
  let vi = 0;
  for (const s of flat) {
    let placed = false;
    for (let i = vi; i < vehicles.length; i++) {
      const fitsShare = loads[i]!.packages + s.packages <= share[i]! || loads[i]!.stops.length === 0;
      if (fitsHard(i, s) && fitsShare) {
        place(i, s);
        vi = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      let best = -1;
      let bestFree = -1;
      for (let i = 0; i < vehicles.length; i++) {
        if (!fitsHard(i, s)) continue;
        const free = rooms[i]!.packages - loads[i]!.packages;
        if (free > bestFree) {
          bestFree = free;
          best = i;
        }
      }
      if (best >= 0) {
        place(best, s);
        placed = true;
      }
    }
    if (!placed) unassigned.push({ key: s.key, reason: "capacidad" });
  }

  const routes = vehicles
    .map((v, i) => (loads[i]!.stops.length ? buildRoute(v.id, origin, loads[i]!.stops, opts) : null))
    .filter((r): r is PlanRoute => r !== null);
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { routes, unassigned, ms: Math.round(t1 - t0) };
}

/** Pasa una parada a otro camión (o la saca del plan con `to = null`) y rehace los dos órdenes. */
export function moveStop(
  plan: PlanResult,
  key: string,
  to: string | null,
  stops: readonly PlanStop[],
  origin: LatLng | null,
  opts: PlanOptions,
): PlanResult {
  const byKey = new Map(stops.map((s) => [s.key, s]));
  const stop = byKey.get(key);
  if (!stop) return plan;
  let routes = plan.routes.map((r) =>
    r.stopIds.includes(key) ? withOrder(r.vehicleId, origin, r.stopIds.filter((k) => k !== key).map((k) => byKey.get(k)!), opts) : r,
  );
  let unassigned = plan.unassigned.filter((u) => u.key !== key);
  if (to === null) {
    unassigned = [...unassigned, { key, reason: "sin_camion" }];
  } else {
    const target = routes.find((r) => r.vehicleId === to);
    const next = [...(target?.stopIds ?? []).map((k) => byKey.get(k)!), stop];
    const built = buildRoute(to, origin, next, opts);
    routes = target ? routes.map((r) => (r.vehicleId === to ? built : r)) : [...routes, built];
  }
  return { ...plan, routes: routes.filter((r) => r.stopIds.length > 0), unassigned };
}

/** Sube o baja una parada dentro de su hoja. */
export function shiftStop(
  plan: PlanResult,
  vehicleId: string,
  key: string,
  dir: -1 | 1,
  stops: readonly PlanStop[],
  origin: LatLng | null,
  opts: PlanOptions,
): PlanResult {
  const byKey = new Map(stops.map((s) => [s.key, s]));
  return {
    ...plan,
    routes: plan.routes.map((r) => {
      if (r.vehicleId !== vehicleId) return r;
      const ids = [...r.stopIds];
      const i = ids.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return r;
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return withOrder(vehicleId, origin, ids.map((k) => byKey.get(k)!), opts);
    }),
  };
}

/** Lo que el panel manda a route_plan_confirm (entregas en el orden de las paradas). */
export function planToConfirm(
  plan: PlanResult,
  stops: readonly PlanStop[],
  drivers: Record<string, string | null>,
): { vehicle_id: string; driver_user_id: string | null; dispatch_ids: string[]; distance_m: number; duration_s: number; path: LatLngTuple[]; offsets: Record<string, number> }[] {
  const byKey = new Map(stops.map((s) => [s.key, s]));
  return plan.routes.map((r) => {
    const offsets: Record<string, number> = {};
    const ids: string[] = [];
    for (const k of r.stopIds) {
      const s = byKey.get(k);
      if (!s) continue;
      for (const d of s.dispatchIds) {
        ids.push(d);
        if (r.offsets[k] !== undefined) offsets[d] = r.offsets[k]!;
      }
    }
    return {
      vehicle_id: r.vehicleId,
      driver_user_id: drivers[r.vehicleId] ?? null,
      dispatch_ids: ids,
      distance_m: r.distanceM,
      duration_s: r.durationS,
      path: r.path,
      offsets,
    };
  });
}

/** Problemas antes de confirmar: camión sin repartidor, sobrecargado o con más paradas que su tope. */
export function planProblems(plan: PlanResult, vehicles: readonly PlanVehicle[], drivers: Record<string, string | null>): string[] {
  const out: string[] = [];
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  for (const r of plan.routes) {
    const v = byId.get(r.vehicleId);
    if (!v) continue;
    if (!drivers[r.vehicleId]) out.push(`${v.name}: elegí el repartidor (si no, la hoja queda en borrador).`);
    if (v.capacityPackages && r.packages > v.capacityPackages) out.push(`${v.name}: lleva ${r.packages} bultos y le entran ${v.capacityPackages}.`);
    if (v.maxStops && r.stopIds.length > v.maxStops) out.push(`${v.name}: ${r.stopIds.length} paradas y su tope es ${v.maxStops}.`);
  }
  return out;
}

/** Color fijo por camión (paleta de la marca, legible en los cuatro temas). */
export const TRUCK_COLORS = ["#f97316", "#3b82f6", "#22c55e", "#a855f7", "#eab308", "#ec4899", "#14b8a6", "#ef4444"] as const;

export function truckColor(i: number): string {
  return TRUCK_COLORS[((i % TRUCK_COLORS.length) + TRUCK_COLORS.length) % TRUCK_COLORS.length]!;
}

/** "1 h 20 min" o "45 min". */
export function formatDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "";
  const m = Math.max(0, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
