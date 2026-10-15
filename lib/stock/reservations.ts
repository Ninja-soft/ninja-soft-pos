// Reservas de stock y retiro en tienda (F16 · H77, ADR-091). Helpers PUROS:
// etiquetas, validación del borrador antes de llamar a la RPC, estado
// efectivo (vencida aunque el servidor todavía no la pasó) y mensajes de
// error. Toda regla real la valida el servidor (stock_reservation_*).

export type ReservationStatus = "reservada" | "preparada" | "entregada" | "cancelada" | "vencida";
export type ReservationChannel = "mostrador" | "telefono" | "whatsapp" | "web" | "otra_sucursal";

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  reservada: "Reservada",
  preparada: "Lista para retirar",
  entregada: "Entregada",
  cancelada: "Cancelada",
  vencida: "Vencida",
};

export const RESERVATION_CHANNEL_LABEL: Record<ReservationChannel, string> = {
  mostrador: "Mostrador",
  telefono: "Teléfono",
  whatsapp: "WhatsApp",
  web: "Web",
  otra_sucursal: "Otra sucursal",
};

export interface StockReservationItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  qty: number;
  unit_price: number;
  sort: number;
}

export interface StockReservation {
  id: string;
  number: number;
  store_id: string;
  origin_store_id: string | null;
  /** 'pedido': la creó un pedido de salón (H32, ADR-129); no se elige a mano. */
  channel: ReservationChannel | "pedido";
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_doc: string | null;
  failed_attempts: number;
  status: ReservationStatus;
  expires_at: string;
  notes: string | null;
  total_units: number;
  total_value: number;
  sale_id: string | null;
  cancel_reason: string | null;
  created_at: string;
  prepared_at: string | null;
  delivered_at: string | null;
  items: StockReservationItem[];
}

export interface ReservationDraftLine {
  product_id: string;
  variant_id: string | null;
  qty: number;
  available?: number | null;
}

export interface ReservationDraft {
  storeId: string | null;
  customerName: string;
  customerDoc: string;
  lines: ReservationDraftLine[];
  hours: number;
}

export const MAX_RESERVATION_HOURS = 24 * 30;

/** Sólo dígitos (DNI o CUIT sin puntos ni guiones). */
export function normalizeDoc(doc: string | null | undefined): string {
  return (doc ?? "").replace(/\D/g, "");
}

/** Errores del borrador (vacío = se puede enviar). */
export function validateReservationDraft(d: ReservationDraft): string[] {
  const errors: string[] = [];
  if (!d.storeId) errors.push("Elegí la sucursal donde retira.");
  if (!d.customerName.trim()) errors.push("Cargá el nombre del cliente.");
  const doc = normalizeDoc(d.customerDoc);
  if (doc && !/^[0-9]{6,11}$/.test(doc)) errors.push("El documento tiene que tener entre 6 y 11 números.");
  if (d.lines.length === 0) errors.push("Agregá al menos un producto.");
  const seen = new Set<string>();
  for (const l of d.lines) {
    const key = `${l.product_id}:${l.variant_id ?? ""}`;
    if (seen.has(key)) {
      errors.push("Hay un producto repetido: sumá la cantidad en una sola línea.");
      break;
    }
    seen.add(key);
  }
  if (d.lines.some((l) => !(l.qty > 0))) errors.push("Las cantidades tienen que ser mayores a cero.");
  if (d.lines.some((l) => l.available != null && l.qty > l.available)) {
    errors.push("Hay productos sin disponible suficiente en esa sucursal.");
  }
  if (!(d.hours >= 1) || d.hours > MAX_RESERVATION_HOURS) errors.push("La reserva dura entre 1 hora y 30 días.");
  return errors;
}

/** Estado efectivo: una reserva vigente cuyo vencimiento pasó se ve vencida. */
export function effectiveStatus(r: Pick<StockReservation, "status" | "expires_at">, now: Date = new Date()): ReservationStatus {
  if ((r.status === "reservada" || r.status === "preparada") && new Date(r.expires_at).getTime() <= now.getTime()) {
    return "vencida";
  }
  return r.status;
}

export function isOpen(r: Pick<StockReservation, "status" | "expires_at">, now: Date = new Date()): boolean {
  const s = effectiveStatus(r, now);
  return s === "reservada" || s === "preparada";
}

/** "Vence en 3 h", "Vence en 2 días", "Vencida". */
export function expiresLabel(expiresAt: string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "Vencida";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `Vence en ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `Vence en ${hours} h`;
  return `Vence en ${Math.floor(hours / 24)} días`;
}

/** Reservado vigente por ítem (para restar del disponible en pantalla). */
export function reservedByItem(list: StockReservation[], now: Date = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of list) {
    if (!isOpen(r, now)) continue;
    for (const it of r.items) {
      const key = `${r.store_id}:${it.product_id}:${it.variant_id ?? ""}`;
      out.set(key, (out.get(key) ?? 0) + Number(it.qty));
    }
  }
  return out;
}

const ERRORS: [RegExp, string][] = [
  [/feature_not_in_plan: reservas_stock/, "Tu plan no incluye reservas de stock."],
  [/feature_not_in_plan: stock_sucursales/, "Tu plan no incluye stock por sucursal: sólo se reserva en la principal."],
  [/insufficient_available_stock: (.+)/, "No hay disponible suficiente de $1 en esa sucursal."],
  [/insufficient_available_stock/, "No hay disponible suficiente en esa sucursal."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
  [/forbidden/, "Tu rol no puede operar reservas."],
  [/kit_not_transferable/, "Los kits no se reservan: reservá sus componentes."],
  [/untracked_not_transferable/, "Ese producto no lleva stock: no hace falta reservarlo."],
  [/variant_required/, "Elegí la variante del producto."],
  [/duplicate_item/, "Hay un producto repetido en la reserva."],
  [/invalid_expiry/, "La reserva dura entre 1 hora y 30 días."],
  [/invalid_customer_doc/, "El documento tiene que tener entre 6 y 11 números."],
  [/customer_name_required/, "Cargá el nombre del cliente."],
  [/reservation_expired/, "La reserva venció."],
  [/reservation_not_found/, "No encontramos la reserva."],
  [/invalid_status/, "La reserva ya no está vigente."],
  [/override_requires_manager/, "Entregar sin código pide un dueño o encargado."],
  [/sale_required/, "Cargá el número de la venta con la que se cobró."],
  [/sale_not_found/, "No encontramos esa venta."],
  [/sale_not_completed/, "Esa venta está anulada."],
  [/sale_wrong_store/, "La venta tiene que ser de la sucursal de la reserva."],
  [/sale_already_used/, "Esa venta ya entregó otra reserva."],
  [/sale_items_mismatch/, "La venta no incluye todos los productos reservados."],
  [/reason_required/, "Contá el motivo."],
];

export function reservationErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) {
    const m = msg.match(re);
    if (m) return text.replace("$1", m[1] ?? "");
  }
  return "No se pudo completar la operación.";
}

/** Mensaje del resultado de una entrega rechazada por identidad. */
export function pickupFailureMessage(error: string, attemptsLeft: number): string {
  if (error === "pickup_code_locked") {
    return "El código quedó bloqueado por intentos fallidos. Puede entregar un dueño o encargado con motivo.";
  }
  return attemptsLeft === 1
    ? "Código o documento incorrecto. Queda 1 intento."
    : `Código o documento incorrecto. Quedan ${attemptsLeft} intentos.`;
}
