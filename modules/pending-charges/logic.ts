// =============================================================================
// Cobros en espera (ADR-048): lógica pura. Sin React ni Supabase: la usan la
// hoja de cobro, el modal del QR, la pestaña "Cobros en espera", el cierre de
// caja y los tests. La base es la autoridad (park/complete/cancel en RPC); esto
// espeja sus reglas para mostrar y anticipar.
// =============================================================================

export type PendingChargeStatus = "waiting" | "paid" | "completed" | "cancelled" | "expired";

export type ShareChannel = "whatsapp" | "email" | "sms" | "copy" | "native" | "qr";

export type PendingChargeEventKind =
  | "created"
  | "shared"
  | "edited"
  | "regenerated"
  | "extended"
  | "updated"
  | "paid"
  | "payment_rejected"
  | "completed"
  | "completion_failed"
  | "cancelled"
  | "expired"
  | "carried_over"
  | "attached_to_shift"
  | "paid_after_cancel"
  | "old_intent_paid"
  | "acknowledged";

export interface PendingChargeLine {
  name: string;
  quantity: number;
  unit_price: number;
  discount: number;
  subtotal: number;
  variant?: string | null;
  unit?: string | null;
}

export interface PendingCharge {
  id: string;
  tenant_id: string;
  store_id: string;
  register_id: string | null;
  cash_shift_id: string | null;
  origin_shift_id: string | null;
  created_by: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  lines: PendingChargeLine[];
  cart: unknown;
  amount: number;
  sale_total: number;
  provider_key: string;
  channel: "qr" | "link";
  intent_id: string;
  previous_intent_ids: string[];
  share_url: string | null;
  qr_data: string | null;
  shared_via: ShareChannel[];
  share_count: number;
  status: PendingChargeStatus;
  expires_at: string;
  paid_at: string | null;
  paid_amount: number | null;
  completed_at: string | null;
  sale_id: string | null;
  sale_number: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  carry_over: boolean;
  needs_review: boolean;
  last_error: string | null;
  attempts: number;
  acknowledged_at: string | null;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PendingChargeEvent {
  id: string;
  pending_charge_id: string;
  kind: PendingChargeEventKind;
  data: Record<string, unknown> | null;
  actor_user_id: string | null;
  created_at: string;
}

// ── Estados ──────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<PendingChargeStatus, string> = {
  waiting: "Esperando pago",
  paid: "Pagado, sin venta",
  completed: "Cobrado",
  cancelled: "Cancelado",
  expired: "Vencido",
};

export const STATUS_TONE: Record<PendingChargeStatus, "info" | "warning" | "success" | "muted" | "danger"> = {
  waiting: "info",
  paid: "warning",
  completed: "success",
  cancelled: "muted",
  expired: "danger",
};

/** Estados en los que el cobro sigue "abierto" (cuenta para el cierre de caja). */
export const OPEN_STATUSES: readonly PendingChargeStatus[] = ["waiting", "paid"];

/**
 * Estado que se muestra: un cobro "waiting" con el vencimiento ya pasado se ve
 * vencido aunque el cron todavía no lo haya marcado (evaluación perezosa).
 */
export function effectiveStatus(
  c: Pick<PendingCharge, "status" | "expires_at">,
  now: Date = new Date(),
): PendingChargeStatus {
  if (c.status === "waiting" && Date.parse(c.expires_at) <= now.getTime()) return "expired";
  return c.status;
}

// Máquina de estados (espejo de las RPC de 20261014100000_cobros_en_espera.sql).
export type PendingChargeTransition =
  | "approve" // el proveedor acreditó
  | "complete" // se creó la venta
  | "complete_failed" // la venta falló (sin turno, stock, etc.): queda pagado
  | "cancel"
  | "expire"
  | "regenerate" // link nuevo (mismo carrito o carrito editado)
  | "late_payment"; // se acreditó un cobro ya cancelado o vencido

const TRANSITIONS: Record<PendingChargeStatus, Partial<Record<PendingChargeTransition, PendingChargeStatus>>> = {
  waiting: {
    approve: "paid",
    complete: "completed",
    cancel: "cancelled",
    expire: "expired",
    regenerate: "waiting",
  },
  paid: { complete: "completed", complete_failed: "paid" },
  completed: {},
  cancelled: { late_payment: "paid" },
  expired: { regenerate: "waiting", cancel: "cancelled", late_payment: "paid" },
};

/** Próximo estado o null si la transición no es válida. */
export function nextStatus(
  from: PendingChargeStatus,
  t: PendingChargeTransition,
): PendingChargeStatus | null {
  return TRANSITIONS[from][t] ?? null;
}

export interface ChargeActions {
  cancel: boolean;
  edit: boolean;
  regenerate: boolean;
  extend: boolean;
  reshare: boolean;
  retry: boolean;
  print: boolean;
  openSale: boolean;
}

/** Acciones disponibles en el detalle según el estado (efectivo). */
export function chargeActions(
  c: Pick<PendingCharge, "status" | "expires_at" | "share_url" | "needs_review" | "sale_id">,
  now: Date = new Date(),
): ChargeActions {
  const s = effectiveStatus(c, now);
  const waiting = s === "waiting";
  return {
    cancel: waiting || s === "expired",
    edit: waiting || s === "expired",
    regenerate: s === "expired",
    extend: waiting,
    reshare: waiting && Boolean(c.share_url),
    retry: s === "paid",
    print: s === "completed" && Boolean(c.sale_id),
    openSale: s === "completed" && Boolean(c.sale_id),
  };
}

// ── Vencimiento por proveedor ────────────────────────────────────────────────
// Minutos por defecto y tope de cada link. Espejo de pending_charge_max_ttl()
// en SQL (tests/unit/pendingCharges.test.ts verifica que coincidan). Getnet
// crea la orden con expireLimitMinutes 30; MODO y Nave vencen sus QR rápido.

export const DEFAULT_TTL_MINUTES = 24 * 60;
export const MIN_TTL_MINUTES = 5;

export const PROVIDER_MAX_TTL_MINUTES: Record<string, number> = {
  mercadopago: 7 * 24 * 60,
  mobbex: 3 * 24 * 60,
  pagos360: 24 * 60,
  payway: 3 * 24 * 60,
  getnet: 30,
  modo: 30,
  nave: 60,
  gocuotas: 24 * 60,
  directo: 24 * 60,
  ualabis: 24 * 60,
  viumi: 24 * 60,
};

export function maxTtlMinutes(provider: string): number {
  return PROVIDER_MAX_TTL_MINUTES[provider] ?? DEFAULT_TTL_MINUTES;
}

export function defaultTtlMinutes(provider: string): number {
  return Math.min(DEFAULT_TTL_MINUTES, maxTtlMinutes(provider));
}

export function clampTtlMinutes(provider: string, minutes: number): number {
  if (!Number.isFinite(minutes)) return defaultTtlMinutes(provider);
  return Math.max(MIN_TTL_MINUTES, Math.min(Math.round(minutes), maxTtlMinutes(provider)));
}

/** Opciones de "Extender" (minutos) que entran en el tope del proveedor. */
export function extendOptions(provider: string): { label: string; minutes: number }[] {
  const all = [
    { label: "30 minutos", minutes: 30 },
    { label: "2 horas", minutes: 120 },
    { label: "24 horas", minutes: 24 * 60 },
    { label: "3 días", minutes: 3 * 24 * 60 },
  ];
  const max = maxTtlMinutes(provider);
  return all.filter((o) => o.minutes <= max);
}

/** "vence en 2 h 5 min" / "venció". */
export function expiresLabel(expiresAt: string, now: Date = new Date()): string {
  const ms = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "Venció";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `Vence en ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 48) return rest ? `Vence en ${h} h ${rest} min` : `Vence en ${h} h`;
  return `Vence en ${Math.round(h / 24)} días`;
}

// ── Elegibilidad para dejar en espera ────────────────────────────────────────

export type ParkBlock =
  | "split_payment"
  | "partial_amount"
  | "table_or_delivery"
  | "appointment"
  | "no_shift"
  | "feature_off"
  | null;

/**
 * ¿Se puede dejar este cobro en espera? Sólo cuando el QR / link cubre TODA la
 * venta con un único medio (sin pagos parciales con otro medio: el efectivo ya
 * entró a la caja hoy y no se puede "postergar"), fuera de mesas, delivery y
 * turnos (tienen su propio cierre atómico) y con caja abierta.
 */
export function parkBlock(input: {
  paidLines: number;
  electronicAmount: number;
  remaining: number;
  hasTableOrDelivery: boolean;
  hasAppointment: boolean;
  hasShift: boolean;
  featureAllowed: boolean;
}): ParkBlock {
  if (!input.featureAllowed) return "feature_off";
  if (!input.hasShift) return "no_shift";
  if (input.hasTableOrDelivery) return "table_or_delivery";
  if (input.hasAppointment) return "appointment";
  if (input.paidLines > 0) return "split_payment";
  if (input.electronicAmount + 0.005 < input.remaining) return "partial_amount";
  return null;
}

export const PARK_BLOCK_COPY: Record<Exclude<ParkBlock, null>, string> = {
  feature_off: "Los cobros en espera no están incluidos en tu plan.",
  no_shift: "Abrí la caja para dejar cobros en espera.",
  table_or_delivery: "Las mesas y los pedidos de delivery se cobran en el momento.",
  appointment: "Los turnos de agenda se cobran en el momento.",
  split_payment: "Sólo se puede dejar en espera un cobro con un único medio de pago.",
  partial_amount: "Para dejarlo en espera, el QR o link tiene que cubrir el total.",
};

// ── Cierre de caja ───────────────────────────────────────────────────────────

export type CloseAction = "cancel" | "carry";

export interface CloseDecision {
  needsDecision: boolean;
  waiting: number;
  paid: number;
  amount: number;
}

/** Cobros abiertos del turno que se cierra (los que obligan a decidir). */
export function closeShiftDecision(
  charges: Pick<PendingCharge, "status" | "cash_shift_id" | "amount">[],
  shiftId: string,
): CloseDecision {
  let waiting = 0;
  let paid = 0;
  let amount = 0;
  for (const c of charges) {
    if (c.cash_shift_id !== shiftId) continue;
    if (c.status === "waiting") waiting++;
    else if (c.status === "paid") paid++;
    else continue;
    amount += Number(c.amount) || 0;
  }
  return {
    needsDecision: waiting + paid > 0,
    waiting,
    paid,
    amount: Math.round(amount * 100) / 100,
  };
}

// ── Compartir ────────────────────────────────────────────────────────────────

/** Teléfono argentino a formato wa.me (549 + área + número, sin 15). */
export function normalizeArPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D+/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("9")) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  // "15" después del código de área (2 a 4 dígitos): 341 15 1234567 → 341 1234567.
  const m = /^(\d{2,4})15(\d{6,8})$/.exec(d);
  if (m && (m[1]!.length + m[2]!.length === 10)) d = m[1]! + m[2]!;
  if (d.length !== 10) return null;
  return `549${d}`;
}

export interface ShareInput {
  businessName: string | null;
  customerName: string | null;
  amountLabel: string;
  url: string;
}

/** Texto para WhatsApp / SMS / compartir nativo. Sin guion largo. */
export function buildShareMessage(i: ShareInput): string {
  const hola = i.customerName ? `Hola ${i.customerName.split(" ")[0]}!` : "Hola!";
  const from = i.businessName ? ` de ${i.businessName}` : "";
  return `${hola} Te paso el link para pagar ${i.amountLabel}${from}: ${i.url}`;
}

export function shareSubject(i: Pick<ShareInput, "businessName" | "amountLabel">): string {
  return i.businessName ? `Link de pago de ${i.businessName} por ${i.amountLabel}` : `Link de pago por ${i.amountLabel}`;
}

export function whatsappUrl(phone: string | null, text: string): string {
  const p = normalizeArPhone(phone);
  const q = encodeURIComponent(text);
  return p ? `https://wa.me/${p}?text=${q}` : `https://wa.me/?text=${q}`;
}

export function smsUrl(phone: string | null, text: string): string {
  const p = phone ? phone.replace(/[^\d+]/g, "") : "";
  return `sms:${p}?&body=${encodeURIComponent(text)}`;
}

export function mailtoUrl(email: string | null, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(email ?? "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v: string | null | undefined): boolean {
  return Boolean(v && EMAIL_RE.test(v.trim()));
}

/** ¿El contenido del cobro es un link compartible (no un QR EMV de caja)? */
export function isShareableLink(url: string | null | undefined): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

// ── Errores de las RPC ───────────────────────────────────────────────────────

export function pendingChargeErrorCopy(msg: string): string {
  const m = msg || "";
  if (m.includes("feature_not_in_plan")) return "Los cobros en espera no están incluidos en tu plan.";
  if (m.includes("intent_already_paid")) return "El cliente ya pagó: se registra la venta ahora.";
  if (m.includes("intent_already_parked")) return "Este cobro ya está en espera.";
  if (m.includes("intent_not_pending")) return "El cobro ya no está pendiente en el proveedor. Generá uno nuevo.";
  if (m.includes("intent_not_found")) return "No encontramos el cobro del proveedor.";
  if (m.includes("amount_mismatch")) return "El monto del QR no coincide con el total de la venta. Generalo de nuevo.";
  if (m.includes("shift_not_open") || m.includes("no_open_shift")) return "No hay una caja abierta en esta sucursal.";
  if (m.includes("store_not_allowed")) return "No tenés acceso a la sucursal de este cobro.";
  if (m.includes("version_conflict")) return "Otro usuario modificó este cobro. Actualizá y probá de nuevo.";
  if (m.includes("not_waiting")) return "Este cobro ya no está esperando pago.";
  if (m.includes("needs_review")) return "Este cobro necesita revisión de un encargado.";
  if (m.includes("forbidden")) return "No tenés permiso para esta acción.";
  if (m.includes("pending_charges_decision_required"))
    return "Hay cobros en espera en esta caja: elegí qué hacer con ellos.";
  if (m.includes("invalid_ttl")) return "El nuevo vencimiento no es válido para este medio.";
  if (m.includes("unsupported_origin")) return "Las mesas y los pedidos de delivery no se pueden dejar en espera.";
  return "No se pudo completar la acción.";
}

// ── Snapshot del carrito → argumentos de create_sale ─────────────────────────

export interface SaleArgsLine {
  productId: string | null;
  name: string;
  serial?: string | null;
  variantId?: string | null;
  modifiers?: unknown[] | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  packId?: string | null;
  packCreditId?: string | null;
  // ADR-056: regalo de promo a $0 y precio cambiado a mano (con motivo).
  giftPromoId?: string | null;
  priceOverride?: boolean;
  overrideReason?: string | null;
  listPrice?: number | null;
  /** Id local de la línea del carrito (ADR-096: la garantía la referencia). */
  lineId?: string;
  // ADR-116: datos de servicio del renglón (undefined = lo del servicio).
  lineDetail?: string | null;
  clarificationIds?: string[];
  lineNote?: string | null;
}

export interface SaleArgsExtra {
  kind: "warranty" | "surcharge" | "tip" | "professional";
  name?: string;
  amount?: number;
  method?: string;
  id?: string;
  /** ADR-096 (kind='warranty'): plan elegido y línea del carrito que cubre. */
  planId?: string;
  forLineId?: string;
}

export interface SaleArgsItem {
  product_id: string | null;
  name?: string;
  serial?: string;
  variant_id?: string;
  modifiers?: unknown[];
  quantity: number;
  unit_price: number;
  discount: number;
  // ADR-056: señales para el precio autoritativo del servidor.
  gift_promo_id?: string;
  pack_credit_id?: string;
  price_override?: boolean;
  override_reason?: string;
  list_price?: number;
  // ADR-096: garantía extendida enlazada a la línea que cubre.
  warranty_plan_id?: string;
  warranty_for?: number;
  // ADR-116: datos de servicio del renglón (los guarda create_sale).
  line_note?: string;
  line_detail?: string;
  clarification_ids?: string[];
}

export interface SaleArgsExtraOut {
  kind: string;
  amount?: number;
  method?: string;
  id?: string;
}

/**
 * Ítems y extras de create_sale a partir del carrito y los extras de la hoja.
 * Es EL mapeo que usa la venta normal (usePosSale) y el que se guarda en el
 * cobro en espera: así la venta diferida es idéntica a la inmediata.
 */
export function buildSaleItemsAndExtras(
  lines: SaleArgsLine[],
  extras: SaleArgsExtra[] | undefined,
): { items: SaleArgsItem[]; extras: SaleArgsExtraOut[] } {
  const items: SaleArgsItem[] = lines.map((l) => ({
    product_id: l.productId,
    ...(l.productId ? {} : { name: l.name }),
    ...(l.serial ? { serial: l.serial } : {}),
    ...(l.variantId ? { variant_id: l.variantId } : {}),
    ...(l.modifiers && l.modifiers.length > 0 ? { modifiers: l.modifiers } : {}),
    quantity: l.quantity,
    unit_price: l.packCreditId ? 0 : l.unitPrice,
    discount: l.packCreditId ? 0 : l.discount,
    // ADR-056: el servidor valida el precio; estas marcas explican los $0 y el
    // cambio manual (list_price es informativo: el servidor usa el suyo).
    ...(l.giftPromoId ? { gift_promo_id: l.giftPromoId } : {}),
    ...(l.packCreditId ? { pack_credit_id: l.packCreditId } : {}),
    ...(l.priceOverride && !l.packCreditId
      ? {
          price_override: true,
          override_reason: l.overrideReason ?? "",
          ...(l.listPrice != null ? { list_price: l.listPrice } : {}),
        }
      : {}),
    // ADR-116: aclaración libre, descripción ampliada y aclaraciones elegidas.
    // Sin la clave, create_sale toma las del servicio.
    ...(l.lineNote?.trim() ? { line_note: l.lineNote.trim() } : {}),
    ...(l.lineDetail !== undefined ? { line_detail: l.lineDetail?.trim() ?? "" } : {}),
    ...(l.clarificationIds !== undefined ? { clarification_ids: l.clarificationIds } : {}),
  }));
  for (const ex of extras ?? []) {
    if ((ex.kind === "warranty" || ex.kind === "surcharge") && (ex.amount ?? 0) > 0) {
      items.push({
        product_id: null,
        name: ex.name ?? "Recargo",
        quantity: 1,
        unit_price: ex.amount ?? 0,
        discount: 0,
        ...(ex.kind === "warranty" ? warrantyLink(lines, ex) : {}),
      });
    }
  }
  const out: SaleArgsExtraOut[] = (extras ?? [])
    .filter(
      (ex) =>
        (ex.kind === "professional" && ex.id) ||
        ((ex.kind === "warranty" || ex.kind === "surcharge" || ex.kind === "tip") && (ex.amount ?? 0) > 0),
    )
    .map((ex) => ({
      kind: ex.kind,
      ...(ex.amount != null ? { amount: ex.amount } : {}),
      ...(ex.method ? { method: ex.method } : {}),
      ...(ex.id ? { id: ex.id } : {}),
    }));
  for (const l of lines) {
    if (l.packId) out.push({ kind: "pack", id: l.packId });
    if (l.packCreditId) out.push({ kind: "pack_session", id: l.packCreditId });
  }
  return { items, extras: out };
}

/**
 * ADR-096: vínculo de la garantía extendida con la línea que cubre (índice en
 * p_items). Sin plan o sin una línea con producto, va sin vínculo y
 * serial_lookup cae al nombre de la línea, como antes.
 */
export function warrantyLink(
  lines: SaleArgsLine[],
  ex: Pick<SaleArgsExtra, "planId" | "forLineId">,
): { warranty_plan_id: string; warranty_for: number } | Record<string, never> {
  if (!ex.planId || !ex.forLineId) return {};
  const i = lines.findIndex((l) => l.lineId === ex.forLineId);
  if (i < 0 || !lines[i]!.productId) return {};
  return { warranty_plan_id: ex.planId, warranty_for: i };
}

/** Líneas para mostrar en el detalle (sólo display: la plata la valida el server). */
export function displayLines(
  lines: (SaleArgsLine & { variantLabel?: string; unit?: string })[],
  extras: SaleArgsExtra[] | undefined,
): PendingChargeLine[] {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const out: PendingChargeLine[] = lines.map((l) => {
    const price = l.packCreditId ? 0 : l.unitPrice;
    const disc = l.packCreditId ? 0 : l.discount;
    return {
      name: l.name,
      quantity: l.quantity,
      unit_price: price,
      discount: disc,
      subtotal: r2(price * l.quantity - disc),
      variant: l.variantLabel ?? null,
      unit: l.unit ?? null,
    };
  });
  for (const ex of extras ?? []) {
    if ((ex.kind === "warranty" || ex.kind === "surcharge") && (ex.amount ?? 0) > 0) {
      out.push({ name: ex.name ?? "Recargo", quantity: 1, unit_price: ex.amount ?? 0, discount: 0, subtotal: ex.amount ?? 0 });
    }
  }
  return out;
}

/**
 * Carrito para "Editar en el POS": quita del snapshot las líneas que agregó la
 * hoja de cobro (recargos y garantía) y deja el carrito tal como estaba.
 */
export function restorableCart(cart: unknown): {
  lines: Record<string, unknown>[];
  discountTotal: number;
  customer: { id: string; name: string } | null;
  couponCode: string | null;
} | null {
  if (!cart || typeof cart !== "object") return null;
  const c = cart as Record<string, unknown>;
  if (!Array.isArray(c.lines)) return null;
  const customer =
    c.customer && typeof c.customer === "object" && (c.customer as { id?: unknown }).id
      ? {
          id: String((c.customer as { id: unknown }).id),
          name: String((c.customer as { name?: unknown }).name ?? ""),
        }
      : null;
  return {
    lines: c.lines as Record<string, unknown>[],
    discountTotal: Number(c.discountTotal) || 0,
    customer,
    couponCode: typeof c.couponCode === "string" ? c.couponCode : null,
  };
}
