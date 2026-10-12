// =============================================================================
// GO Cuotas · lógica pura compartida por las Edge `gocuotas` y
// `gocuotas_webhook` (testeada con Vitest en tests/unit/gocuotas.test.ts).
// Sin imports: corre igual en Deno (Edge) y en Node (tests).
//
// VERIFICADO contra la doc oficial (https://gocuotas-api.stoplight.io/docs/gocuotas,
// API Redirect V1, leída 2026-10-11):
//   * Hosts: producción https://www.gocuotas.com · sandbox https://sandbox.gocuotas.com.
//   * Auth: API Key de la SUCURSAL como `Authorization: Bearer <API_KEY>` (no
//     expira; evita /authentication).
//   * Crear checkout: POST /api_redirect/v1/checkouts con parámetros de QUERY
//     amount_in_cents, url_success, url_failure, order_reference_id,
//     webhook_url, email, phone_number → { url_init }. No devuelve id de orden.
//   * Orden: GET /api_redirect/v1/orders/{id} → { id, amount_in_cents, status,
//     order_reference_id, number_of_installments, … }.
//   * Listado: GET /api_redirect/v1/orders?delivered_start&delivered_end
//     (requeridos, "YYYY-MM-DD HH:mm") &order_reference_id → orden(es).
//   * Webhook: POST JSON { order_reference_id, status, order_id,
//     number_of_installments, amount_in_cents }. Estados: undefined
//     (pendiente), approved, denied (abandonado a los 30 min, campos null).
//     Sin firma documentada → el cuerpo es sólo una PISTA.
//   * Monto mínimo: $1.500 (150000 centavos).
// INFERIDO:
//   * Forma exacta del listado (array, objeto o envoltorio): se normaliza.
//   * Zona horaria de delivered_start/end: Argentina (UTC-3). Se usa una
//     ventana amplia (desde 24 h antes de crear el intent hasta mañana).
//   * La API QR V1 (/api/qr/v1/checkouts) devuelve sólo sale_token, sin un
//     payload escaneable: el QR es el del local. Por eso el POS usa Redirect
//     (url_init como QR + link), igual que Getnet.
// =============================================================================

export type GoCuotasEnv = "sandbox" | "prod";

export const GOCUOTAS_BASE: Record<GoCuotasEnv, string> = {
  prod: "https://www.gocuotas.com",
  sandbox: "https://sandbox.gocuotas.com",
};

export const GOCUOTAS_MIN_CENTS = 150000; // $1.500

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

// Ids de orden de GO Cuotas: enteros. Nada que pueda alterar el path.
const ORDER_ID_RE = /^\d{1,20}$/;

export function gocuotasEnv(sandbox: boolean | null | undefined): GoCuotasEnv {
  return sandbox === true ? "sandbox" : "prod";
}

export function toCents(amount: number): number {
  return Math.round(Number(amount) * 100);
}

export type CheckoutInput = {
  amount: number;
  orderReferenceId: string;
  webhookUrl: string;
  successUrl: string;
  failureUrl: string;
  email?: string | null;
  phone?: string | null;
};

// URL completa del POST de checkout (los parámetros van por query, como en la
// doc oficial). El monto lo fija el servidor y es el que se verifica al acreditar.
export function buildCheckoutUrl(env: GoCuotasEnv, i: CheckoutInput): string {
  if (!Number.isFinite(i.amount) || i.amount <= 0) throw new Error("invalid_amount");
  const cents = toCents(i.amount);
  if (cents < GOCUOTAS_MIN_CENTS) throw new Error("gocuotas_min_amount");
  const q = new URLSearchParams({
    amount_in_cents: String(cents),
    order_reference_id: i.orderReferenceId,
    webhook_url: i.webhookUrl,
    url_success: i.successUrl,
    url_failure: i.failureUrl,
  });
  const email = (i.email ?? "").trim();
  if (email) q.set("email", email);
  const phone = (i.phone ?? "").replace(/\D/g, "");
  if (phone) q.set("phone_number", phone);
  return `${GOCUOTAS_BASE[env]}/api_redirect/v1/checkouts?${q.toString()}`;
}

export function parseCheckoutResponse(json: unknown): { urlInit: string } | null {
  if (!isObj(json)) return null;
  const u = str(json.url_init);
  if (!u || !/^https:\/\//i.test(u)) return null;
  return { urlInit: u };
}

export type IntentStatus = "approved" | "rejected" | "cancelled" | "pending";

export function mapGoCuotasStatus(status: string): IntentStatus {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "denied" || s === "rejected") return "rejected";
  if (s === "cancelled" || s === "canceled" || s === "expired") return "cancelled";
  return "pending"; // undefined | processing | desconocido
}

// El cuerpo del webhook es sólo una PISTA: qué orden re-consultar.
export function extractWebhookHint(body: unknown): {
  orderId: string | null;
  reference: string | null;
} {
  if (!isObj(body)) return { orderId: null, reference: null };
  const id = str(body.order_id);
  return {
    orderId: id && ORDER_ID_RE.test(id) ? id : null,
    reference: str(body.order_reference_id),
  };
}

export function normalizeOrders(json: unknown): Obj[] {
  if (Array.isArray(json)) return json.filter(isObj);
  if (!isObj(json)) return [];
  for (const k of ["orders", "data", "results"]) {
    const v = json[k];
    if (Array.isArray(v)) return v.filter(isObj);
  }
  return "id" in json || "status" in json ? [json] : [];
}

export type Decision = {
  status: IntentStatus;
  state: string;
  orderId?: string;
  reason?: "amount_mismatch" | "amount_unverified" | "reference_mismatch";
};

// Decide el estado del intent a partir de la orden RE-CONSULTADA a GO Cuotas.
// Sólo cuenta una orden cuya order_reference_id sea el intent (la mandamos al
// crear el checkout). Aprobado sólo con monto exacto en centavos.
export function decideIntentUpdate(
  order: unknown,
  expectedAmount: number,
  intentId: string,
): Decision {
  if (!isObj(order)) return { status: "pending", state: "" };
  const state = (str(order.status) ?? "").toLowerCase();
  if (str(order.order_reference_id) !== intentId) {
    return { status: "pending", state, reason: "reference_mismatch" };
  }
  const id = str(order.id);
  const orderId = id && ORDER_ID_RE.test(id) ? id : undefined;
  const mapped = mapGoCuotasStatus(state);
  if (mapped !== "approved") return { status: mapped, state, ...(orderId ? { orderId } : {}) };
  const cents = order.amount_in_cents;
  if (typeof cents !== "number" || !Number.isInteger(cents)) {
    return { status: "pending", state, reason: "amount_unverified" };
  }
  if (cents !== toCents(expectedAmount)) {
    return { status: "rejected", state, reason: "amount_mismatch", ...(orderId ? { orderId } : {}) };
  }
  if (!orderId) return { status: "pending", state, reason: "amount_unverified" };
  return { status: "approved", state, orderId };
}

// "YYYY-MM-DD HH:mm" en hora de Argentina (UTC-3, sin horario de verano).
export function formatArDateTime(d: Date): string {
  const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ar.getUTCFullYear()}-${p(ar.getUTCMonth() + 1)}-${p(ar.getUTCDate())} ${p(
    ar.getUTCHours(),
  )}:${p(ar.getUTCMinutes())}`;
}

export type OrderLookup =
  | { ok: true; order: Obj | null }
  | { ok: false; httpStatus: number; detail: string };

async function getJson(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<{ ok: true; json: unknown } | { ok: false; httpStatus: number; detail: string }> {
  try {
    const r = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return { ok: false, httpStatus: r.status, detail: (await r.text()).slice(0, 300) };
    const json = await r.json().catch(() => undefined);
    if (json === undefined) return { ok: false, httpStatus: 502, detail: "invalid_json" };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, httpStatus: 502, detail: String(e).slice(0, 300) };
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Busca la orden de GO Cuotas del intent: primero la pista del webhook
// (GET /orders/{id}) y, si no corresponde a este intent, el listado filtrado
// por order_reference_id. Nunca devuelve una orden de otra referencia.
export async function resolveOrder(p: {
  env: GoCuotasEnv;
  apiKey: string;
  intentId: string;
  createdAt: string;
  hintedOrderId: string | null;
  fetchImpl?: FetchLike;
}): Promise<OrderLookup> {
  const f = p.fetchImpl ?? fetch;
  const base = GOCUOTAS_BASE[p.env];
  const mine = (o: Obj) => str(o.order_reference_id) === p.intentId;

  if (p.hintedOrderId && ORDER_ID_RE.test(p.hintedOrderId)) {
    const r = await getJson(`${base}/api_redirect/v1/orders/${p.hintedOrderId}`, p.apiKey, f);
    if (r.ok && isObj(r.json) && mine(r.json)) return { ok: true, order: r.json };
    if (!r.ok && r.httpStatus !== 404) return r;
  }

  const created = new Date(p.createdAt);
  const startMs = Number.isNaN(created.getTime()) ? Date.now() - 2 * DAY_MS : created.getTime() - DAY_MS;
  const q = new URLSearchParams({
    delivered_start: formatArDateTime(new Date(startMs)),
    delivered_end: formatArDateTime(new Date(Date.now() + DAY_MS)),
    order_reference_id: p.intentId,
  });
  const r = await getJson(`${base}/api_redirect/v1/orders?${q.toString()}`, p.apiKey, f);
  if (!r.ok) return r.httpStatus === 404 ? { ok: true, order: null } : r;
  const candidates = normalizeOrders(r.json).filter(mine);
  const approved = candidates.find((o) => mapGoCuotasStatus(String(o.status ?? "")) === "approved");
  return { ok: true, order: approved ?? candidates[0] ?? null };
}
