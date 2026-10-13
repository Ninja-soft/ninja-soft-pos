// Operaciones de salón (F13 · H44/H45): mover/unir mesas y anulación de ítems
// enviados. Helpers puros que espejan las reglas del servidor
// (migraciones 20261105200000_mesas_mover_unir y 20261105200100_comanda_anulaciones)
// para que la UI ofrezca sólo lo que la RPC va a aceptar.

export interface TableLike {
  id: string;
  label: string;
  status: string;
  current_order_id: string | null;
  area_id: string | null;
}

export type MoveMode = "mover" | "unir";

export interface MoveTarget<T extends TableLike> {
  table: T;
  mode: MoveMode;
}

// Destinos posibles desde una mesa: libres (mover el pedido entero) u ocupadas
// (unir cuentas). Nunca la misma mesa, bloqueadas ni reservadas.
export function moveTargets<T extends TableLike>(tables: T[], sourceTableId: string): MoveTarget<T>[] {
  return tables
    .filter((t) => t.id !== sourceTableId)
    .filter((t) => t.status !== "bloqueada" && t.status !== "reservada")
    .map((t) => ({ table: t, mode: (t.current_order_id ? "unir" : "mover") as MoveMode }))
    .sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "mover" ? -1 : 1;
      return a.table.label.localeCompare(b.table.label, "es", { numeric: true });
    });
}

// Un ítem está ENVIADO si la comanda se imprimió o la cocina ya lo tocó.
// Mismo criterio que _dining_item_sent en SQL.
export function isItemSent(item: { printed_at?: string | null; kds_status?: string | null }): boolean {
  return Boolean(item.printed_at) || (item.kds_status ?? "pendiente") !== "pendiente";
}

export const VOID_REASONS = [
  "Error de carga",
  "El cliente cambió el pedido",
  "Demora",
  "Plato con problema",
  "Invitación de la casa",
] as const;

export const VOID_REASON_MIN = 3;

export function validateVoid(
  itemQty: number,
  qty: number,
  reason: string,
): { ok: true } | { ok: false; error: string } {
  if (reason.trim().length < VOID_REASON_MIN) return { ok: false, error: "Indicá el motivo de la anulación" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "La cantidad tiene que ser mayor a cero" };
  if (qty > itemQty) return { ok: false, error: "No podés anular más de lo cargado" };
  return { ok: true };
}

// Mensajes de los códigos estables de las RPCs de salón.
const DINING_ERRORS: [string, string][] = [
  ["item_sent_use_void", "El ítem ya está en cocina: anulalo con un motivo"],
  ["void_reason_required", "Indicá el motivo de la anulación"],
  ["same_table", "Elegí otra mesa"],
  ["table_blocked", "La mesa destino está bloqueada"],
  ["table_reserved", "La mesa destino está reservada"],
  ["table_not_free", "La mesa ya no está libre"],
  ["table_has_open_order", "La mesa destino ya tiene un pedido abierto"],
  ["target_order_not_open", "El pedido de la mesa destino ya no está abierto"],
  ["items_from_several_orders", "Los ítems tienen que ser de la misma mesa"],
  ["order_not_open", "El pedido ya no está abierto"],
  ["waiter_not_member", "Ese mozo no es parte del equipo activo"],
  ["waitlist_closed", "Ese grupo ya no está esperando"],
  ["invalid_qty", "Cantidad inválida"],
  // Cuenta por comensal (ADR-097).
  ["order_has_open_splits", "Hay cuentas separadas sin cobrar: cobralas o deshacelas primero"],
  ["split_use_unsplit", "Una cuenta separada se deshace, no se cancela"],
  ["order_is_split", "Esa ya es una cuenta separada"],
  ["duplicated_item", "Un ítem aparece dos veces"],
  ["invalid_diner", "Comensal inválido"],
  ["invalid_priority", "Prioridad inválida"],
  ["notice_closed", "Ese aviso ya se envió o se descartó"],
  ["notice_not_found", "No se encontró el aviso"],
];

export function diningErrorMessage(e: unknown): string | undefined {
  const raw = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "";
  if (!raw) return undefined;
  const hit = DINING_ERRORS.find(([code]) => raw.includes(code));
  return hit ? hit[1] : raw;
}
