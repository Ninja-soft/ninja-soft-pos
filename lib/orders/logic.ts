// =============================================================================
// Pedidos de salón y expedición (F11 · H32, ADR-129). PURO.
//
// Espejos del SQL (20261123100100_pedidos_despacho), con tests que los comparan:
//   * orderConfig      ↔ pos_order_config (defaults y topes de la config).
//   * dispatchCanMove  ↔ _dispatch_can (transiciones de la expedición).
// Más etiquetas, el armado de los renglones a reservar desde el carrito, el
// disponible (stock − reservado) y los textos de error.
// =============================================================================

export type DeliveryType = "inmediato" | "retiro" | "envio";
export type OrderStatus = "abierto" | "tomado" | "cobrado" | "anulado" | "vencido";
export type DispatchStatus =
  | "pendiente"
  | "armando"
  | "listo"
  | "en_transito"
  | "entregado"
  | "despachado"
  | "cancelado";
export type ExpiryAction = "release" | "cancel";

export const DELIVERY_TYPES: DeliveryType[] = ["inmediato", "retiro", "envio"];

export const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = {
  inmediato: "Retira ahora",
  retiro: "Retira después",
  envio: "Envío a domicilio",
};

export const DELIVERY_TYPE_HINT: Record<DeliveryType, string> = {
  inmediato: "El cliente paga y se lo lleva en el momento.",
  retiro: "Lo retira más tarde en la sucursal, con código o a su nombre.",
  envio: "Se despacha al domicilio del cliente.",
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  abierto: "Esperando caja",
  tomado: "En caja",
  cobrado: "Cobrado",
  anulado: "Anulado",
  vencido: "Vencido",
};

export const DISPATCH_STATUS_LABEL: Record<DispatchStatus, string> = {
  pendiente: "Pendiente",
  armando: "Armando",
  listo: "Listo",
  en_transito: "En camino",
  entregado: "Entregado",
  despachado: "Despachado",
  cancelado: "Cancelado",
};

export const DISPATCH_FINAL: DispatchStatus[] = ["entregado", "despachado", "cancelado"];

// ── Configuración (pos_settings.order_config) ───────────────────────────────

export interface OrderConfig {
  reservation_minutes: number;
  expiry_action: ExpiryAction;
  /** Retiro inmediato también pasa por la cola de expedición. */
  immediate_via_dispatch: boolean;
  delivery_types: {
    inmediato: { enabled: boolean; cross_branch: false };
    retiro: { enabled: boolean; cross_branch: boolean; pickup_code: boolean };
    envio: { enabled: boolean; cross_branch: boolean };
  };
}

export const ORDER_MINUTES_MIN = 5;
export const ORDER_MINUTES_MAX = 1440;

export const DEFAULT_ORDER_CONFIG: OrderConfig = {
  reservation_minutes: 30,
  expiry_action: "release",
  immediate_via_dispatch: true,
  delivery_types: {
    inmediato: { enabled: true, cross_branch: false },
    retiro: { enabled: true, cross_branch: false, pickup_code: true },
    envio: { enabled: true, cross_branch: false },
  },
};

function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function bool(o: Record<string, unknown>, k: string, d: boolean): boolean {
  return typeof o[k] === "boolean" ? (o[k] as boolean) : d;
}

/** Config efectiva con defaults y topes. Espejo de pos_order_config (SQL). */
export function orderConfig(raw: unknown): OrderConfig {
  const r = obj(raw);
  const dt = obj(r.delivery_types);
  const rawMin = r.reservation_minutes;
  const n =
    (typeof rawMin === "number" && Number.isInteger(rawMin) && rawMin >= 0) ||
    (typeof rawMin === "string" && /^[0-9]{1,5}$/.test(rawMin))
      ? Number(rawMin)
      : DEFAULT_ORDER_CONFIG.reservation_minutes;
  const inm = obj(dt.inmediato);
  const ret = obj(dt.retiro);
  const env = obj(dt.envio);
  return {
    reservation_minutes: Math.min(Math.max(n, ORDER_MINUTES_MIN), ORDER_MINUTES_MAX),
    expiry_action: r.expiry_action === "cancel" ? "cancel" : "release",
    immediate_via_dispatch: bool(r, "immediate_via_dispatch", true),
    delivery_types: {
      inmediato: { enabled: bool(inm, "enabled", true), cross_branch: false },
      retiro: {
        enabled: bool(ret, "enabled", true),
        cross_branch: bool(ret, "cross_branch", false),
        pickup_code: bool(ret, "pickup_code", true),
      },
      envio: { enabled: bool(env, "enabled", true), cross_branch: bool(env, "cross_branch", false) },
    },
  };
}

export function enabledDeliveryTypes(cfg: OrderConfig): DeliveryType[] {
  return DELIVERY_TYPES.filter((t) => cfg.delivery_types[t].enabled);
}

export function crossBranchAllowed(cfg: OrderConfig, type: DeliveryType): boolean {
  return type !== "inmediato" && cfg.delivery_types[type].cross_branch;
}

// ── Expedición ──────────────────────────────────────────────────────────────

/** Transiciones de la expedición. Espejo de _dispatch_can (SQL). */
export function dispatchCanMove(
  from: DispatchStatus,
  to: DispatchStatus,
  type: DeliveryType,
  cross: boolean,
  arrived: boolean,
): boolean {
  if (DISPATCH_FINAL.includes(from)) return false;
  if (to === "cancelado") return true;
  switch (from) {
    case "pendiente":
      return to === "armando" || to === "listo";
    case "armando":
      return to === "pendiente" || to === "listo";
    case "en_transito":
      return to === "listo";
    case "listo":
      if (to === "armando") return !(cross && arrived);
      if (to === "en_transito") return cross && !arrived;
      if (to === "entregado") return (type === "inmediato" || type === "retiro") && (!cross || arrived);
      if (to === "despachado") return type === "envio" && (!cross || arrived);
      return false;
    default:
      return false;
  }
}

export interface DispatchLike {
  status: DispatchStatus;
  delivery_type: DeliveryType;
  store_id: string;
  fulfillment_store_id: string;
  arrived_at: string | null;
}

export type DispatchAction = "armando" | "listo" | "en_transito" | "recibir" | "entregar" | "despachar";

/** Acción principal de una entrega (el botón grande de la tarjeta). */
export function primaryDispatchAction(d: DispatchLike): DispatchAction | null {
  const cross = d.fulfillment_store_id !== d.store_id;
  const arrived = Boolean(d.arrived_at);
  switch (d.status) {
    case "pendiente":
      return "armando";
    case "armando":
      return "listo";
    case "en_transito":
      return "recibir";
    case "listo":
      if (cross && !arrived) return "en_transito";
      return d.delivery_type === "envio" ? "despachar" : "entregar";
    default:
      return null;
  }
}

export const DISPATCH_ACTION_LABEL: Record<DispatchAction, string> = {
  armando: "Empezar a armar",
  listo: "Marcar listo",
  en_transito: "Enviar a la sucursal",
  recibir: "Recibido en la sucursal",
  entregar: "Entregar",
  despachar: "Marcar despachado",
};

/** ¿Lo ve como "para hacer" la sucursal elegida? (la que vende o la que entrega). */
export function dispatchIsForStore(d: DispatchLike, storeId: string | null): boolean {
  if (!storeId) return true;
  if (d.status === "en_transito") return d.fulfillment_store_id === storeId || d.store_id === storeId;
  if (d.fulfillment_store_id !== d.store_id && d.arrived_at) return d.fulfillment_store_id === storeId;
  return d.store_id === storeId || d.fulfillment_store_id === storeId;
}

// ── Pedido ──────────────────────────────────────────────────────────────────

export interface OrderItemInput {
  product_id: string;
  variant_id: string | null;
  qty: number;
}

/**
 * Renglones a reservar desde el carrito: líneas con producto, sin regalos de
 * promo ni sesiones de pack (no son stock que se compromete aparte), sumadas
 * por producto y variante. El servidor además saca kits, servicios y
 * productos que no controlan stock.
 */
export function orderItemsFromCart(
  lines: {
    productId: string | null;
    variantId?: string | null;
    quantity: number;
    giftPromoId?: string | null;
    packCreditId?: string | null;
  }[],
): OrderItemInput[] {
  const map = new Map<string, OrderItemInput>();
  for (const l of lines) {
    if (!l.productId || l.giftPromoId || l.packCreditId) continue;
    const qty = Number(l.quantity) || 0;
    if (qty <= 0) continue;
    const key = `${l.productId}:${l.variantId ?? ""}`;
    const prev = map.get(key);
    if (prev) prev.qty = Math.round((prev.qty + qty) * 1000) / 1000;
    else map.set(key, { product_id: l.productId, variant_id: l.variantId ?? null, qty });
  }
  return [...map.values()];
}

export interface OrderReservationLike {
  status: OrderStatus;
  reservation_id: string | null;
  reserved_until: string | null;
  reservation_released_at: string | null;
}

export type ReservationState =
  | { kind: "none" }
  | { kind: "active"; msLeft: number }
  | { kind: "released" };

export function orderReservationState(o: OrderReservationLike, now: Date = new Date()): ReservationState {
  if (!o.reservation_id) return { kind: "none" };
  if (o.reservation_released_at) return { kind: "released" };
  const until = o.reserved_until ? new Date(o.reserved_until).getTime() : 0;
  const left = until - now.getTime();
  return left > 0 ? { kind: "active", msLeft: left } : { kind: "released" };
}

export function minutesLeftLabel(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min >= 120) return `${Math.floor(min / 60)} h`;
  if (min >= 60) return `1 h ${min - 60 > 0 ? `${min - 60} min` : ""}`.trim();
  return `${Math.max(min, 1)} min`;
}

export function reservationLabel(o: OrderReservationLike, now: Date = new Date()): string {
  const s = orderReservationState(o, now);
  if (s.kind === "none") return "Sin reserva de stock";
  if (s.kind === "released") return "Reserva liberada: se cobra si hay stock";
  return `Stock reservado, vence en ${minutesLeftLabel(s.msLeft)}`;
}

export function orderIsOpen(o: { status: OrderStatus }): boolean {
  return o.status === "abierto" || o.status === "tomado";
}

/** Disponible para vender = stock − reservado vigente (nunca muestra menos de lo que hay en negativo). */
export function availableStock(stock: number, reserved: number): number {
  const s = Number(stock) || 0;
  const r = Math.max(Number(reserved) || 0, 0);
  return Math.round((s - r) * 1000) / 1000;
}

/** Suma lo reservado por producto (todas las variantes) de una sucursal o de todas. */
export function reservedByProduct(
  rows: { store_id: string; product_id: string; variant_id: string | null; reserved: number }[],
  storeId: string | null,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (storeId && r.store_id !== storeId) continue;
    m.set(r.product_id, (m.get(r.product_id) ?? 0) + (Number(r.reserved) || 0));
  }
  return m;
}

// ── Errores ─────────────────────────────────────────────────────────────────

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: pedidos_despacho/, "Los pedidos de salón no están incluidos en tu plan."],
  [/insufficient_available_stock: ?(.*)/, "No hay stock libre para reservar $1."],
  [/cross_branch_not_allowed/, "Ese tipo de entrega no se puede hacer en otra sucursal (revisá Configuración)."],
  [/delivery_type_disabled/, "Ese tipo de entrega está apagado en Configuración."],
  [/ship_address_required/, "Cargá el domicilio del envío."],
  [/pickup_name_required/, "Cargá a nombre de quién se retira."],
  [/cart_required/, "El pedido no tiene productos."],
  [/seller_not_found/, "No encontramos al vendedor."],
  [/customer_not_found/, "No encontramos al cliente."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
  [/store_not_found/, "No encontramos la sucursal."],
  [/order_not_found/, "No encontramos el pedido."],
  [/order_already_paid/, "Ese pedido ya está cobrado."],
  [/order_closed/, "Ese pedido ya no está abierto (anulado o vencido)."],
  [/order_taken_by_other/, "Otra caja está cobrando ese pedido."],
  [/sale_wrong_store/, "La venta tiene que ser de la sucursal del pedido."],
  [/sale_already_used/, "Esa venta ya está enlazada a otro pedido."],
  [/sale_already_dispatched/, "Esa venta ya está en expedición."],
  [/sale_not_completed/, "Esa venta está anulada."],
  [/sale_not_found/, "No encontramos esa venta."],
  [/dispatch_not_found/, "No encontramos la entrega."],
  [/invalid_transition/, "La entrega ya cambió de estado: actualizá la lista."],
  [/delivered_to_required/, "Cargá quién retira."],
  [/override_requires_manager/, "Entregar sin código pide un dueño o encargado."],
  [/cancel_requires_manager/, "Cancelar una entrega es de un dueño o encargado."],
  [/shipment_not_found/, "Ese envío no es de esta venta."],
  [/reason_required/, "Contá el motivo."],
  [/forbidden|role_forbidden/, "Tu rol no puede hacer esto."],
];

export function orderErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) {
    const m = msg.match(re);
    if (m) return text.replace("$1", (m[1] ?? "").trim());
  }
  return "No se pudo completar la operación.";
}

export function pickupFailureText(error: string, attemptsLeft: number): string {
  if (error === "pickup_code_locked") {
    return "El código quedó bloqueado por intentos fallidos. Puede entregar un dueño o encargado con motivo.";
  }
  return attemptsLeft === 1 ? "Código incorrecto. Queda 1 intento." : `Código incorrecto. Quedan ${attemptsLeft} intentos.`;
}
