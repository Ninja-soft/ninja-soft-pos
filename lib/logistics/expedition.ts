// Expedición robusta (ADR-165 · F22 · H148 · L5): escaneo configurable al
// armar, al cargar y al entregar; resultado por producto (entregado, roto,
// rechazado, faltante); problemas de la entrega y pedido de stock. Lógica
// pura: el servidor valida lo mismo (dispatch_scan, _exp_apply_outcome,
// expedition_settings_save) y estas funciones sólo ordenan la pantalla y
// permiten escanear sin señal en la app del repartidor.

import { roleErrorMessage } from "@/lib/permissions/errors";

export type ScanMode = "no" | "opcional" | "obligatorio";
export type ScanStage = "armado" | "carga" | "entrega";
export type DamagedDestination = "merma" | "deposito";
export type UndeliveredAction = "reprogramar" | "revisar";
export type DamageReason = "roto" | "mal_estado" | "vencido" | "otro";
export type DifferenceReason = "faltante" | "danado" | "vencido" | "error_despacho" | "sobrante" | "sin_codigo" | "otro";
export type ScanResultKind = "ok" | "excedente" | "ajeno" | "cruce" | "desconocido" | "manual";

export interface ExpeditionSettings {
  scan_on_pick: ScanMode;
  scan_on_load: ScanMode;
  scan_on_deliver: ScanMode;
  allow_partial: boolean;
  damaged_destination: DamagedDestination;
  damage_requires_photo: boolean;
  undelivered_action: UndeliveredAction;
  saved?: boolean;
}

export const DEFAULT_EXPEDITION_SETTINGS: ExpeditionSettings = {
  scan_on_pick: "opcional",
  scan_on_load: "opcional",
  scan_on_deliver: "no",
  allow_partial: true,
  damaged_destination: "merma",
  damage_requires_photo: true,
  undelivered_action: "reprogramar",
  saved: false,
};

const MODES: ScanMode[] = ["no", "opcional", "obligatorio"];
const mode = (v: unknown, d: ScanMode): ScanMode => (MODES.includes(v as ScanMode) ? (v as ScanMode) : d);

/** Normaliza lo que viene del servidor (o nada, sin la migración). */
export function expeditionSettings(raw: unknown): ExpeditionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_EXPEDITION_SETTINGS;
  return {
    scan_on_pick: mode(r.scan_on_pick, d.scan_on_pick),
    scan_on_load: mode(r.scan_on_load, d.scan_on_load),
    scan_on_deliver: mode(r.scan_on_deliver, d.scan_on_deliver),
    allow_partial: typeof r.allow_partial === "boolean" ? r.allow_partial : d.allow_partial,
    damaged_destination: r.damaged_destination === "deposito" ? "deposito" : "merma",
    damage_requires_photo: typeof r.damage_requires_photo === "boolean" ? r.damage_requires_photo : d.damage_requires_photo,
    undelivered_action: r.undelivered_action === "revisar" ? "revisar" : "reprogramar",
    saved: Boolean(r.saved),
  };
}

export function stageMode(s: ExpeditionSettings, stage: ScanStage): ScanMode {
  return stage === "armado" ? s.scan_on_pick : stage === "carga" ? s.scan_on_load : s.scan_on_deliver;
}

export const SCAN_MODE_LABEL: Record<ScanMode, string> = {
  no: "No",
  opcional: "Opcional",
  obligatorio: "Obligatorio",
};

export const SCAN_STAGE_LABEL: Record<ScanStage, string> = {
  armado: "Al armar",
  carga: "Al cargar el camión",
  entrega: "Al entregar",
};

export const SCAN_STAGE_HINT: Record<ScanStage, string> = {
  armado: "Con obligatorio, la entrega no pasa a Listo hasta escanear todo o justificar lo que falta.",
  carga: "Con obligatorio, la hoja de ruta no sale hasta controlar la carga completa.",
  entrega: "Con obligatorio, no se puede marcar entregado sin escanear lo que se entrega (en el mostrador y en la calle).",
};

export const DAMAGE_REASON_LABEL: Record<DamageReason, string> = {
  roto: "Se rompió",
  mal_estado: "En mal estado o dañado",
  vencido: "Vencido",
  otro: "Otro motivo",
};

export const DIFFERENCE_REASON_LABEL: Record<DifferenceReason, string> = {
  faltante: "Falta en el depósito",
  danado: "Dañado",
  vencido: "Vencido",
  error_despacho: "Error de armado",
  sobrante: "Sobra",
  sin_codigo: "No tiene código para escanear",
  otro: "Otro",
};

// ── Escaneo ─────────────────────────────────────────────────────────────────

/** Código leído (lector USB, teclado o cámara) normalizado como en el servidor. */
export function normalizeCode(code: string): string {
  return code.replace(/[\r\n\t]/g, "").trim().toUpperCase();
}

export interface ScanItem {
  id: string;
  name: string;
  qty: number;
  unit?: string | null;
  /** Códigos con los que se reconoce (código de barras y SKU). */
  codes: string[];
}

export interface LocalMatch {
  kind: "ok" | "excedente" | "ajeno";
  itemId: string | null;
}

/**
 * Lectura sin señal (app del repartidor): el primer renglón con ese código
 * que todavía no está completo. Si todos están completos, "excedente"; si
 * ninguno lo tiene, "ajeno" (se registra al sincronizar).
 */
export function matchLocal(items: readonly ScanItem[], code: string, scanned: Readonly<Record<string, number>>): LocalMatch {
  const c = normalizeCode(code);
  if (!c) return { kind: "ajeno", itemId: null };
  const hits = items.filter((i) => i.qty > 0 && i.codes.some((x) => normalizeCode(x) === c));
  if (!hits.length) return { kind: "ajeno", itemId: null };
  const open = hits.find((i) => (scanned[i.id] ?? 0) + 0.0005 < i.qty);
  return open ? { kind: "ok", itemId: open.id } : { kind: "excedente", itemId: hits[0]!.id };
}

export interface CheckState {
  scanned: number;
  reason?: DifferenceReason | null;
}

/** ¿El renglón está controlado? (escaneado completo o con motivo). */
export function itemChecked(qty: number, c: CheckState | null | undefined): boolean {
  if (qty <= 0) return true;
  if (!c) return false;
  return Boolean(c.reason) || c.scanned + 0.0005 >= qty;
}

export function checkProgress(items: readonly { id: string; qty: number }[], checks: Readonly<Record<string, CheckState | undefined>>) {
  const list = items.filter((i) => i.qty > 0);
  const done = list.filter((i) => itemChecked(i.qty, checks[i.id])).length;
  return { done, total: list.length, complete: list.length > 0 && done === list.length };
}

export interface ScanFeedback {
  tone: "success" | "warning" | "danger";
  title: string;
  description?: string;
}

/** Lo que se muestra (y suena) después de cada lectura. */
export function scanFeedback(r: {
  result: ScanResultKind;
  product_name?: string | null;
  scanned?: number | null;
  expected?: number | null;
  other_dispatch_number?: number | null;
}): ScanFeedback {
  const qty = r.expected != null ? ` (${fmt(r.scanned ?? 0)} de ${fmt(r.expected)})` : "";
  switch (r.result) {
    case "ok":
    case "manual":
      return { tone: "success", title: `${r.product_name ?? "Producto"}${qty}` };
    case "excedente":
      return { tone: "warning", title: "Ya está completo", description: `${r.product_name ?? "Ese producto"} ya tiene todo lo que lleva esta entrega.` };
    case "cruce":
      return {
        tone: "danger",
        title: "No es de esta entrega",
        description: r.other_dispatch_number
          ? `Ese producto va en la entrega N° ${r.other_dispatch_number}. Quedó registrado.`
          : "Ese producto es de otra entrega. Quedó registrado.",
      };
    case "ajeno":
      return { tone: "danger", title: "No es de esta entrega", description: "Ese producto no va acá. Quedó registrado." };
    default:
      return { tone: "danger", title: "Código desconocido", description: "Ningún producto tiene ese código. Quedó registrado." };
  }
}

function fmt(n: number): string {
  return Number(n).toLocaleString("es-AR", { maximumFractionDigits: 3 });
}

// ── Resultado por producto ──────────────────────────────────────────────────

export interface OutcomeLine {
  itemId: string;
  name: string;
  qty: number;
  delivered: number;
  damaged: number;
  rejected: number;
}

export function outcomeLines(items: readonly { id: string; name: string; qty: number }[]): OutcomeLine[] {
  return items.filter((i) => i.qty > 0).map((i) => ({ itemId: i.id, name: i.name, qty: i.qty, delivered: i.qty, damaged: 0, rejected: 0 }));
}

export function lineMissing(l: OutcomeLine): number {
  return Math.max(0, round3(l.qty - l.delivered - l.damaged - l.rejected));
}

export function outcomeTotals(lines: readonly OutcomeLine[]) {
  const t = { qty: 0, delivered: 0, damaged: 0, rejected: 0, missing: 0 };
  for (const l of lines) {
    t.qty += l.qty;
    t.delivered += l.delivered;
    t.damaged += l.damaged;
    t.rejected += l.rejected;
    t.missing += lineMissing(l);
  }
  for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] = round3(t[k]);
  return { ...t, complete: t.delivered + 0.0005 >= t.qty, anyDelivered: t.delivered > 0.0005 };
}

/** Ajusta un número del renglón sin pasarse de lo que lleva. */
export function setLine(l: OutcomeLine, field: "delivered" | "damaged" | "rejected", value: number): OutcomeLine {
  const v = Math.max(0, round3(Number.isFinite(value) ? value : 0));
  const others = (field === "delivered" ? 0 : l.delivered) + (field === "damaged" ? 0 : l.damaged) + (field === "rejected" ? 0 : l.rejected);
  const capped = Math.min(v, round3(l.qty - others));
  return { ...l, [field]: Math.max(0, capped) };
}

/** Por qué no se puede guardar todavía (null = se puede). */
export function outcomeProblem(
  lines: readonly OutcomeLine[],
  o: { settings: ExpeditionSettings; photos: number; reason: DamageReason | null; note: string; mustDeliver?: boolean },
): string | null {
  const t = outcomeTotals(lines);
  if (lines.some((l) => l.delivered + l.damaged + l.rejected > l.qty + 0.0005)) return "Revisá las cantidades: suman más de lo que lleva.";
  if (o.mustDeliver && !t.anyDelivered) return "Tiene que entregarse algo. Si no se entrega nada, usá No se pudo entregar.";
  if (t.anyDelivered && !t.complete && !o.settings.allow_partial) return "La entrega parcial está apagada en Configuración: se entrega todo o nada.";
  if (t.damaged > 0) {
    if (!o.reason) return "Elegí qué le pasó a lo roto.";
    if (o.reason === "otro" && o.note.trim().length < 3) return "Contá qué pasó con lo roto.";
    if (o.settings.damage_requires_photo && o.photos === 0) return "Sacale una foto a lo roto.";
  }
  return null;
}

/** Texto corto del resultado ("2 entregados, 1 roto, 1 rechazado"). */
export function outcomeSummary(lines: readonly OutcomeLine[]): string {
  const t = outcomeTotals(lines);
  const parts: string[] = [];
  if (t.delivered) parts.push(`${fmt(t.delivered)} ${t.delivered === 1 ? "entregado" : "entregados"}`);
  if (t.damaged) parts.push(`${fmt(t.damaged)} ${t.damaged === 1 ? "roto" : "rotos"}`);
  if (t.rejected) parts.push(`${fmt(t.rejected)} ${t.rejected === 1 ? "rechazado" : "rechazados"}`);
  if (t.missing) parts.push(`${fmt(t.missing)} sin entregar`);
  return parts.join(", ") || "Nada para entregar";
}

export interface OutcomePlan {
  /** Lo roto: merma (baja) o depósito de merma. Nunca toca lo vendido otra vez. */
  damage: { itemId: string; qty: number; destination: DamagedDestination }[];
  /** Lo que va a una entrega hija (roto para reponer y lo que faltó). */
  child: { itemId: string; qty: number }[];
  /** Lo que queda en Con problemas (rechazado y, si no se reprograma, lo demás). */
  open: { itemId: string; qty: number }[];
  /** La entrega cierra como entregada (algo se entregó) o vuelve a Expedición. */
  closes: boolean;
}

/**
 * Espejo de _exp_apply_outcome (SQL): qué pasa con el stock y con la entrega.
 * La venta ya descontó todo lo que lleva la entrega; por eso lo roto se da de
 * baja una vez (su reemplazo sale sin otro movimiento) y lo rechazado no
 * mueve stock hasta la devolución de la venta.
 */
export function outcomePlan(lines: readonly OutcomeLine[], s: ExpeditionSettings): OutcomePlan {
  const t = outcomeTotals(lines);
  const damage = lines.filter((l) => l.damaged > 0).map((l) => ({ itemId: l.itemId, qty: l.damaged, destination: s.damaged_destination }));
  if (!t.anyDelivered) return { damage, child: [], open: [], closes: false };
  const child: OutcomePlan["child"] = [];
  const open: OutcomePlan["open"] = [];
  for (const l of lines) {
    const owed = round3(l.damaged + lineMissing(l));
    if (owed > 0) (s.undelivered_action === "reprogramar" ? child : open).push({ itemId: l.itemId, qty: owed });
    if (l.rejected > 0) {
      const o = open.find((x) => x.itemId === l.itemId);
      if (o) o.qty = round3(o.qty + l.rejected);
      else open.push({ itemId: l.itemId, qty: l.rejected });
    }
  }
  return { damage, child, open, closes: true };
}

/** Lo que el servidor espera en items: sólo los renglones que cambian. */
export function outcomePayload(lines: readonly OutcomeLine[]) {
  return lines.map((l) => ({ item_id: l.itemId, delivered: l.delivered, damaged: l.damaged, rejected: l.rejected }));
}

/** Pendiente de resolver de un renglón (roto, rechazado o faltante sin reprogramar ni resolver). */
export function itemOpenQty(i: {
  qty_damaged?: number | null;
  qty_rejected?: number | null;
  qty_missing?: number | null;
  qty_rescheduled?: number | null;
  qty_settled?: number | null;
}): number {
  const n = (v: number | null | undefined) => Number(v ?? 0);
  return Math.max(0, round3(n(i.qty_damaged) + n(i.qty_rejected) + n(i.qty_missing) - n(i.qty_rescheduled) - n(i.qty_settled)));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Errores ─────────────────────────────────────────────────────────────────

const ERRORS: [RegExp, string][] = [
  [/pick_scan_incomplete/, "Falta escanear lo armado: completá el control o justificá lo que falta."],
  [/load_scan_incomplete/, "Falta controlar la carga del camión: escaneá todo o justificá lo que falta."],
  [/deliver_scan_incomplete/, "Falta escanear lo que se entrega: escaneá cada producto o justificá la diferencia."],
  [/scan_disabled/, "El escaneo de esta etapa está apagado en Configuración › Logística."],
  [/item_has_code/, "Ese producto tiene código: escanealo."],
  [/item_not_in_dispatch/, "Ese renglón no es de esta entrega."],
  [/code_required|invalid_code/, "Escaneá o escribí un código."],
  [/damage_photo_required/, "Sacale una foto a lo roto."],
  [/damage_reason_required/, "Elegí qué le pasó a lo roto."],
  [/damage_note_required/, "Contá qué pasó con lo roto."],
  [/partial_not_allowed/, "La entrega parcial está apagada en Configuración: se entrega todo o nada."],
  [/nothing_delivered/, "No se entregó nada: si el cliente no se lleva nada, cancelá la entrega o dejala en Listo."],
  [/invalid_item_qty/, "Revisá las cantidades: suman más de lo que lleva la entrega."],
  [/use_pickup_code/, "Esta entrega pide el código de retiro: entregala con el código."],
  [/dispatch_in_route/, "Esta entrega viaja en una hoja de ruta: la cierra el repartidor."],
  [/no_open_issue|nothing_to_resolve/, "No queda nada por resolver en esta entrega."],
  [/stock_already_requested/, "Ya hay un traslado pedido para esta entrega."],
  [/invalid_origin/, "Elegí otra sucursal de origen."],
  [/route_already_left/, "La hoja ya salió: la carga no se puede controlar."],
  [/too_many_deliveries/, "La venta ya tiene 20 entregas: no se pueden sumar más."],
  [/dispatch_without_items/, "Esta entrega no tiene renglones por producto."],
  [/dispatch_not_in_stop/, "Una de las entregas no es de esta parada."],
  [/invalid_media_path/, "La foto no se guardó en la carpeta correcta. Volvé a sacarla."],
  [/transfer_empty|kit_not_transferable|untracked_not_transferable/, "Ese producto no se puede trasladar."],
  [/single_store/, "Hace falta otra sucursal para pedir stock."],
  [/feature_not_in_plan: traslados|feature_not_in_plan: multi_sucursal/, "Pedir stock a otra sucursal llega con Traslados (plan con varias sucursales)."],
  [/feature_not_in_plan/, "Tu plan no incluye esta función."],
  [/note_required/, "Contá en una nota cómo se resolvió."],
  [/invalid_settings/, "Revisá la configuración: hay un valor que no corresponde."],
];

/** forbiddenText: qué decir cuando el servidor contesta "forbidden" a secas (rol). */
export function expeditionErrorMessage(e: unknown, forbiddenText = "Tu rol no puede hacer esto."): string {
  const role = roleErrorMessage(e);
  if (role) return role;
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) if (re.test(msg)) return text;
  if (/^forbidden$/.test(msg.trim())) return forbiddenText;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Sin conexión. Probá de nuevo cuando vuelva la señal.";
  return "No se pudo completar la operación.";
}
