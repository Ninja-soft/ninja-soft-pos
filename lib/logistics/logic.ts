// Reparto propio (ADR-161 · H145, L2 de ADR-149). PURO: sin React ni
// Supabase. Configuración de Logística, estados de hojas y paradas, orden por
// cercanía, exigencias de cada entrega (espejo de delivery_event_record),
// vencimientos de la flota y mensajes de error del servidor.
import { roleErrorMessage } from "@/lib/permissions/errors";

// -----------------------------------------------------------------------------
// Configuración › Logística (espejo de _logistics_settings)
// -----------------------------------------------------------------------------
export type RemitoPolicy = "nunca" | "a_pedido" | "siempre_reparto" | "siempre_envio";
export type RemitoModel = "a4" | "a4_medio" | "ticket80" | "preimpreso";

export interface FailureReason {
  key: string;
  label: string;
  requires_photo: boolean;
  requires_note: boolean;
  active: boolean;
}

export interface LogisticsSettings {
  remito_policy: RemitoPolicy;
  remito_copies: 1 | 2 | 3;
  remito_copy_labels: [string, string, string];
  remito_model: RemitoModel;
  preprinted_offset_x_mm: number;
  preprinted_offset_y_mm: number;
  require_geo: boolean;
  require_signature: boolean;
  require_photo: boolean;
  require_receiver_name: boolean;
  require_receiver_doc: boolean;
  require_remito_photo: boolean;
  max_distance_m: number;
  max_attempts: number;
  failure_reasons: FailureReason[];
  /** Hay fila guardada (si no, son los defaults). */
  saved: boolean;
}

export const DEFAULT_FAILURE_REASONS: FailureReason[] = [
  { key: "no_estaba", label: "No estaba en el domicilio", requires_photo: false, requires_note: false, active: true },
  { key: "direccion_incorrecta", label: "Dirección incorrecta", requires_photo: false, requires_note: false, active: true },
  { key: "rechazo", label: "Rechazó el pedido", requires_photo: false, requires_note: true, active: true },
  { key: "cerrado", label: "Cerrado", requires_photo: true, requires_note: false, active: true },
  { key: "sin_acceso", label: "Sin acceso", requires_photo: false, requires_note: false, active: true },
  { key: "danado", label: "Producto dañado", requires_photo: true, requires_note: false, active: true },
  { key: "reprogramado", label: "Reprogramado por el cliente", requires_photo: false, requires_note: false, active: true },
  { key: "otro", label: "Otro", requires_photo: false, requires_note: true, active: true },
];

export const DEFAULT_LOGISTICS_SETTINGS: LogisticsSettings = {
  remito_policy: "a_pedido",
  remito_copies: 2,
  remito_copy_labels: ["Original: cliente", "Duplicado: vuelve firmado", "Triplicado: archivo"],
  remito_model: "a4",
  preprinted_offset_x_mm: 0,
  preprinted_offset_y_mm: 0,
  require_geo: true,
  require_signature: true,
  require_photo: false,
  require_receiver_name: true,
  require_receiver_doc: false,
  require_remito_photo: false,
  max_distance_m: 300,
  max_attempts: 3,
  failure_reasons: DEFAULT_FAILURE_REASONS,
  saved: false,
};

export const REMITO_POLICY_LABEL: Record<RemitoPolicy, string> = {
  nunca: "Nunca",
  a_pedido: "A pedido",
  siempre_reparto: "Siempre en reparto propio",
  siempre_envio: "Siempre en todo envío",
};

export const REMITO_POLICY_HINT: Record<RemitoPolicy, string> = {
  nunca: "No se emiten remitos desde Logística.",
  a_pedido: "Lo emitís cuando lo necesitás, desde la entrega o la hoja de ruta.",
  siempre_reparto: "Una hoja de ruta no sale si alguna entrega no tiene su remito.",
  siempre_envio: "Igual que en reparto propio, y se ofrece emitirlo en todo envío.",
};

export const REMITO_MODEL_LABEL: Record<RemitoModel, string> = {
  a4: "A4 completo",
  a4_medio: "Medio A4 (dos por hoja)",
  ticket80: "Ticket de 80 mm",
  preimpreso: "Talonario preimpreso",
};

const POLICIES: RemitoPolicy[] = ["nunca", "a_pedido", "siempre_reparto", "siempre_envio"];
const MODELS: RemitoModel[] = ["a4", "a4_medio", "ticket80", "preimpreso"];

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : d);
const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function normalizeReason(raw: unknown): FailureReason | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" ? r.key.trim().toLowerCase() : "";
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (!/^[a-z0-9_]{2,40}$/.test(key) || label.length < 2 || label.length > 60) return null;
  return {
    key,
    label,
    requires_photo: bool(r.requires_photo, false),
    requires_note: bool(r.requires_note, false),
    active: bool(r.active, true),
  };
}

/** Lo que devuelve logistics_settings_get, con defaults y tipos seguros. */
export function logisticsSettings(raw: unknown): LogisticsSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_LOGISTICS_SETTINGS;
  const labels = Array.isArray(r.remito_copy_labels) && r.remito_copy_labels.length === 3
    ? (r.remito_copy_labels.map((x, i) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 40) : d.remito_copy_labels[i]!)) as [string, string, string])
    : d.remito_copy_labels;
  const reasons = Array.isArray(r.failure_reasons)
    ? r.failure_reasons.map(normalizeReason).filter((x): x is FailureReason => x !== null)
    : [];
  return {
    remito_policy: POLICIES.includes(r.remito_policy as RemitoPolicy) ? (r.remito_policy as RemitoPolicy) : d.remito_policy,
    remito_copies: num(r.remito_copies, d.remito_copies, 1, 3) as 1 | 2 | 3,
    remito_copy_labels: labels,
    remito_model: MODELS.includes(r.remito_model as RemitoModel) ? (r.remito_model as RemitoModel) : d.remito_model,
    preprinted_offset_x_mm: num(r.preprinted_offset_x_mm, 0, -30, 30),
    preprinted_offset_y_mm: num(r.preprinted_offset_y_mm, 0, -30, 30),
    require_geo: bool(r.require_geo, d.require_geo),
    require_signature: bool(r.require_signature, d.require_signature),
    require_photo: bool(r.require_photo, d.require_photo),
    require_receiver_name: bool(r.require_receiver_name, d.require_receiver_name),
    require_receiver_doc: bool(r.require_receiver_doc, d.require_receiver_doc),
    require_remito_photo: bool(r.require_remito_photo, d.require_remito_photo),
    max_distance_m: Math.round(num(r.max_distance_m, d.max_distance_m, 50, 20000)),
    max_attempts: Math.round(num(r.max_attempts, d.max_attempts, 1, 10)),
    failure_reasons: reasons.length ? reasons : DEFAULT_FAILURE_REASONS,
    saved: r.saved === true,
  };
}

/** Clave de un motivo nuevo a partir de su etiqueta ("Portón cerrado" -> "porton_cerrado"). */
export function reasonKeyFromLabel(label: string, taken: readonly string[]): string {
  const base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "motivo";
  const k = base.length >= 2 ? base : `${base}_x`;
  if (!taken.includes(k)) return k;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${k}_${i}`)) return `${k}_${i}`;
  return `${k}_${Date.now() % 1000}`;
}

/** Problemas de la configuración antes de guardar (espejo de logistics_settings_save). */
export function settingsProblems(s: LogisticsSettings): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const r of s.failure_reasons) {
    if (!normalizeReason(r)) out.push(`El motivo "${r.label || r.key}" necesita un nombre de 2 a 60 letras.`);
    if (keys.has(r.key)) out.push(`El motivo "${r.label}" está repetido.`);
    keys.add(r.key);
  }
  if (s.failure_reasons.length > 20) out.push("Hasta 20 motivos.");
  if (!s.failure_reasons.some((r) => r.active)) out.push("Dejá al menos un motivo activo.");
  if (s.remito_copy_labels.some((l) => !l.trim())) out.push("Cada copia del remito necesita su leyenda.");
  return out;
}

// -----------------------------------------------------------------------------
// Hojas de ruta y paradas
// -----------------------------------------------------------------------------
export type RouteStatus = "borrador" | "planificada" | "cargando" | "en_curso" | "cerrada" | "cancelada";
export type StopStatus = "pendiente" | "en_camino" | "en_el_lugar" | "entregada" | "parcial" | "no_entregada" | "saltada";

export const ROUTE_STATUS_LABEL: Record<RouteStatus, string> = {
  borrador: "Borrador",
  planificada: "Planificada",
  cargando: "Cargando",
  en_curso: "En curso",
  cerrada: "Cerrada",
  cancelada: "Cancelada",
};

export type Tone = "brand" | "success" | "warning" | "danger" | "info" | "neutral";

export const ROUTE_STATUS_TONE: Record<RouteStatus, Tone> = {
  borrador: "neutral",
  planificada: "info",
  cargando: "warning",
  en_curso: "brand",
  cerrada: "success",
  cancelada: "neutral",
};

export const STOP_STATUS_LABEL: Record<StopStatus, string> = {
  pendiente: "Pendiente",
  en_camino: "En camino",
  en_el_lugar: "En el lugar",
  entregada: "Entregada",
  parcial: "Parcial",
  no_entregada: "No entregada",
  saltada: "Sin visitar",
};

export const STOP_STATUS_TONE: Record<StopStatus, Tone> = {
  pendiente: "neutral",
  en_camino: "info",
  en_el_lugar: "warning",
  entregada: "success",
  parcial: "warning",
  no_entregada: "danger",
  saltada: "neutral",
};

export function stopIsFinal(s: StopStatus): boolean {
  return s === "entregada" || s === "parcial" || s === "no_entregada" || s === "saltada";
}

/** Se pueden sumar, quitar u ordenar paradas (antes de salir). */
export function routeEditable(s: RouteStatus): boolean {
  return s === "borrador" || s === "planificada" || s === "cargando";
}

/** Espejo de route_set_status: a qué estado se puede pasar desde el panel. */
export function routeNextStatuses(s: RouteStatus): RouteStatus[] {
  if (s === "borrador") return ["planificada"];
  if (s === "planificada") return ["borrador", "cargando"];
  if (s === "cargando") return ["planificada"];
  return [];
}

export interface PlanCheck {
  vehicle: boolean;
  driver: boolean;
  stops: number;
}

/** Qué le falta a una hoja para planificarla o salir. Vacío = lista. */
export function routeMissing(c: PlanCheck): string[] {
  const out: string[] = [];
  if (!c.vehicle) out.push("Elegí el vehículo.");
  if (!c.driver) out.push("Elegí el repartidor.");
  if (c.stops === 0) out.push("Sumá al menos una entrega.");
  return out;
}

// -----------------------------------------------------------------------------
// Distancias y orden por cercanía (heurística local, sin red)
// -----------------------------------------------------------------------------
export interface LatLng {
  lat: number;
  lng: number;
}

/** Distancia en metros (haversine, espejo de _geo_distance_m). */
export function distanceM(a: LatLng | null | undefined, b: LatLng | null | undefined): number | null {
  if (!a || !b) return null;
  if (![a.lat, a.lng, b.lat, b.lng].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

export interface OrderPoint {
  id: string;
  lat: number | null;
  lng: number | null;
  /** Para agrupar por localidad las que no tienen coordenadas. */
  locality?: string | null;
}

function pathLength(start: LatLng | null, pts: LatLng[], back: boolean): number {
  let total = 0;
  let prev = start;
  for (const p of pts) {
    if (prev) total += distanceM(prev, p) ?? 0;
    prev = p;
  }
  if (back && start && prev && pts.length) total += distanceM(prev, start) ?? 0;
  return total;
}

/**
 * Orden por cercanía: vecino más cercano desde el origen y mejora 2-opt.
 * Las paradas sin coordenadas van al final, agrupadas por localidad, en el
 * orden en que estaban. Devuelve los ids y los metros estimados en línea
 * recta (con vuelta al origen si `back`).
 */
export function orderByProximity(
  origin: LatLng | null,
  points: readonly OrderPoint[],
  back = true,
): { ids: string[]; distanceM: number } {
  const geo = points.filter((p) => p.lat !== null && p.lng !== null) as (OrderPoint & LatLng)[];
  const noGeo = points.filter((p) => p.lat === null || p.lng === null);
  const left = [...geo];
  const route: (OrderPoint & LatLng)[] = [];
  let cur: LatLng | null = origin ?? (left[0] ? { lat: left[0].lat, lng: left[0].lng } : null);
  while (left.length) {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    left.forEach((p, i) => {
      const d = cur ? (distanceM(cur, p) ?? Number.POSITIVE_INFINITY) : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    route.push(next!);
    cur = next!;
  }
  // 2-opt: invertir tramos mientras acorte el recorrido.
  let improved = true;
  let guard = 0;
  while (improved && guard < 50) {
    improved = false;
    guard++;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (pathLength(origin, candidate, back) + 0.5 < pathLength(origin, route, back)) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  const groups = new Map<string, OrderPoint[]>();
  for (const p of noGeo) {
    const k = (p.locality ?? "").trim().toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const tail = [...groups.values()].flat();
  return { ids: [...route.map((p) => p.id), ...tail.map((p) => p.id)], distanceM: Math.round(pathLength(origin, route, back)) };
}

/** "1,2 km" o "350 m". */
export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} km`;
}

/** Links gratis para navegar hasta la parada (sin API ni clave). */
export function navigationLinks(p: { lat: number | null; lng: number | null; address: string | null }): { google: string; waze: string | null } {
  if (p.lat !== null && p.lng !== null) {
    return {
      google: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`,
      waze: `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`,
    };
  }
  const q = encodeURIComponent(p.address ?? "");
  return { google: `https://www.google.com/maps/dir/?api=1&destination=${q}`, waze: q ? `https://waze.com/ul?q=${q}&navigate=yes` : null };
}

/** Teléfono para tel: y WhatsApp (Argentina): sólo dígitos, con 54 adelante para wa.me. */
export function phoneLinks(phone: string | null | undefined): { tel: string; whatsapp: string } | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 6) return null;
  const wa = digits.startsWith("54") ? digits : `54${digits.replace(/^0/, "")}`;
  return { tel: `tel:${digits}`, whatsapp: `https://wa.me/${wa}` };
}

// -----------------------------------------------------------------------------
// Exigencias de una entrega (espejo de delivery_event_record)
// -----------------------------------------------------------------------------
export interface DeliveryDraft {
  lat: number | null;
  lng: number | null;
  signature: boolean;
  photos: number;
  remitoPhoto: boolean;
  receivedByName: string;
  receivedByDoc: string;
}

export type DeliveryRequirement = "geo" | "signature" | "photo" | "receiver_name" | "receiver_doc" | "remito_photo";

export const REQUIREMENT_LABEL: Record<DeliveryRequirement, string> = {
  geo: "la ubicación",
  signature: "la firma",
  photo: "una foto",
  receiver_name: "quién recibe",
  receiver_doc: "el DNI de quien recibe",
  remito_photo: "la foto del remito firmado",
};

/** Lo que falta para marcar entregado. Vacío = se puede guardar. */
export function missingForDelivery(s: LogisticsSettings, d: DeliveryDraft): DeliveryRequirement[] {
  const out: DeliveryRequirement[] = [];
  if (s.require_geo && (d.lat === null || d.lng === null)) out.push("geo");
  if (s.require_signature && !d.signature) out.push("signature");
  if (s.require_photo && d.photos === 0) out.push("photo");
  if (s.require_receiver_name && d.receivedByName.trim().length < 2) out.push("receiver_name");
  if (s.require_receiver_doc && d.receivedByDoc.replace(/[^0-9A-Za-z]/g, "").length < 6) out.push("receiver_doc");
  if (s.require_remito_photo && !d.remitoPhoto) out.push("remito_photo");
  return out;
}

/** Lo que falta para marcar "no se pudo entregar" con este motivo. */
export function missingForFailure(reason: FailureReason | null, d: { photos: number; note: string }): ("reason" | "photo" | "note")[] {
  if (!reason) return ["reason"];
  const out: ("photo" | "note")[] = [];
  if (reason.requires_photo && d.photos === 0) out.push("photo");
  if (reason.requires_note && d.note.trim().length < 3) out.push("note");
  return out;
}

/** "Falta la firma y una foto." */
export function missingText(items: string[]): string {
  if (!items.length) return "";
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
  return `Falta ${list}.`;
}

/** ¿Está lejos de la dirección? (el servidor pide confirmarlo). */
export function isFar(distance: number | null, s: LogisticsSettings): boolean {
  return distance !== null && distance > s.max_distance_m;
}

// -----------------------------------------------------------------------------
// Flota
// -----------------------------------------------------------------------------
export type VehicleKind = "moto" | "auto" | "utilitario" | "camion" | "bici" | "a_pie";
export type VehicleStatus = "activo" | "en_taller" | "baja";

export const VEHICLE_KIND_LABEL: Record<VehicleKind, string> = {
  moto: "Moto",
  auto: "Auto",
  utilitario: "Utilitario",
  camion: "Camión",
  bici: "Bici",
  a_pie: "A pie",
};

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  activo: "Activo",
  en_taller: "En taller",
  baja: "De baja",
};

export type ExpiryState = "vencido" | "por_vencer" | "al_dia" | "sin_dato";

/** Semáforo de un vencimiento: vencido, por vencer (30 días) o al día. */
export function expiryState(date: string | null | undefined, today: string, warnDays = 30): ExpiryState {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return "sin_dato";
  const d = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const t = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (d < t) return "vencido";
  if (d - t <= warnDays * 86_400_000) return "por_vencer";
  return "al_dia";
}

export const EXPIRY_TONE: Record<ExpiryState, Tone> = {
  vencido: "danger",
  por_vencer: "warning",
  al_dia: "success",
  sin_dato: "neutral",
};

/** Patente normalizada como la guarda el servidor ("ab 123 cd" -> "AB 123 CD"). */
export function normalizePlate(v: string): string {
  return v.trim().replace(/\s+/g, " ").toUpperCase();
}

export function plateValid(v: string): boolean {
  const p = normalizePlate(v);
  return p === "" || /^[A-Z0-9 -]{5,12}$/.test(p);
}

/** Porcentaje de uso de una capacidad (0 a 100+), o null sin capacidad. */
export function capacityUse(used: number, capacity: number | null | undefined): number | null {
  if (!capacity || capacity <= 0) return null;
  return Math.round((used / capacity) * 100);
}

/** Fecha de hoy en Argentina (AAAA-MM-DD). */
export function arToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
}

// -----------------------------------------------------------------------------
// Errores del servidor
// -----------------------------------------------------------------------------
const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: reparto_propio/, "Tu plan no incluye el reparto propio."],
  [/feature_not_in_plan: pedidos_despacho/, "Tu plan no incluye la expedición."],
  [/route_not_found/, "La hoja de ruta ya no existe."],
  [/route_not_editable/, "La hoja ya salió: no se puede cambiar."],
  [/route_not_cancellable/, "Una hoja que ya salió no se cancela: cerrala."],
  [/route_not_started/, "La hoja todavía no salió."],
  [/route_needs_vehicle/, "Elegí un vehículo activo para la hoja."],
  [/route_needs_driver/, "Elegí el repartidor de la hoja."],
  [/route_without_stops/, "Sumá al menos una entrega a la hoja."],
  [/route_has_stops/, "Para cambiar de sucursal, primero quitá las paradas."],
  [/vehicle_busy/, "Ese vehículo está en otra hoja en curso."],
  [/vehicle_not_available/, "Ese vehículo no está disponible (en taller o de baja)."],
  [/vehicle_in_route/, "El vehículo está en una hoja abierta. Cambialo en la hoja primero."],
  [/vehicle_not_found/, "El vehículo ya no existe."],
  [/vehicle_name_required/, "Ponele un nombre al vehículo."],
  [/plate_taken/, "Ya hay otro vehículo con esa patente."],
  [/driver_not_allowed/, "Esa persona no puede repartir. Dale el rol Repartidor o el permiso de reparto."],
  [/driver_not_found/, "Esa persona no es del equipo."],
  [/helper_is_driver/, "El acompañante no puede ser el mismo repartidor."],
  [/remito_missing/, "Hay entregas sin remito y tu configuración lo pide para salir."],
  [/dispatch_not_for_route/, "Sólo entran entregas por envío propio (no las de logística)."],
  [/dispatch_not_ready/, "Esa entrega no está para repartir."],
  [/dispatch_other_store/, "La entrega sale de otra sucursal."],
  [/dispatch_not_arrived/, "La entrega todavía no llegó desde la otra sucursal."],
  [/dispatch_in_route/, "La entrega ya está en otra hoja."],
  [/stop_closed/, "Esa parada ya está cerrada."],
  [/stop_not_found/, "La parada ya no existe."],
  [/geo_required/, "Hace falta la ubicación: activá el GPS y volvé a intentar."],
  [/signature_required/, "Falta la firma de quien recibe."],
  [/photo_required/, "Falta la foto."],
  [/receiver_name_required/, "Falta el nombre de quien recibe."],
  [/receiver_doc_required/, "Falta el DNI de quien recibe."],
  [/remito_photo_required/, "Falta la foto del remito firmado."],
  [/reason_required/, "Elegí el motivo."],
  [/note_required/, "Este motivo pide una nota."],
  [/too_far_from_stop/, "Estás lejos de la dirección. Confirmá que la entrega es ahí."],
  [/invalid_media_path/, "La foto no se pudo asociar a la hoja."],
  [/too_many_photos/, "Llegaste al máximo de fotos."],
  [/invalid_reason/, "Revisá los motivos: cada uno con nombre de 2 a 60 letras y sin repetir."],
  [/reasons_required/, "Dejá al menos un motivo activo."],
  [/invalid_copy_labels/, "Cada copia del remito necesita su leyenda."],
  [/origin_not_found/, "El origen ya no existe."],
  [/store_forbidden|store_not_allowed/, "No tenés acceso a esa sucursal."],
  [/invalid_transition/, "La hoja cambió de estado. Actualizá la pantalla."],
  [/invalid_stop_order/, "El orden cambió en otra pantalla. Actualizá y volvé a ordenar."],
];

export function logisticsErrorMessage(e: unknown): string {
  const role = roleErrorMessage(e);
  if (role) return role;
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Sin conexión. Se guarda y se manda cuando vuelva la señal.";
  return "No se pudo completar la operación.";
}

/** Error de datos (no se arregla reintentando): la cola offline no lo repite. */
export function isPermanentEventError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  if (/Failed to fetch|NetworkError|network|timeout|fetch/i.test(msg)) return false;
  return /stop_closed|stop_not_found|route_not_found|route_not_started|invalid_|forbidden|feature_not_in_plan|_required|too_far_from_stop|_incomplete|_not_allowed|not_in_stop|not_in_dispatch|dispatch_without_items/.test(msg);
}
