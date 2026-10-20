// lib/purchases/orders.ts
//
// Lógica PURA de órdenes de compra y recepciones (F18 · H101, ADR-050). Espejo
// de la máquina de estados y los cálculos que hacen cumplir las RPC
// (migración 20261016100200): la UI la usa para mostrar sólo lo posible, pero
// la barrera real es el servidor. Sin React ni Supabase: testeable.

import { round } from "./costs";
import { roleErrorMessage } from "@/lib/permissions/errors";

export type OrderStatus =
  | "draft"
  | "sent"
  | "partially_received"
  | "received"
  | "cancelled";

export type OrderAction = "edit" | "send" | "reopen" | "receive" | "close" | "cancel";

export type PurchaseRole = "owner" | "manager" | "cashier" | "viewer";

export const ORDER_STATUSES: OrderStatus[] = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "cancelled",
];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Borrador",
  sent: "Enviada",
  partially_received: "Recibida en parte",
  received: "Recibida",
  cancelled: "Cancelada",
};

export const ORDER_STATUS_TONE: Record<
  OrderStatus,
  "neutral" | "warning" | "info" | "brand" | "success" | "danger" | "gold"
> = {
  draft: "neutral",
  sent: "info",
  partially_received: "warning",
  received: "success",
  cancelled: "danger",
};

export const OPEN_ORDER_STATUSES: OrderStatus[] = ["draft", "sent", "partially_received"];

export interface OrderState {
  status: OrderStatus;
  units_received: number;
}

/** ¿La acción es válida desde ese estado? (sin mirar el rol) */
export function canOrderAction(o: OrderState, action: OrderAction): boolean {
  const received = Number(o.units_received) > 0;
  switch (action) {
    case "edit":
      return o.status === "draft";
    case "send":
      return o.status === "draft";
    case "reopen":
      return o.status === "sent" && !received;
    case "receive":
      return o.status === "sent" || o.status === "partially_received";
    case "close":
      return o.status === "partially_received";
    case "cancel":
      return (o.status === "draft" || o.status === "sent") && !received;
  }
}

/** Estado después de una acción (receive depende de si queda pendiente). */
export function nextOrderStatus(
  o: OrderState,
  action: OrderAction,
  opts: { pendingAfter?: number; close?: boolean } = {},
): OrderStatus | null {
  if (!canOrderAction(o, action)) return null;
  switch (action) {
    case "edit":
      return "draft";
    case "send":
      return "sent";
    case "reopen":
      return "draft";
    case "close":
      return "received";
    case "cancel":
      return "cancelled";
    case "receive":
      return opts.close || (opts.pendingAfter ?? 0) <= 0 ? "received" : "partially_received";
  }
}

/** Acciones visibles para un rol. Recibir puede hacerlo el cajero si el negocio lo permite. */
export function orderActions(
  o: OrderState,
  role: PurchaseRole,
  cashierCanReceive = true,
): OrderAction[] {
  const manager = role === "owner" || role === "manager";
  const all: OrderAction[] = ["edit", "send", "reopen", "receive", "close", "cancel"];
  return all.filter((a) => {
    if (!canOrderAction(o, a)) return false;
    if (a === "receive") return manager || (role === "cashier" && cashierCanReceive);
    return manager;
  });
}

// ── Cálculos de línea y totales ─────────────────────────────────────────────

/** "10+5" | "10 + 5,5" → [10, 5.5]. Ignora ceros y basura. */
export function parseDiscounts(text: string | null | undefined): number[] {
  return String(text ?? "")
    .split(/[+;]/)
    .map((s) => Number(s.trim().replace("%", "").replace(",", ".")))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

export function formatDiscounts(d: number[] | null | undefined): string {
  return (d ?? []).map((n) => String(n).replace(".", ",")).join(" + ");
}

/** Descuentos válidos: cada uno entre 0 y 100 (excluido). */
export function validDiscounts(d: number[]): boolean {
  return d.every((n) => n >= 0 && n < 100);
}

/** Factor de descuentos en cascada: 10 + 5 = 0,9 × 0,95. */
export function discountFactor(d: number[] | null | undefined): number {
  return (d ?? []).reduce((f, n) => f * (1 - n / 100), 1);
}

/** Neto de una línea (espejo de purchase_line_net): 2 decimales. */
export function lineNet(qty: number, unitCost: number, discounts: number[] = []): number {
  return round(qty * unitCost * discountFactor(discounts), 2);
}

/** Costo unitario neto de descuentos de línea y global (espejo de purchase_unit_net). */
export function unitNet(unitCost: number, discounts: number[] = [], globalPct = 0): number {
  return round(unitCost * discountFactor(discounts) * (1 - globalPct / 100), 4);
}

export interface OrderLineInput {
  qty: number;
  unit_cost: number;
  discounts?: number[];
  tax_rate?: number;
}

export interface OrderTotals {
  subtotal: number;
  discount_total: number;
  net_total: number;
  tax_total: number;
  total: number;
  units: number;
}

/** Totales de la OC (espejo de purchase_order_recalc). */
export function orderTotals(lines: OrderLineInput[], globalPct = 0): OrderTotals {
  let subtotal = 0;
  let tax = 0;
  let units = 0;
  for (const l of lines) {
    const net = lineNet(l.qty, l.unit_cost, l.discounts ?? []);
    subtotal += net;
    tax += round((net * (1 - globalPct / 100) * (l.tax_rate ?? 21)) / 100, 2);
    units += l.qty;
  }
  subtotal = round(subtotal, 2);
  const discount = round((subtotal * globalPct) / 100, 2);
  const net = round(subtotal - discount, 2);
  return {
    subtotal,
    discount_total: discount,
    net_total: net,
    tax_total: round(tax, 2),
    total: round(net + tax, 2),
    units: round(units, 3),
  };
}

// ── Recepción ───────────────────────────────────────────────────────────────

export interface OrderItemProgress {
  qty_ordered: number;
  qty_received: number;
}

/** Lo que falta recibir de una línea (nunca negativo). */
export function pendingQty(i: OrderItemProgress): number {
  return Math.max(round(Number(i.qty_ordered) - Number(i.qty_received), 3), 0);
}

/** Pendiente total de la OC después de recibir `now` (por índice de línea). */
export function pendingAfterReceipt(items: OrderItemProgress[], now: number[]): number {
  return round(
    items.reduce(
      (t, i, idx) =>
        t + Math.max(Number(i.qty_ordered) - Number(i.qty_received) - (now[idx] ?? 0), 0),
      0,
    ),
    3,
  );
}

/** % recibido de una OC (0 a 100). */
export function receivedPct(o: { units_ordered: number; units_received: number }): number {
  if (!(o.units_ordered > 0)) return 0;
  return Math.min(Math.round((o.units_received / o.units_ordered) * 100), 100);
}

export type ReceiptDifferenceReason =
  | "faltante"
  | "sobrante"
  | "danado"
  | "vencido"
  | "error_proveedor"
  | "otro";

export const RECEIPT_DIFFERENCE_LABEL: Record<ReceiptDifferenceReason, string> = {
  faltante: "Faltante",
  sobrante: "Sobrante",
  danado: "Dañado",
  vencido: "Vencido",
  error_proveedor: "Error del proveedor",
  otro: "Otro",
};

/** Diferencia de una línea al recibir: >0 sobrante, <0 faltante, 0 ok. */
export function receiptDifference(expected: number | null, received: number): number {
  if (expected == null) return 0;
  return round(received - expected, 3);
}

// ── Numeración y mensajes ───────────────────────────────────────────────────

const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(6, "0");
export const formatOrderNumber = (n: number) => `OC-${pad(n)}`;
export const formatReceiptNumber = (n: number) => `REC-${pad(n)}`;
export const formatPaymentNumber = (n: number) => `OP-${pad(n)}`;

export interface ShareOrder {
  number: number;
  businessName: string;
  supplierName: string;
  storeName: string;
  expected_date: string | null;
  currency: string;
  notes: string | null;
  items: Array<{
    product_name: string;
    variant_label: string | null;
    supplier_sku: string | null;
    sku: string | null;
    qty_ordered: number;
    unit: string;
  }>;
}

/** Texto plano del pedido para WhatsApp o mail. */
export function orderShareText(o: ShareOrder): string {
  const lines = [
    `Hola ${o.supplierName}, te paso el pedido ${formatOrderNumber(o.number)} de ${o.businessName}.`,
    `Entregar en: ${o.storeName}`,
  ];
  if (o.expected_date) {
    const [y, m, d] = o.expected_date.slice(0, 10).split("-");
    lines.push(`Fecha esperada: ${d}/${m}/${y}`);
  }
  lines.push("");
  for (const i of o.items) {
    const name = i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name;
    const code = i.supplier_sku || i.sku;
    const qty = Number.isInteger(i.qty_ordered)
      ? String(i.qty_ordered)
      : String(i.qty_ordered).replace(".", ",");
    lines.push(`• ${qty} ${i.unit} ${name}${code ? ` [${code}]` : ""}`);
  }
  if (o.notes) lines.push("", `Notas: ${o.notes}`);
  lines.push("", "Gracias.");
  return lines.join("\n");
}

const ERROR_MESSAGES: Array<[RegExp, string]> = [
  [/feature_not_in_plan: compras_importacion/, "El costeo de importación no está incluido en tu plan."],
  [/feature_not_in_plan: tesoreria/, "Tesorería no está incluida en tu plan."],
  [/feature_not_in_plan: compras/, "Compras no está incluido en tu plan."],
  [/supervisor_required|supervisor_token_invalid/, "Este retiro necesita la autorización de un supervisor (PIN)."],
  [/shift_not_owned/, "Sólo podés sacar efectivo de tu propia caja."],
  [/cash_shift_required|shift_not_open/, "Abrí tu caja para mover efectivo."],
  [/receipt_voided/, "La recepción está anulada."],
  [/receipt_invoiced/, "La recepción tiene factura: anulá la factura primero."],
  [/receipt_has_returns/, "La recepción tiene devoluciones al proveedor: no se puede anular."],
  [/receipt_lots_consumed/, "Los lotes de la recepción ya se vendieron en parte: hacé una devolución o un ajuste."],
  [/receipt_stock_consumed/, "No queda stock suficiente en la sucursal para anular la recepción."],
  [/return_exceeds_received/, "No podés devolver más de lo recibido en esa recepción."],
  [/return_exceeds_stock/, "No hay stock suficiente en la sucursal para devolver."],
  [/return_empty/, "Cargá al menos una cantidad para devolver."],
  [/lot_not_found|lot_insufficient/, "El lote elegido no tiene saldo en esa sucursal."],
  [/credit_note_not_linkable/, "Esa nota de crédito no se puede vincular (otro proveedor, anulada o ya usada)."],
  [/invoice_not_allocatable/, "Uno de los comprobantes no se puede imputar."],
  [/allocation_exceeds_open/, "Imputaste más que el saldo de un comprobante."],
  [/allocation_exceeds_payment/, "Imputaste más que el total de la orden de pago."],
  [/invalid_withholding/, "Revisá las retenciones (tipo y n° de certificado)."],
  [/treasury_account_not_found/, "La cuenta de tesorería no existe o está inactiva."],
  [/bank_account_required/, "Elegí una cuenta bancaria."],
  [/cheque_data_required/, "Completá el número y la fecha de pago del cheque."],
  [/cheque_not_available|cheque_not_found/, "El cheque ya no está en cartera."],
  [/cheque_amount_mismatch/, "El importe tiene que ser el del cheque."],
  [/cheque_transition_via_payment/, "Ese cambio de estado se hace desde la orden de pago."],
  [/invalid_cheque_transition/, "El cheque cambió de estado. Actualizá la pantalla."],
  [/payment_cheque_used/, "Un cheque de la orden ya se depositó o se rechazó: no se puede anular."],
  [/movement_reconciled/, "El movimiento está conciliado: desconciliálo primero."],
  [/movement_not_manual/, "Ese movimiento se anula desde su origen (orden de pago o cheque)."],
  [/same_account/, "Elegí dos cuentas distintas."],
  [/currency_mismatch/, "Las cuentas tienen monedas distintas."],
  [/invalid_cuit/, "El CUIT no es válido."],
  [/payment_date_required/, "Falta la fecha de pago del cheque."],
  [/too_many_rows/, "La lista tiene demasiadas filas (hasta 5000 por importación)."],
  [/invalid_amount/, "Revisá los importes."],
  [/forbidden|42501/, "No tenés permiso para esta acción."],
  [/store_forbidden/, "No tenés acceso a esa sucursal."],
  [/supplier_not_found/, "No encontramos el proveedor."],
  [/store_not_found/, "La sucursal no existe o está inactiva."],
  [/order_not_found/, "No encontramos la orden de compra."],
  [/order_empty/, "La orden no tiene productos."],
  [/receipt_empty|nothing_to_receive/, "No cargaste cantidades para recibir."],
  [/over_receive_not_allowed/, "No se puede recibir más de lo pedido (configuración de compras)."],
  [/difference_reason_required/, "Indicá el motivo de cada diferencia antes de cerrar."],
  [/free_receipt_not_allowed/, "Las recepciones sin orden de compra están desactivadas."],
  [/kit_not_purchasable/, "Los kits no se compran: comprá sus componentes."],
  [/variant_required/, "Elegí la variante del producto."],
  [/invalid_transition/, "La orden cambió de estado. Actualizá la pantalla."],
  [/invalid_fx_rate/, "Cargá un tipo de cambio mayor a cero."],
  [/invalid_discount/, "Cada descuento tiene que estar entre 0 y 100 %."],
  [/invalid_qty/, "Revisá las cantidades."],
  [/reason_required/, "Escribí un motivo."],
  [/invalid_dispatch_number/, "El n° de despacho tiene 16 caracteres (AAaaaTTTTnnnnnnX)."],
  [/invoice_has_payments/, "La factura tiene pagos imputados: anulá primero la orden de pago (o dejá el total en lo ya pagado)."],
  [/invoice_letter_mismatch/, "La letra no corresponde a la condición de IVA del proveedor y la de tu negocio."],
  // H167 (ADR-178)
  [/credit_exceeds_available/, "Aplicaste más que el saldo disponible de la nota de crédito o del anticipo."],
  [/credit_not_available/, "La nota de crédito o el anticipo ya no está disponible."],
  [/lines_exceed_invoice/, "Los renglones suman más que el neto del comprobante."],
  [/invoice_items_only_on_create/, "Los artículos con recepción se cargan sólo en el alta del comprobante."],
  [/store_required/, "Elegí la sucursal que recibe la mercadería."],
  [/account_not_imputable/, "La cuenta contable elegida no es imputable."],
  [/opening_exists/, "El proveedor ya tiene saldo inicial: anulalo para cargar otro."],
  [/inbox_full/, "La bandeja tiene demasiadas facturas pendientes: cargá o descartá algunas."],
  [/inbox_not_uploaded|inbox_bad_path/, "No se pudo subir el archivo. Probá de nuevo."],
  [/too_many_rows/, "El archivo tiene más de 1000 comprobantes: dividilo por mes."],
  [/invoice_duplicated/, "Ese comprobante ya está cargado para este proveedor."],
  [/vat_not_discriminated/, "Los comprobantes B y C no discriminan IVA."],
  [/total_mismatch/, "El total no coincide con la suma de netos, IVA y tributos."],
  [/invalid_vat_rate/, "Alícuota de IVA inválida."],
  [/receipt_not_linkable/, "Alguna recepción ya está facturada o es de otro proveedor."],
  [/supplier_cost_missing/, "El proveedor no tiene costo cargado para ese producto."],
  [/suppliers_tenant_cuit_key|duplicate key.*cuit/, "Ya hay un proveedor con ese CUIT."],
  [/suppliers_cuit_check|cuit_is_valid/, "El CUIT no es válido."],
];

export function purchaseErrorMessage(e: unknown): string {
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
