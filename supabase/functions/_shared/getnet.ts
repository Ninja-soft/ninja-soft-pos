// =============================================================================
// Getnet Argentina (Geopagos white-label) · lógica pura compartida por las Edge
// `getnet` y `getnet_webhook` (y testeada con Vitest en tests/unit/getnet.test.ts).
// Sin imports: corre igual en Deno (Edge) y en Node (tests).
//
// VERIFICADO contra el plugin oficial "integrar-getnet-con-woo" v0.1.5
// (autor Getnet Argentina / Wanderlust):
//   * Token: POST https://auth.geopagos.com/oauth/token, JSON
//     { client_id, client_secret, grant_type:'client_credentials', scope:'*' }
//     → { access_token }.
//   * Crear orden: POST https://api.globalgetnet.com.ar/api/v2/orders
//     headers Content-Type/Accept: application/vnd.api+json, Bearer token.
//     body { data: { attributes: { items:[{ id, name, unitPrice:{ currency:'032',
//     amount:'<centavos sin punto>' }, quantity }], redirect_urls:{ success,
//     failed }, webhookUrl, expireLimitMinutes } } }
//     → data.links[0].checkout (URL hosted), data.attributes.payments[0].reference_number.
//   * Webhook: body.data.order.uuid → GET /api/v2/orders/{uuid} y se mira
//     `status` (raíz): APPROVED | PROCESSED | SUCCESS = pago aprobado.
// INFERIDO (no está en el plugin ni en docs públicas de AR):
//   * uuid de la orden en data.id (fallback attributes.uuid / data.uuid).
//   * Forma del monto en el GET (se prioriza la suma de ítems, mismo formato
//     que el request; fallback amount/total/totalAmount).
//   * Estados de rechazo/vencimiento (REJECTED, EXPIRED, …).
//   * Que el GET acepte el mismo Bearer (el plugin arma mal ese header).
//   * No hay sandbox público de Getnet AR: se valida con cobros reales chicos.
// =============================================================================

export const GETNET_AUTH_URL = "https://auth.geopagos.com/oauth/token";
export const GETNET_ORDERS_URL = "https://api.globalgetnet.com.ar/api/v2/orders";
export const GETNET_CURRENCY = "032"; // ISO 4217 numérico de ARS.
export const GETNET_EXPIRE_MINUTES = 30;
const DEFAULT_TITLE = "Venta NinjaPos";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

// Ids de orden de Getnet (uuid u otro token alfanumérico): nada que pueda
// alterar el path del GET.
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export function buildTokenRequest(clientId: string, clientSecret: string) {
  return {
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    grant_type: "client_credentials",
    scope: "*",
  };
}

export async function fetchGetnetToken(
  clientId: string,
  clientSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const r = await fetchImpl(GETNET_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildTokenRequest(clientId, clientSecret)),
    });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as { access_token?: unknown } | null;
    return str(j?.access_token);
  } catch {
    return null;
  }
}

export type OrderPayloadInput = {
  amount: number;
  title?: string;
  webhookUrl: string;
  successUrl: string;
  failedUrl: string;
  expireMinutes?: number;
};

// Un único ítem por el total: el monto lo fija el servidor (nunca el cliente)
// y es el mismo que se verifica al acreditar.
export function buildOrderPayload(i: OrderPayloadInput) {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  const name = (i.title ?? "").trim().slice(0, 120) || DEFAULT_TITLE;
  return {
    data: {
      attributes: {
        items: [
          {
            id: 1,
            name,
            unitPrice: { currency: GETNET_CURRENCY, amount: String(toCents(i.amount)) },
            quantity: 1,
          },
        ],
        redirect_urls: { success: i.successUrl, failed: i.failedUrl },
        webhookUrl: i.webhookUrl,
        expireLimitMinutes: i.expireMinutes ?? GETNET_EXPIRE_MINUTES,
      },
    },
  };
}

export type CreatedOrder = {
  orderId: string;
  checkoutUrl: string;
  referenceNumber: string | null;
};

export function parseCreateResponse(json: unknown): CreatedOrder | null {
  if (!isObj(json) || !isObj(json.data)) return null;
  const data = json.data;
  const attrs = isObj(data.attributes) ? data.attributes : {};
  const links = Array.isArray(data.links) ? data.links : [];
  const first = links[0];
  const checkout = isObj(first) ? str(first.checkout) : null;
  if (!checkout || !/^https:\/\//i.test(checkout)) return null;
  const orderId = str(data.id) ?? str(attrs.uuid) ?? str(data.uuid);
  if (!orderId || !ORDER_ID_RE.test(orderId)) return null;
  const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
  const p0 = payments[0];
  const referenceNumber = isObj(p0) ? str(p0.reference_number) : null;
  return { orderId, checkoutUrl: checkout, referenceNumber };
}

// El cuerpo del webhook es sólo una PISTA (qué orden re-consultar).
export function extractWebhookOrderId(body: unknown): string | null {
  if (!isObj(body) || !isObj(body.data) || !isObj(body.data.order)) return null;
  const id = str(body.data.order.uuid);
  return id && ORDER_ID_RE.test(id) ? id : null;
}

export function readOrderStatus(order: unknown): string {
  if (!isObj(order)) return "";
  const data = isObj(order.data) ? order.data : null;
  const attrs = data && isObj(data.attributes) ? data.attributes : null;
  return (str(order.status) ?? str(attrs?.status) ?? str(data?.status) ?? "").toUpperCase();
}

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

const APPROVED = new Set(["APPROVED", "PROCESSED", "SUCCESS"]);
const REJECTED = new Set(["REJECTED", "DECLINED", "DENIED", "FAILED"]);
const CANCELLED = new Set(["EXPIRED", "CANCELLED", "CANCELED"]);

export function mapGetnetStatus(status: string): IntentStatus {
  const s = String(status ?? "").trim().toUpperCase();
  if (APPROVED.has(s)) return "approved";
  if (REJECTED.has(s)) return "rejected";
  if (CANCELLED.has(s)) return "cancelled";
  return "pending";
}

// Monto → centavos. Entero (número o string sin punto) = centavos, como el
// request; con decimales = pesos.
function centsOf(v: unknown): number | null {
  if (isObj(v)) return centsOf(v.amount);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? v : toCents(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (/^\d+\.\d{1,2}$/.test(t)) return toCents(Number(t));
  }
  return null;
}

function sumItems(items: unknown): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const it of items) {
    if (!isObj(it)) return null;
    const unit = centsOf(it.unitPrice);
    if (unit === null) return null;
    const q = it.quantity == null ? 1 : Number(it.quantity);
    if (!Number.isInteger(q) || q <= 0) return null;
    total += unit * q;
  }
  return total;
}

export function extractOrderAmountCents(order: unknown): number | null {
  if (!isObj(order)) return null;
  const data = isObj(order.data) ? order.data : null;
  const attrs = data && isObj(data.attributes) ? data.attributes : null;
  const layers = [attrs, data, order].filter(isObj);
  for (const l of layers) {
    const s = sumItems(l.items);
    if (s !== null) return s;
  }
  for (const l of layers) {
    for (const k of ["amount", "total", "total_amount", "totalAmount"]) {
      const c = centsOf(l[k]);
      if (c !== null) return c;
    }
  }
  return null;
}

export type Decision = {
  status: IntentStatus;
  state: string;
  reason?: "amount_mismatch" | "amount_unverified";
};

// Decide el estado del intent a partir de la orden RE-CONSULTADA a Getnet.
// Aprobado sólo con monto exacto (centavos); sin monto legible no se acredita.
export function decideIntentUpdate(order: unknown, expectedAmount: number): Decision {
  const state = readOrderStatus(order);
  const mapped = mapGetnetStatus(state);
  if (mapped !== "approved") return { status: mapped, state };
  const cents = extractOrderAmountCents(order);
  if (cents === null) return { status: "pending", state, reason: "amount_unverified" };
  if (cents !== toCents(expectedAmount)) {
    return { status: "rejected", state, reason: "amount_mismatch" };
  }
  return { status: "approved", state };
}

export type OrderFetch =
  | { ok: true; order: unknown }
  | { ok: false; httpStatus: number; detail: string };

export async function fetchGetnetOrder(
  token: string,
  orderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<OrderFetch> {
  if (!ORDER_ID_RE.test(orderId)) {
    return { ok: false, httpStatus: 400, detail: "invalid_order_id" };
  }
  try {
    const r = await fetchImpl(`${GETNET_ORDERS_URL}/${orderId}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      return { ok: false, httpStatus: r.status, detail: (await r.text()).slice(0, 300) };
    }
    const order = await r.json().catch(() => null);
    if (order === null) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, order };
  } catch (e) {
    return { ok: false, httpStatus: 502, detail: String(e).slice(0, 300) };
  }
}
