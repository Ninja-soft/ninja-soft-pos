// Seguimiento del camión (ADR-164 · H146). PURO: sin React ni Supabase.
// Configuración, cuándo guardar una posición, el lote que se manda, la
// distancia al recorrido planificado (espejo de _path_distance_m), el estado
// del desvío (espejo de route_positions_push), la llegada estimada y textos.
import { distanceM, type LatLng } from "@/lib/logistics/logic";
import type { LatLngTuple } from "@/supabase/functions/_shared/routing/core";

// -----------------------------------------------------------------------------
// Configuración (espejo de _route_tracking_cfg)
// -----------------------------------------------------------------------------
export interface TrackingSettings {
  enabled: boolean;
  interval_s: number;
  min_move_m: number;
  deviation_m: number;
  deviation_minutes: number;
  retention_days: number;
  avg_speed_kmh: number;
  service_minutes: number;
  saved: boolean;
}

export const DEFAULT_TRACKING: TrackingSettings = {
  enabled: true,
  interval_s: 30,
  min_move_m: 50,
  deviation_m: 600,
  deviation_minutes: 5,
  retention_days: 90,
  avg_speed_kmh: 25,
  service_minutes: 5,
  saved: false,
};

const RANGES: Record<Exclude<keyof TrackingSettings, "enabled" | "saved">, [number, number]> = {
  interval_s: [10, 120],
  min_move_m: [10, 1000],
  deviation_m: [100, 5000],
  deviation_minutes: [1, 60],
  retention_days: [7, 365],
  avg_speed_kmh: [5, 90],
  service_minutes: [0, 60],
};

export function trackingSettings(raw: unknown): TrackingSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_TRACKING };
  for (const [k, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const v = typeof r[k] === "number" ? (r[k] as number) : typeof r[k] === "string" ? Number(r[k]) : Number.NaN;
    if (Number.isFinite(v)) out[k] = Math.round(Math.min(max, Math.max(min, v)));
  }
  out.enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  out.saved = r.saved === true;
  return out;
}

export function trackingRange(k: keyof typeof RANGES): [number, number] {
  return RANGES[k];
}

// -----------------------------------------------------------------------------
// Cuándo guardar una posición y el lote
// -----------------------------------------------------------------------------
export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  /** ms desde 1970 (hora del teléfono). */
  at: number;
}

/** Quieto se manda igual cada 2 minutos (para saber que sigue ahí). */
export const STILL_INTERVAL_S = 120;
/** Peor precisión que esto no se guarda (el GPS todavía no enganchó). */
export const MAX_ACCURACY_M = 500;

/**
 * ¿Se guarda esta posición? En movimiento, cada `interval_s` si se movió al
 * menos `min_move_m`; quieto, cada 2 minutos. Mala precisión, nunca.
 */
export function shouldRecord(last: Fix | null, cur: Fix, cfg: Pick<TrackingSettings, "interval_s" | "min_move_m">): boolean {
  if (cur.accuracy !== null && cur.accuracy > MAX_ACCURACY_M) return false;
  if (!last) return true;
  const elapsed = (cur.at - last.at) / 1000;
  if (elapsed < cfg.interval_s) return false;
  const moved = distanceM(last, cur) ?? 0;
  return moved >= cfg.min_move_m || elapsed >= STILL_INTERVAL_S;
}

export interface QueuedPosition {
  id: string;
  t: string;
  lat: number;
  lng: number;
  acc: number | null;
  spd: number | null;
  hdg: number | null;
  bat: number | null;
  chg: boolean | null;
  dev: string | null;
}

/** Tope de posiciones guardadas sin señal (unas 8 horas a 30 s). Se tiran las más viejas. */
export const MAX_BUFFER = 1000;
/** Lote máximo por pedido (route_positions_push acepta 300). */
export const BATCH_SIZE = 200;

export function bufferAdd(buf: readonly QueuedPosition[], p: QueuedPosition, max = MAX_BUFFER): QueuedPosition[] {
  const next = [...buf, p];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Saca del lote lo que el servidor ya recibió. */
export function bufferAck(buf: readonly QueuedPosition[], sent: readonly QueuedPosition[]): QueuedPosition[] {
  const ids = new Set(sent.map((p) => p.id));
  return buf.filter((p) => !ids.has(p.id));
}

export function toQueued(f: Fix, id: string, battery: { level: number; charging: boolean } | null, device: string | null): QueuedPosition {
  return {
    id,
    t: new Date(f.at).toISOString(),
    lat: Math.round(f.lat * 1e6) / 1e6,
    lng: Math.round(f.lng * 1e6) / 1e6,
    acc: f.accuracy === null ? null : Math.round(f.accuracy),
    spd: f.speed === null || !Number.isFinite(f.speed) || f.speed < 0 ? null : Math.round(f.speed * 100) / 100,
    hdg: f.heading === null || !Number.isFinite(f.heading) ? null : Math.round(f.heading),
    bat: battery ? Math.round(battery.level * 100) : null,
    chg: battery ? battery.charging : null,
    dev: device,
  };
}

/** Error que no se arregla reintentando: el lote se descarta (la hoja se cerró, otro negocio...). */
export function isPermanentPushError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  if (/Failed to fetch|NetworkError|network|Load failed|timeout/i.test(msg)) return false;
  return /route_not_found|route_not_started|forbidden|feature_not_in_plan|invalid_points|too_many_points/.test(msg);
}

// -----------------------------------------------------------------------------
// Distancia al recorrido y desvío
// -----------------------------------------------------------------------------
/** Metros de un punto al recorrido (segmento más cercano). Espejo de _path_distance_m. */
export function distanceToPathM(p: LatLng, path: readonly LatLngTuple[]): number | null {
  if (!path.length) return null;
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const xy = (q: LatLngTuple): [number, number] => [(q[1] - p.lng) * k, (q[0] - p.lat) * 110574];
  let [x2, y2] = xy(path[0]!);
  let best = Math.hypot(x2, y2);
  for (let i = 1; i < path.length; i++) {
    const x1 = x2;
    const y1 = y2;
    [x2, y2] = xy(path[i]!);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x1 + t * dx, y1 + t * dy);
    if (d < best) best = d;
  }
  return Math.round(best);
}

/** Recorrido contra el que se mide: el planificado o el origen y las paradas en orden. Espejo de _route_path. */
export function routePath(
  planned: readonly LatLngTuple[] | null | undefined,
  origin: LatLng | null,
  stops: readonly { seq: number; lat: number | null; lng: number | null }[],
  back: boolean,
): LatLngTuple[] {
  if (planned && planned.length >= 2) return [...planned];
  const pts: LatLngTuple[] = [];
  if (origin) pts.push([origin.lat, origin.lng]);
  for (const s of [...stops].sort((a, b) => a.seq - b.seq)) if (s.lat !== null && s.lng !== null) pts.push([s.lat, s.lng]);
  if (back && origin) pts.push([origin.lat, origin.lng]);
  return pts;
}

export interface DeviationState {
  /** Desde cuándo (ms) está afuera del umbral. */
  since: number | null;
  /** Hay una alerta abierta. */
  alert: boolean;
}

/**
 * Próximo estado del desvío con la última posición. Espejo de
 * route_positions_push: afuera del umbral más de N minutos abre la alerta;
 * volver adentro la cierra. Mala precisión no cambia nada.
 */
export function nextDeviation(
  state: DeviationState,
  offM: number | null,
  at: number,
  accuracy: number | null,
  cfg: Pick<TrackingSettings, "deviation_m" | "deviation_minutes">,
): DeviationState & { opened: boolean; closed: boolean } {
  if (offM === null || (accuracy !== null && accuracy > 200)) return { ...state, opened: false, closed: false };
  if (offM > cfg.deviation_m) {
    const since = state.since ?? at;
    const opened = !state.alert && at - since >= cfg.deviation_minutes * 60_000;
    return { since, alert: state.alert || opened, opened, closed: false };
  }
  return { since: null, alert: false, opened: false, closed: state.alert };
}

// -----------------------------------------------------------------------------
// Llegada estimada
// -----------------------------------------------------------------------------
export interface EtaStop {
  id: string;
  seq: number;
  lat: number | null;
  lng: number | null;
}

/**
 * Hora estimada de llegada a cada parada que falta, desde la última
 * posición: tramos en línea recta por el factor urbano a la velocidad
 * promedio, más los minutos de cada parada. Sin posición, desde ahora y el
 * origen.
 */
export function liveEta(
  now: number,
  from: LatLng | null,
  remaining: readonly EtaStop[],
  cfg: Pick<TrackingSettings, "avg_speed_kmh" | "service_minutes">,
  urbanFactor = 1.35,
): Record<string, number> {
  const speed = (Math.max(5, cfg.avg_speed_kmh) * 1000) / 3600;
  const service = Math.max(0, cfg.service_minutes) * 60_000;
  const out: Record<string, number> = {};
  let t = now;
  let prev = from;
  for (const s of [...remaining].sort((a, b) => a.seq - b.seq)) {
    const here = s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : null;
    const leg = prev && here ? (distanceM(prev, here) ?? 0) * urbanFactor : 2000;
    t += (leg / speed) * 1000;
    out[s.id] = Math.round(t);
    t += service;
    if (here) prev = here;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Textos
// -----------------------------------------------------------------------------
/** "hace 40 s", "hace 3 min", "hace 2 h". */
export function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

export type Freshness = "vivo" | "demorado" | "sin_senal";

/** Vivo hasta 90 s, demorado hasta 5 minutos, después sin señal. */
export function freshness(ms: number): Freshness {
  if (ms <= 90_000) return "vivo";
  if (ms <= 5 * 60_000) return "demorado";
  return "sin_senal";
}

export const FRESHNESS_LABEL: Record<Freshness, string> = { vivo: "En vivo", demorado: "Demorado", sin_senal: "Sin señal" };

/** "14:35" en hora de Argentina. */
export function clock(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const d = typeof ms === "number" ? new Date(ms) : new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });
}

/**
 * Paradas salteadas: pendientes con un número menor que la última resuelta
 * (el repartidor entregó la 5 antes que la 3). El panel lo avisa.
 */
export function skippedStops(stops: readonly { seq: number; status: string }[]): number[] {
  const final = (s: string) => s === "entregada" || s === "parcial" || s === "no_entregada" || s === "saltada";
  const lastDone = Math.max(0, ...stops.filter((s) => final(s.status) && s.status !== "saltada").map((s) => s.seq));
  return stops
    .filter((s) => !final(s.status) && s.seq < lastDone)
    .map((s) => s.seq)
    .sort((a, b) => a - b);
}

/** Velocidad en km/h a partir de m/s. */
export function kmh(mps: number | null | undefined): number | null {
  if (mps === null || mps === undefined || !Number.isFinite(mps)) return null;
  return Math.round(mps * 3.6);
}
