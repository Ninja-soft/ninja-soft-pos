// lib/stock/transfers.ts
//
// Lógica PURA de traslados entre sucursales (F17 · H95, ADR-046). Espejo de la
// máquina de estados que hacen cumplir las RPC (migración 20261013200200): la
// UI la usa para mostrar sólo las acciones posibles, pero la barrera real es
// el servidor. Sin React ni Supabase: testeable.

import { roleErrorMessage } from "@/lib/permissions/errors";

export type TransferStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "in_transit"
  | "partially_received"
  | "received"
  | "cancelled";

export type TransferAction =
  | "edit"
  | "submit"
  | "approve"
  | "reject"
  | "reschedule"
  | "dispatch"
  | "receive"
  | "cancel";

export type TenantRole = "owner" | "manager" | "cashier" | "viewer";

export const TRANSFER_STATUSES: TransferStatus[] = [
  "draft",
  "pending_approval",
  "scheduled",
  "in_transit",
  "partially_received",
  "received",
  "cancelled",
];

export const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  draft: "Borrador",
  pending_approval: "Pendiente de aprobación",
  scheduled: "Programado",
  in_transit: "En tránsito",
  partially_received: "Recibido parcial",
  received: "Recibido",
  cancelled: "Cancelado",
};

export const TRANSFER_STATUS_TONE: Record<
  TransferStatus,
  "neutral" | "warning" | "info" | "brand" | "success" | "danger" | "gold"
> = {
  draft: "neutral",
  pending_approval: "gold",
  scheduled: "info",
  in_transit: "brand",
  partially_received: "warning",
  received: "success",
  cancelled: "danger",
};

/** Estados abiertos (todavía falta hacer algo). */
export const OPEN_STATUSES: TransferStatus[] = [
  "draft",
  "pending_approval",
  "scheduled",
  "in_transit",
  "partially_received",
];

// Transiciones permitidas por acción (sin mirar rol). `null` = no aplica.
const TRANSITIONS: Record<
  TransferAction,
  Partial<Record<TransferStatus, TransferStatus[]>>
> = {
  edit: { draft: ["draft"] },
  submit: { draft: ["pending_approval", "scheduled"] },
  approve: { pending_approval: ["scheduled"] },
  reject: { pending_approval: ["draft"] },
  reschedule: {
    draft: ["draft"],
    pending_approval: ["pending_approval"],
    scheduled: ["scheduled"],
  },
  dispatch: { scheduled: ["in_transit"] },
  receive: {
    in_transit: ["partially_received", "received"],
    partially_received: ["partially_received", "received"],
  },
  cancel: {
    draft: ["cancelled"],
    pending_approval: ["cancelled"],
    scheduled: ["cancelled"],
    in_transit: ["cancelled"],
  },
};

/** ¿La acción es válida desde ese estado? */
export function canTransition(
  status: TransferStatus,
  action: TransferAction,
): boolean {
  return Boolean(TRANSITIONS[action][status]);
}

/** Estados posibles después de aplicar la acción. Vacío si no aplica. */
export function nextStatuses(
  status: TransferStatus,
  action: TransferAction,
): TransferStatus[] {
  return TRANSITIONS[action][status] ?? [];
}

// ── Configuración y aprobación ──────────────────────────────────────────────

export interface TransferSettings {
  require_approval: boolean;
  approval_min_units: number | null;
  approval_min_value: number | null;
  cashier_can_dispatch: boolean;
  cashier_can_receive: boolean;
  allow_over_receive: boolean;
  require_difference_reason: boolean;
  block_dispatch_without_stock: boolean;
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  require_approval: false,
  approval_min_units: null,
  approval_min_value: null,
  cashier_can_dispatch: false,
  cashier_can_receive: true,
  allow_over_receive: true,
  require_difference_reason: true,
  block_dispatch_without_stock: true,
};

/**
 * ¿El traslado necesita aprobación? (espejo de transfer_needs_approval).
 * Con aprobación activa y sin umbrales, todos la necesitan; con umbrales, basta
 * con superar uno (unidades o valor a costo).
 */
export function needsApproval(
  s: TransferSettings,
  units: number,
  value: number,
): boolean {
  if (!s.require_approval) return false;
  if (s.approval_min_units == null && s.approval_min_value == null) return true;
  return (
    (s.approval_min_units != null && units >= s.approval_min_units) ||
    (s.approval_min_value != null && value >= s.approval_min_value)
  );
}

/** Estado al confirmar un borrador: el dueño no se pide aprobación a sí mismo. */
export function submitTarget(
  s: TransferSettings,
  units: number,
  value: number,
  role: TenantRole,
): TransferStatus {
  return needsApproval(s, units, value) && role !== "owner"
    ? "pending_approval"
    : "scheduled";
}

export interface TransferForActions {
  status: TransferStatus;
  created_by: string | null;
}

/** Acciones que el usuario puede ejecutar sobre el traslado (rol + estado). */
export function allowedActions(
  t: TransferForActions,
  role: TenantRole | null | undefined,
  userId: string | null | undefined,
  s: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): TransferAction[] {
  if (!role || role === "viewer") return [];
  const manage = role === "owner" || role === "manager";
  const out: TransferAction[] = [];
  const add = (a: TransferAction, ok: boolean) => {
    if (ok && canTransition(t.status, a)) out.push(a);
  };
  add("edit", manage);
  add("submit", manage);
  const approver =
    role === "owner" || (role === "manager" && t.created_by !== userId);
  add("approve", approver);
  add("reject", approver);
  add("reschedule", manage);
  add("dispatch", manage || (role === "cashier" && s.cashier_can_dispatch));
  add("receive", manage || (role === "cashier" && s.cashier_can_receive));
  add("cancel", manage);
  return out;
}

// ── Programación (vencimiento perezoso, sin cron) ──────────────────────────

export type DueState = "none" | "future" | "today" | "overdue";

/**
 * Estado de vencimiento de un traslado programado. `today` en formato
 * YYYY-MM-DD (fecha local del negocio). Sólo aplica antes de despachar.
 */
export function dueState(
  scheduledFor: string | null | undefined,
  status: TransferStatus,
  today: string,
): DueState {
  if (!["draft", "pending_approval", "scheduled"].includes(status))
    return "none";
  if (!scheduledFor) return status === "scheduled" ? "today" : "none";
  const d = scheduledFor.slice(0, 10);
  if (d < today) return "overdue";
  if (d === today) return "today";
  return "future";
}

export const DUE_LABEL: Record<DueState, string> = {
  none: "",
  future: "Programado",
  today: "Para despachar hoy",
  overdue: "Atrasado",
};

/** Fecha local YYYY-MM-DD (sin corrimiento por UTC). */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Recepción con diferencias ──────────────────────────────────────────────

export const DIFFERENCE_REASONS = [
  "faltante",
  "danado",
  "vencido",
  "error_despacho",
  "sobrante",
  "otro",
] as const;
export type DifferenceReason = (typeof DIFFERENCE_REASONS)[number];

export const DIFFERENCE_REASON_LABEL: Record<DifferenceReason, string> = {
  faltante: "Faltante",
  danado: "Dañado",
  vencido: "Vencido",
  error_despacho: "Error de despacho",
  sobrante: "Sobrante",
  otro: "Otro",
};

export interface ReceiveLineInput {
  /** Cantidad despachada (null = no se despachó). */
  dispatched: number | null;
  /** Ya recibido en recepciones anteriores. */
  received: number;
  /** Lo que llega ahora. */
  incoming: number;
  /** Motivo de diferencia (nuevo o el que ya tenía). */
  reason?: DifferenceReason | null;
}

export interface ReceiveLineResult {
  totalReceived: number;
  pending: number;
  /** recibido − despachado (negativo = faltante, positivo = sobrante). */
  difference: number;
  overReceived: boolean;
  needsReason: boolean;
}

export interface ReceiveOutcome {
  status: "partially_received" | "received";
  lines: ReceiveLineResult[];
  /** Error que daría el servidor, si lo hay. */
  error:
    | null
    | "invalid_qty"
    | "over_receive_not_allowed"
    | "difference_reason_required"
    | "nothing_to_receive";
}

/** Simula transfer_receive: estado resultante, diferencias y validaciones. */
export function receiveOutcome(
  lines: ReceiveLineInput[],
  close: boolean,
  s: TransferSettings = DEFAULT_TRANSFER_SETTINGS,
): ReceiveOutcome {
  let error: ReceiveOutcome["error"] = null;
  let got = 0;
  const results = lines.map((l) => {
    const dispatched = l.dispatched ?? 0;
    if (l.incoming < 0) error = error ?? "invalid_qty";
    const totalReceived = l.received + Math.max(0, l.incoming);
    got += Math.max(0, l.incoming);
    const overReceived = totalReceived > dispatched;
    if (overReceived && !s.allow_over_receive)
      error = error ?? "over_receive_not_allowed";
    const difference = round3(totalReceived - dispatched);
    return {
      totalReceived,
      pending: Math.max(0, round3(dispatched - totalReceived)),
      difference,
      overReceived,
      needsReason: l.dispatched != null && difference !== 0 && !l.reason,
    };
  });
  const open = results.some((r) => r.pending > 0);
  const closing = close || !open;
  if (closing) {
    if (
      !error &&
      s.require_difference_reason &&
      results.some((r) => r.needsReason)
    ) {
      error = "difference_reason_required";
    }
    return { status: "received", lines: results, error };
  }
  if (!error && got <= 0) error = "nothing_to_receive";
  return { status: "partially_received", lines: results, error };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Remito ─────────────────────────────────────────────────────────────────

/** Número de remito interno (mismo formato que las notas del movimiento). */
export function formatRemitoNumber(n: number): string {
  return `R-${String(Math.max(0, Math.trunc(n))).padStart(6, "0")}`;
}

// ── Errores del servidor → mensaje para el usuario ─────────────────────────

const ERROR_MESSAGES: Array<[RegExp, string]> = [
  [
    /feature_not_in_plan: traslados/,
    "Los traslados no están incluidos en tu plan.",
  ],
  [
    /feature_not_in_plan: stock_sucursales/,
    "El stock por sucursal no está incluido en tu plan.",
  ],
  [
    /feature_not_in_plan: multi_sucursal/,
    "Tu plan no incluye varias sucursales.",
  ],
  [
    /single_store/,
    "Necesitás al menos dos sucursales activas para trasladar stock.",
  ],
  [/same_store/, "El origen y el destino tienen que ser sucursales distintas."],
  [/stores_required/, "Elegí la sucursal de origen y la de destino."],
  [/store_not_found/, "La sucursal no existe o está inactiva."],
  [
    /forbidden_approval/,
    "Lo aprueba el dueño o un encargado distinto de quien lo armó.",
  ],
  [/forbidden/, "No tenés permiso para esta acción."],
  [
    /invalid_transition/,
    "El traslado cambió de estado. Actualizá la pantalla.",
  ],
  [/transfer_not_found/, "No encontramos el traslado."],
  [/transfer_empty/, "Agregá al menos un producto."],
  [
    /kit_not_transferable/,
    "Los kits no se trasladan: trasladá sus componentes.",
  ],
  [/untracked_not_transferable/, "Ese producto no controla stock."],
  [/variant_required/, "Elegí la variante (talle, color) del producto."],
  [
    /variant_not_found|variant_not_allowed/,
    "La variante no corresponde al producto.",
  ],
  [/product_not_found/, "Un producto ya no existe."],
  [
    /insufficient_stock_origin/,
    "No hay stock suficiente en el origen para despachar.",
  ],
  [/nothing_to_dispatch/, "No hay nada para despachar."],
  [/nothing_to_receive/, "Indicá cuánto llegó."],
  [/over_receive_not_allowed/, "No se puede recibir más de lo despachado."],
  [/difference_reason_required/, "Indicá el motivo de cada diferencia."],
  [/reason_required/, "Indicá el motivo."],
  [/item_not_found/, "Una línea ya no existe. Actualizá la pantalla."],
  [/invalid_qty|invalid_items/, "Revisá las cantidades."],
  [/min_greater_than_max/, "El mínimo no puede ser mayor que el máximo."],
];

export function transferErrorMessage(e: unknown): string {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e ?? "");
  const byRole = roleErrorMessage(msg);
  if (byRole) return byRole;
  for (const [re, text] of ERROR_MESSAGES) if (re.test(msg)) return text;
  return msg || "No se pudo completar la acción.";
}
