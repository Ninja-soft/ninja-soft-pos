// =============================================================================
// Carrito y pedido del catálogo público (F6 · H10, ADR-130). PURO.
//
// El cliente arma el carrito en /c/<slug> y lo confirma con
// public_catalog_order_create; el pedido entra como pedido de salón de H32
// (sale_orders) y lo sigue en /c/<slug>/pedido/<token>. El servidor resuelve
// precios, disponible, sucursal y total: acá sólo se calcula lo que se
// muestra mientras arma y se valida el formulario para no ir y volver.
//
// Espejos del SQL (20261125100100_catalogo_pedidos), con tests:
//   * catalogUnitPrice ↔ _catalog_unit_price (lista 'catalogo').
//   * validateCheckout ↔ las validaciones de public_catalog_order_create.
// =============================================================================

export type CatalogDeliveryType = "retiro" | "envio";
export type PaymentPreference = "al_retirar" | "link";

export interface CatalogVariant {
  id: string;
  label: string;
  price: number;
  /** null = no controla stock. */
  available: number | null;
}

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  image_url: string | null;
  category: string | null;
  /** ADR-129: stock − reservado vigente; null = no controla stock. */
  available?: number | null;
  /** ADR-130 (sin la migración no vienen). */
  unit?: string;
  has_variants?: boolean;
  variants?: CatalogVariant[] | null;
}

export interface CatalogStoreRef {
  id: string;
  name: string;
  address: string | null;
}

export interface CatalogOrdering {
  enabled: boolean;
  store: CatalogStoreRef | null;
  reservation_minutes: number;
  retiro: { enabled: boolean; pickup_code: boolean; stores: CatalogStoreRef[] };
  envio: { enabled: boolean };
  pay_link: boolean;
}

export interface Catalog {
  tenant: { name: string; slug: string };
  branding: {
    logo_url: string | null;
    accent: string | null;
    legal_name: string | null;
    trade_name?: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  /** ADR-130: null = el negocio no recibe pedidos desde el catálogo. */
  ordering?: CatalogOrdering | null;
  products: CatalogProduct[];
}

// ── Precio (espejo de _catalog_unit_price) ──────────────────────────────────

export interface CatalogListLike {
  id: string;
  adjustment_pct: number | null;
}

export interface CatalogListItem {
  product_id: string;
  variant_id: string | null;
  price: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Ítem de la variante → ítem del producto → % sobre la base → base. */
export function catalogUnitPrice(
  list: CatalogListLike | null,
  items: CatalogListItem[],
  productId: string,
  variantId: string | null,
  base: number,
): number {
  const b = Number(base) || 0;
  if (!list) return b;
  if (variantId) {
    const v = items.find((i) => i.product_id === productId && i.variant_id === variantId);
    if (v) return Number(v.price);
  }
  const p = items.find((i) => i.product_id === productId && i.variant_id === null);
  if (p) return Number(p.price);
  if (list.adjustment_pct != null) return round2(b * (1 + list.adjustment_pct / 100));
  return b;
}

// ── Carrito ─────────────────────────────────────────────────────────────────

export interface CartItem {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  unitPrice: number;
  qty: number;
  imageUrl: string | null;
  /** Tope: disponible al momento de agregarlo (null = sin tope de stock). */
  max: number | null;
  unit: string;
}

export const MAX_QTY = 999;
export const MAX_LINES = 50;

export const cartKey = (productId: string, variantId: string | null) => `${productId}:${variantId ?? ""}`;

/** ¿Se puede pedir? Con stock controlado hace falta disponible > 0. */
export function isOrderable(available: number | null | undefined): boolean {
  return available == null || Number(available) > 0;
}

/** Tope de cantidad: el disponible (si controla stock) y nunca más de 999. */
export function qtyCap(available: number | null | undefined): number {
  if (available == null) return MAX_QTY;
  return Math.max(0, Math.min(MAX_QTY, Math.floor(Number(available))));
}

function clampQty(qty: number, max: number | null, unit: string): number {
  const n = Number(qty) || 0;
  const q = unit === "kg" ? Math.round(n * 1000) / 1000 : Math.floor(n);
  return Math.max(0, Math.min(q, max == null ? MAX_QTY : Math.min(max, MAX_QTY)));
}

/** Agrega (o suma a la línea que ya estaba) respetando el disponible. */
export function addToCart(cart: CartItem[], item: CartItem): CartItem[] {
  const key = cartKey(item.productId, item.variantId);
  const i = cart.findIndex((c) => cartKey(c.productId, c.variantId) === key);
  const prev = i >= 0 ? cart[i] : undefined;
  if (prev) {
    const max = item.max ?? prev.max;
    const qty = clampQty(prev.qty + item.qty, max, prev.unit);
    return cart.map((c, j) => (j === i ? { ...prev, ...item, max, qty } : c));
  }
  if (cart.length >= MAX_LINES) return cart;
  const qty = clampQty(item.qty, item.max, item.unit);
  return qty > 0 ? [...cart, { ...item, qty }] : cart;
}

/** Cambia la cantidad; 0 la saca del carrito. */
export function setCartQty(cart: CartItem[], key: string, qty: number): CartItem[] {
  return cart
    .map((c) => (cartKey(c.productId, c.variantId) === key ? { ...c, qty: clampQty(qty, c.max, c.unit) } : c))
    .filter((c) => c.qty > 0);
}

export function cartTotals(cart: CartItem[]): { units: number; total: number } {
  let units = 0;
  let total = 0;
  for (const c of cart) {
    units += c.qty;
    total += round2(c.unitPrice * c.qty);
  }
  return { units: Math.round(units * 1000) / 1000, total: round2(total) };
}

/** Lee el carrito guardado en el navegador (tolera basura). */
export function readStoredCart(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CartItem[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const c = x as Record<string, unknown>;
    if (typeof c.productId !== "string" || typeof c.name !== "string") continue;
    const qty = Number(c.qty);
    const unitPrice = Number(c.unitPrice);
    if (!(qty > 0) || !Number.isFinite(unitPrice)) continue;
    out.push({
      productId: c.productId,
      variantId: typeof c.variantId === "string" ? c.variantId : null,
      name: c.name,
      variantLabel: typeof c.variantLabel === "string" ? c.variantLabel : null,
      unitPrice,
      qty,
      imageUrl: typeof c.imageUrl === "string" ? c.imageUrl : null,
      max: c.max == null ? null : Number(c.max),
      unit: typeof c.unit === "string" ? c.unit : "un",
    });
  }
  return out.slice(0, MAX_LINES);
}

/**
 * Concilia el carrito guardado con el catálogo vigente: precio y disponible
 * del servidor, saca lo que ya no está o no tiene stock y recorta cantidades.
 */
export function reconcileCart(cart: CartItem[], products: CatalogProduct[]): { cart: CartItem[]; changed: boolean } {
  const byId = new Map(products.map((p) => [p.id, p]));
  let changed = false;
  const next: CartItem[] = [];
  for (const c of cart) {
    const p = byId.get(c.productId);
    if (!p) {
      changed = true;
      continue;
    }
    let price = Number(p.price);
    let available = p.available ?? null;
    let label = c.variantLabel;
    if (p.has_variants) {
      const v = (p.variants ?? []).find((x) => x.id === c.variantId);
      if (!v) {
        changed = true;
        continue;
      }
      price = Number(v.price);
      available = v.available;
      label = v.label;
    } else if (c.variantId) {
      changed = true;
      continue;
    }
    const max = available == null ? null : qtyCap(available);
    const qty = clampQty(c.qty, max, c.unit);
    if (qty <= 0) {
      changed = true;
      continue;
    }
    if (qty !== c.qty || price !== c.unitPrice || max !== c.max) changed = true;
    next.push({ ...c, unitPrice: price, max, qty, variantLabel: label });
  }
  return { cart: next, changed };
}

/** "Desde $X" para un producto con variantes de precios distintos. */
export function priceRange(p: CatalogProduct): { min: number; max: number } {
  const vs = p.has_variants ? (p.variants ?? []) : [];
  if (vs.length === 0) return { min: Number(p.price), max: Number(p.price) };
  const prices = vs.map((v) => Number(v.price));
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/** Disponible del producto para la grilla: con variantes, alguna con stock. */
export function productOrderable(p: CatalogProduct): boolean {
  if (p.has_variants) {
    const vs = p.variants ?? [];
    return vs.length > 0 && vs.some((v) => isOrderable(v.available));
  }
  return isOrderable(p.available);
}

// ── Checkout ────────────────────────────────────────────────────────────────

export interface CheckoutForm {
  deliveryType: CatalogDeliveryType | null;
  pickupStoreId: string | null;
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  payment: PaymentPreference;
  /** Honeypot: un humano no lo ve ni lo completa. */
  website: string;
}

export type CheckoutErrors = Partial<Record<"deliveryType" | "name" | "phone" | "email" | "address" | "notes" | "cart", string>>;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS_RE = /^[0-9+()\s.-]+$/;

export function enabledCatalogDeliveryTypes(o: CatalogOrdering | null | undefined): CatalogDeliveryType[] {
  if (!o?.enabled) return [];
  const out: CatalogDeliveryType[] = [];
  if (o.retiro.enabled) out.push("retiro");
  if (o.envio.enabled) out.push("envio");
  return out;
}

/** Mismas reglas que public_catalog_order_create (el servidor manda igual). */
export function validateCheckout(f: CheckoutForm, cart: CartItem[], o: CatalogOrdering | null | undefined): CheckoutErrors {
  const e: CheckoutErrors = {};
  if (cart.length === 0) e.cart = "Tu carrito está vacío.";
  const types = enabledCatalogDeliveryTypes(o);
  if (!f.deliveryType || !types.includes(f.deliveryType)) e.deliveryType = "Elegí cómo lo recibís.";
  const name = f.name.replace(/\s+/g, " ").trim();
  if (name.length < 2) e.name = "Escribí tu nombre.";
  else if (name.length > 120) e.name = "El nombre es muy largo.";
  const phone = f.phone.trim();
  const digits = phone.replace(/[^0-9]/g, "").length;
  if (!phone || !PHONE_CHARS_RE.test(phone) || digits < 8 || digits > 15 || phone.length > 40) {
    e.phone = "Escribí un teléfono o WhatsApp con código de área.";
  }
  const email = f.email.trim();
  if (email && (email.length > 160 || !EMAIL_RE.test(email))) e.email = "Revisá el email.";
  if (f.deliveryType === "envio") {
    const a = f.address.trim();
    if (a.length < 5) e.address = "Escribí la dirección de entrega.";
    else if (a.length > 300) e.address = "La dirección es muy larga.";
  }
  if (f.notes.trim().length > 500) e.notes = "La nota es muy larga (máximo 500).";
  return e;
}

export interface OrderPayload {
  id: string;
  token: string;
  items: { product_id: string; variant_id: string | null; qty: number }[];
  delivery_type: CatalogDeliveryType;
  pickup_store_id: string | null;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  ship_address: string | null;
  notes: string | null;
  payment_preference: PaymentPreference;
  website: string;
}

/** Lo que viaja al servidor: ids, cantidades y datos de contacto. Nunca precios. */
export function buildOrderPayload(
  id: string,
  token: string,
  f: CheckoutForm,
  cart: CartItem[],
  o: CatalogOrdering | null | undefined,
): OrderPayload {
  const type = f.deliveryType ?? "retiro";
  return {
    id,
    token,
    items: cart.map((c) => ({ product_id: c.productId, variant_id: c.variantId, qty: c.qty })),
    delivery_type: type,
    pickup_store_id: type === "retiro" ? (f.pickupStoreId ?? o?.store?.id ?? null) : null,
    customer_name: f.name.replace(/\s+/g, " ").trim(),
    customer_phone: f.phone.trim(),
    customer_email: f.email.trim() ? f.email.trim().toLowerCase() : null,
    ship_address: type === "envio" ? f.address.trim() : null,
    notes: f.notes.trim() ? f.notes.trim() : null,
    payment_preference: o?.pay_link ? f.payment : "al_retirar",
    website: f.website,
  };
}

/** Token de seguimiento: 32 bytes al azar en base64url (43 caracteres). */
export function newTrackingToken(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function trackingPath(slug: string, token: string): string {
  return `/c/${encodeURIComponent(slug)}/pedido/${token}`;
}

export interface CreateOrderResult {
  ok: boolean;
  number: number | null;
  total?: number;
  item_count?: number;
  delivery_type?: CatalogDeliveryType;
  pickup_code?: string | null;
  reserved_until?: string | null;
  payment_preference?: PaymentPreference;
  already?: boolean;
}

const ERRORS: [RegExp, string][] = [
  [/catalog_orders_unavailable/, "Este negocio no está tomando pedidos online en este momento."],
  [/rate_limited/, "Hiciste varios pedidos seguidos. Esperá unos minutos y volvé a intentar."],
  [/insufficient_available_stock: ?(.*)/, "No queda stock suficiente de $1. Ajustá la cantidad y volvé a confirmar."],
  [/variant_required: ?(.*)/, "Elegí la variante de $1."],
  [/variant_unavailable: ?(.*)/, "Esa variante de $1 ya no está disponible."],
  [/product_unavailable/, "Uno de los productos ya no está disponible. Actualizá el catálogo."],
  [/invalid_quantity/, "Revisá las cantidades del carrito."],
  [/too_many_items/, "El carrito tiene demasiados productos distintos (máximo 50)."],
  [/cart_required/, "Tu carrito está vacío."],
  [/delivery_type_disabled|invalid_delivery_type/, "Ese tipo de entrega no está disponible. Elegí otro."],
  [/cross_branch_not_allowed|store_not_found/, "Esa sucursal no está disponible para retirar."],
  [/ship_address_required|ship_address_too_long/, "Revisá la dirección de entrega."],
  [/customer_name_required/, "Escribí tu nombre."],
  [/customer_phone_invalid/, "Revisá el teléfono."],
  [/customer_email_invalid/, "Revisá el email."],
  [/notes_too_long/, "La nota es muy larga."],
  [/payment_link_unavailable|invalid_payment_preference/, "El pago online no está disponible. Elegí pagar al retirar."],
  [/order_conflict/, "No pudimos registrar el pedido. Volvé a intentar."],
];

export function catalogOrderErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [re, text] of ERRORS) {
    const m = msg.match(re);
    if (m) return text.replace("$1", (m[1] ?? "").trim() || "un producto");
  }
  return "No pudimos enviar el pedido. Revisá tu conexión y volvé a intentar.";
}

/** ¿Vale la pena volver a pedir el catálogo? (precio o stock cambiaron). */
export function errorNeedsRefresh(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  return /insufficient_available_stock|product_unavailable|variant_unavailable/.test(msg);
}

// ── Seguimiento ─────────────────────────────────────────────────────────────

export interface PublicOrderStatus {
  number: number;
  status: "abierto" | "tomado" | "cobrado" | "anulado" | "vencido";
  delivery_type: "inmediato" | "retiro" | "envio";
  created_at: string;
  paid_at: string | null;
  total: number;
  item_count: number;
  customer_name: string | null;
  ship_address: string | null;
  payment_preference: PaymentPreference | null;
  reserved_until: string | null;
  lines: { name: string; variant: string | null; qty: number; unit_price: number; unit: string }[];
  dispatch: {
    status: "pendiente" | "armando" | "listo" | "en_transito" | "entregado" | "despachado" | "cancelado";
    tracking: string | null;
    ready_at: string | null;
    sent_at: string | null;
    arrived_at: string | null;
    delivered_at: string | null;
  } | null;
  pickup_store: { name: string; address: string | null; phone: string | null } | null;
  business: {
    name: string;
    slug: string;
    logo_url: string | null;
    accent: string | null;
    legal_name: string | null;
    trade_name: string | null;
    phone: string | null;
  } | null;
}

export type TrackingStage = "recibido" | "confirmado" | "preparando" | "listo" | "en_camino" | "entregado" | "cancelado";

/** Etapa que ve el cliente, a partir del pedido y de su entrega. */
export function trackingStage(o: Pick<PublicOrderStatus, "status" | "dispatch" | "delivery_type">): TrackingStage {
  if (o.status === "anulado" || o.status === "vencido") return "cancelado";
  if (o.status !== "cobrado") return "recibido";
  const d = o.dispatch;
  if (!d) return "confirmado";
  switch (d.status) {
    case "cancelado":
      return "cancelado";
    case "entregado":
    case "despachado":
      return "entregado";
    case "en_transito":
      return "en_camino";
    case "listo":
      return "listo";
    case "armando":
      return "preparando";
    default:
      return "confirmado";
  }
}

export function trackingSteps(type: PublicOrderStatus["delivery_type"]): { stage: TrackingStage; label: string }[] {
  return [
    { stage: "recibido", label: "Recibido" },
    { stage: "confirmado", label: "Pagado" },
    { stage: "preparando", label: "Preparando" },
    { stage: "listo", label: type === "envio" ? "Listo para enviar" : "Listo para retirar" },
    { stage: "entregado", label: type === "envio" ? "Despachado" : "Entregado" },
  ];
}

const STAGE_ORDER: TrackingStage[] = ["recibido", "confirmado", "preparando", "listo", "en_camino", "entregado"];

/** Índice del paso actual en trackingSteps (en camino cuenta como listo). */
export function stageIndex(stage: TrackingStage): number {
  if (stage === "cancelado") return -1;
  if (stage === "en_camino") return 3;
  const i = STAGE_ORDER.indexOf(stage);
  return i > 3 ? 4 : i;
}

export function trackingHeadline(o: Pick<PublicOrderStatus, "status" | "dispatch" | "delivery_type" | "payment_preference">): string {
  const s = trackingStage(o);
  const envio = o.delivery_type === "envio";
  switch (s) {
    case "recibido":
      return o.payment_preference === "link"
        ? "Recibimos tu pedido. El negocio te va a mandar el link de pago."
        : envio
          ? "Recibimos tu pedido. El negocio lo confirma y te avisa."
          : "Recibimos tu pedido. Pagás cuando lo retirás.";
    case "confirmado":
      return "Pago registrado. Ya lo están por preparar.";
    case "preparando":
      return "Están preparando tu pedido.";
    case "listo":
      return envio ? "Tu pedido está listo para salir." : "Tu pedido está listo. Ya podés pasar a retirarlo.";
    case "en_camino":
      return "Tu pedido va camino a la sucursal de retiro.";
    case "entregado":
      return envio ? "Tu pedido salió para tu domicilio." : "Pedido entregado. Gracias por tu compra.";
    default:
      return "El pedido se canceló. Si tenés dudas, escribile al negocio.";
  }
}

export function whatsappOrderText(businessName: string, number: number, url: string | null): string {
  return [`Hola ${businessName}, te escribo por mi pedido N° ${number} del catálogo.`, ...(url ? [url] : [])].join("\n");
}

export const DELIVERY_LABEL: Record<CatalogDeliveryType, string> = {
  retiro: "Retiro en sucursal",
  envio: "Envío a domicilio",
};

export const PAYMENT_LABEL: Record<PaymentPreference, string> = {
  al_retirar: "Pagás al retirar",
  link: "Pagar ahora con link",
};

export function paymentLabel(p: PaymentPreference, type: CatalogDeliveryType | null): string {
  if (p === "al_retirar") return type === "envio" ? "Pagás al recibir" : "Pagás al retirar";
  return PAYMENT_LABEL.link;
}
