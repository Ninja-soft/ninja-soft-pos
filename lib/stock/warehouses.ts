// Depósitos internos de una sucursal (F11 · H33, ADR-085). Puro: sin React ni
// Supabase, para testearlo.
//
// El principal (salón de ventas) no guarda saldo: es lo que queda de la
// sucursal después de los otros depósitos y de lo que está en tránsito. Lo
// calcula el servidor (warehouse_principal_qty); acá se espeja para la UI y se
// arman las sugerencias de reposición del salón.
import { roleErrorMessage } from "@/lib/permissions/errors";

export type WarehouseKind = "principal" | "reserva" | "devolucion" | "merma" | "otro";
export type WarehouseMoveStatus = "in_transit" | "partially_received" | "received" | "cancelled";
export type WarehouseMoveReason = "reposicion" | "reserva" | "devolucion" | "merma" | "reorganizacion" | "otro";
export type WarehouseDifferenceReason = "faltante" | "danado" | "vencido" | "sobrante" | "error" | "otro";

export interface Warehouse {
  id: string;
  store_id: string;
  name: string;
  code: string | null;
  kind: WarehouseKind;
  sort: number;
}

/** Fila de warehouse_stock_overview. */
export interface WarehouseOverviewRow {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  store_qty: number;
  principal_qty: number;
  in_transit: number;
  min_qty: number | null;
  max_qty: number | null;
  /** warehouse_id → cantidad (sólo depósitos que no son el principal). */
  by_warehouse: Record<string, number>;
}

export const WAREHOUSE_KIND_LABEL: Record<WarehouseKind, string> = {
  principal: "Salón de ventas",
  reserva: "Reserva",
  devolucion: "Devoluciones",
  merma: "Merma",
  otro: "Otro",
};

/** Tipos que el usuario puede crear (el principal se crea solo). */
export const CREATABLE_KINDS: Exclude<WarehouseKind, "principal">[] = ["reserva", "devolucion", "merma", "otro"];

/** Depósitos desde donde tiene sentido reponer el salón (no merma ni devoluciones). */
export const REPLENISH_SOURCE_KINDS: WarehouseKind[] = ["reserva", "otro"];

export const MOVE_STATUS_LABEL: Record<WarehouseMoveStatus, string> = {
  in_transit: "En tránsito",
  partially_received: "Recibido en parte",
  received: "Recibido",
  cancelled: "Cancelado",
};

export const MOVE_REASON_LABEL: Record<WarehouseMoveReason, string> = {
  reposicion: "Reposición del salón",
  reserva: "Guardar en reserva",
  devolucion: "Devolución",
  merma: "Merma o rotura",
  reorganizacion: "Reorganización",
  otro: "Otro",
};

export const DIFFERENCE_REASON_LABEL: Record<WarehouseDifferenceReason, string> = {
  faltante: "Faltante",
  danado: "Dañado",
  vencido: "Vencido",
  sobrante: "Sobrante",
  error: "Error al despachar",
  otro: "Otro",
};

/** Etiqueta del tipo a partir del texto de la planilla ("Devoluciones" → devolucion). */
export function parseWarehouseKind(raw: string | null | undefined): Exclude<WarehouseKind, "principal"> | null {
  if (!raw) return null;
  const v = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!v) return null;
  if (v.startsWith("reserva")) return "reserva";
  if (v.startsWith("devoluc")) return "devolucion";
  if (v.startsWith("merma") || v.startsWith("rotura")) return "merma";
  if (v.startsWith("otro")) return "otro";
  return null;
}

/** Orden: principal primero, después por sort y nombre. */
export function sortWarehouses<T extends Pick<Warehouse, "kind" | "sort" | "name">>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.kind === "principal" && b.kind !== "principal") return -1;
    if (b.kind === "principal" && a.kind !== "principal") return 1;
    return a.sort - b.sort || a.name.localeCompare(b.name, "es");
  });
}

/** Cantidad de un ítem en un depósito (el principal sale de la fila). */
export function qtyIn(row: WarehouseOverviewRow, w: Pick<Warehouse, "id" | "kind">): number {
  if (w.kind === "principal") return Number(row.principal_qty);
  return Number(row.by_warehouse?.[w.id] ?? 0);
}

/**
 * Espejo de warehouse_principal_qty: sucursal − otros depósitos − tránsito.
 * Puede dar negativo (se vendió más de lo que había en el salón).
 */
export function principalQty(storeQty: number, byWarehouse: Record<string, number>, inTransit: number): number {
  const others = Object.values(byWarehouse ?? {}).reduce((a, b) => a + Number(b || 0), 0);
  return round3(Number(storeQty) - others - Number(inTransit || 0));
}

export type SalonStatus = "negative" | "below_min" | "ok";

/** Estado del salón para la tabla: negativo, bajo el mínimo u ok. */
export function salonStatus(row: Pick<WarehouseOverviewRow, "principal_qty" | "min_qty">): SalonStatus {
  const p = Number(row.principal_qty);
  if (p < 0) return "negative";
  if (row.min_qty != null && Number(row.min_qty) > 0 && p < Number(row.min_qty)) return "below_min";
  return "ok";
}

export interface ReplenishSuggestion {
  product_id: string;
  variant_id: string | null;
  name: string;
  /** Depósito de origen sugerido. */
  from_warehouse_id: string;
  qty: number;
  /** Lo que habría en el salón después de reponer. */
  principal_after: number;
}

/**
 * Reposición del salón: para cada ítem con el salón negativo o bajo su mínimo,
 * sugiere traer hasta el objetivo (máximo si hay, si no el mínimo; si no hay
 * mínimo y está negativo, hasta 0) desde los depósitos de reserva, el de más
 * stock primero. Nunca sugiere más de lo que hay en el origen; un faltante
 * puede repartirse entre dos depósitos (dos sugerencias).
 */
export function replenishSuggestions(
  rows: WarehouseOverviewRow[],
  warehouses: Pick<Warehouse, "id" | "kind">[],
): ReplenishSuggestion[] {
  const sources = warehouses.filter((w) => REPLENISH_SOURCE_KINDS.includes(w.kind));
  const out: ReplenishSuggestion[] = [];
  for (const row of rows) {
    const status = salonStatus(row);
    if (status === "ok") continue;
    const principal = Number(row.principal_qty);
    const min = row.min_qty != null ? Number(row.min_qty) : 0;
    const max = row.max_qty != null ? Number(row.max_qty) : null;
    const target = Math.max(max != null && max > min ? max : min, 0);
    let need = round3(target - principal);
    if (need <= 0) continue;
    const available = sources
      .map((w) => ({ id: w.id, qty: Number(row.by_warehouse?.[w.id] ?? 0) }))
      .filter((s) => s.qty > 0)
      .sort((a, b) => b.qty - a.qty);
    let after = principal;
    for (const s of available) {
      if (need <= 0) break;
      const qty = round3(Math.min(need, s.qty));
      after = round3(after + qty);
      need = round3(need - qty);
      out.push({
        product_id: row.product_id,
        variant_id: row.variant_id,
        name: row.variant_label ? `${row.product_name} (${row.variant_label})` : row.product_name,
        from_warehouse_id: s.id,
        qty,
        principal_after: after,
      });
    }
  }
  return out;
}

/** Agrupa sugerencias por depósito de origen (un movimiento por origen). */
export function groupSuggestionsBySource(list: ReplenishSuggestion[]): Map<string, ReplenishSuggestion[]> {
  const map = new Map<string, ReplenishSuggestion[]>();
  for (const s of list) {
    const arr = map.get(s.from_warehouse_id) ?? [];
    arr.push(s);
    map.set(s.from_warehouse_id, arr);
  }
  return map;
}

export interface MoveItemState {
  id: string;
  qty_sent: number;
  qty_received: number;
}

export interface ReceiveInput {
  item_id: string;
  /** Cantidad que se recibe ahora (se suma a lo ya recibido). */
  qty: number;
  reason?: WarehouseDifferenceReason | null;
}

export interface ReceiveCheck {
  /** Al cerrar, líneas con diferencia (positiva = sobrante). */
  differences: { item_id: string; diff: number }[];
  /** Errores que el servidor rechazaría (mensajes en español). */
  errors: string[];
  /** ¿Queda todo recibido sin diferencias (cierra solo)? */
  completes: boolean;
}

/**
 * Espejo de las reglas de warehouse_move_receive para validar antes de mandar:
 * sin cerrar no se recibe de más; al cerrar, cada diferencia lleva motivo
 * (sobrante sólo para lo recibido de más, y al revés).
 */
export function checkReceive(items: MoveItemState[], inputs: ReceiveInput[], close: boolean): ReceiveCheck {
  const byId = new Map(inputs.map((i) => [i.item_id, i]));
  const errors: string[] = [];
  const differences: { item_id: string; diff: number }[] = [];
  let completes = true;
  for (const it of items) {
    const input = byId.get(it.id);
    const add = Number(input?.qty ?? 0);
    if (add < 0) errors.push("Las cantidades no pueden ser negativas.");
    const total = round3(Number(it.qty_received) + add);
    if (total > Number(it.qty_sent) && !close) {
      errors.push("Para recibir más de lo enviado hay que cerrar el movimiento con el sobrante.");
    }
    const diff = round3(total - Number(it.qty_sent));
    if (diff !== 0) {
      completes = false;
      if (close) {
        differences.push({ item_id: it.id, diff });
        const reason = input?.reason ?? null;
        if (!reason) errors.push("Indicá el motivo de cada diferencia.");
        else if (diff > 0 && reason !== "sobrante") errors.push("Lo recibido de más va con el motivo Sobrante.");
        else if (diff < 0 && reason === "sobrante") errors.push("Un faltante no puede ir con el motivo Sobrante.");
      }
    }
  }
  return { differences, errors: [...new Set(errors)], completes };
}

const ERROR_MESSAGES: [RegExp, string][] = [
  [/feature_not_in_plan: depositos/, "Tu plan no incluye depósitos internos."],
  [/feature_not_in_plan: stock_sucursales/, "Para usar depósitos en otra sucursal hace falta el stock por sucursal."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
  [/forbidden_differences/, "Sólo el dueño o un encargado pueden cerrar con diferencias."],
  [/insufficient_warehouse_stock/, "No hay stock suficiente en el depósito de origen."],
  [/warehouse_has_stock/, "El depósito todavía tiene stock. Movelo antes de darlo de baja."],
  [/warehouse_has_open_moves/, "El depósito tiene movimientos en tránsito."],
  [/warehouse_principal_in_use/, "El salón de ventas no se da de baja mientras haya otros depósitos."],
  [/warehouse_principal_is_computed/, "El stock del salón se calcula solo: ajustá la sucursal o mové desde otro depósito."],
  [/different_store/, "Entre sucursales se usa un traslado."],
  [/same_warehouse/, "El origen y el destino tienen que ser distintos."],
  [/over_receive_requires_close/, "Para recibir más de lo enviado hay que cerrar el movimiento con el sobrante."],
  [/difference_reason_required/, "Indicá el motivo de cada diferencia (Sobrante sólo para lo recibido de más)."],
  [/invalid_transition/, "El movimiento ya no está en ese estado. Actualizá la página."],
  [/reason_required/, "Indicá el motivo."],
  [/name_required/, "Poné un nombre."],
  [/warehouses_store_name_key|duplicate key.*name/, "Ya hay un depósito con ese nombre en la sucursal."],
  [/warehouses_tenant_code_key|duplicate key.*code/, "Ya hay un depósito con ese código."],
  [/kit_not_transferable/, "Los kits no se mueven: mové sus componentes."],
  [/untracked_not_transferable/, "Ese producto no controla stock."],
  [/variant_required/, "Elegí la variante (talle o color)."],
  [/invalid_qty/, "Revisá las cantidades."],
];

export function warehouseErrorMessage(e: unknown): string {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e ?? "");
  for (const [re, text] of ERROR_MESSAGES) if (re.test(msg)) return text;
  const byRole = roleErrorMessage(msg);
  if (byRole) return byRole;
  return msg || "No se pudo completar la acción.";
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
