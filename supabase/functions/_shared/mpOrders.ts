// =============================================================================
// _shared/mpOrders.ts — lógica PURA de Mercado Pago presencial sobre la Orders
// API (ADR-032): payloads de orders QR/Point, mapeo de estados, chequeo de
// monto, elección de credencial (producción / prueba) y parseo de webhooks.
//
// Sin imports ni APIs de Deno: lo usan las Edge Functions (mp_qr, mp_point,
// mp_orders_webhook, mp_create_qr, mp_webhook) y lo testea Vitest
// (tests/unit/mpOrders.test.ts).
// =============================================================================

export type IntentStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";
export type MpEnv = "prod" | "test";
export type CardType = "debit" | "credit";

/** Monto en el formato de la Orders API: string con dos decimales ("1234.50"). */
export function toAmountString(n: number): string {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

const cents = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
};

/** Monto exacto en centavos (antifraude: nunca se acredita con diferencia). */
export function amountsMatch(paid: unknown, expected: unknown): boolean {
  const a = cents(paid);
  const b = cents(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b;
}

const DEFAULT_TITLE = "Venta NinjaPos";
// Vencimiento de la order (la doc permite PT30S..PT3H; default de MP 15 min).
const EXPIRATION = "PT15M";

export interface QrOrderBody {
  type: "qr";
  total_amount: string;
  external_reference: string;
  description: string;
  expiration_time: string;
  config: { qr: { external_pos_id: string; mode: "dynamic" } };
  transactions: { payments: { amount: string }[] };
}

/** Order QR dinámica (un QR único por cobro) atada a la caja del tenant. */
export function buildQrOrderBody(p: {
  intentId: string;
  amount: number;
  externalPosId: string;
  title?: string;
}): QrOrderBody {
  const amount = toAmountString(p.amount);
  return {
    type: "qr",
    total_amount: amount,
    external_reference: p.intentId,
    description: (p.title || DEFAULT_TITLE).slice(0, 150),
    expiration_time: EXPIRATION,
    config: { qr: { external_pos_id: p.externalPosId, mode: "dynamic" } },
    transactions: { payments: [{ amount }] },
  };
}

export type PointPaymentMethod = {
  default_type: "debit_card" | "credit_card";
  default_installments?: number;
  installments_cost?: "buyer" | "seller";
};

export interface PointOrderBody {
  type: "point";
  external_reference: string;
  description: string;
  expiration_time: string;
  transactions: { payments: { amount: string }[] };
  config: { point: { terminal_id: string }; payment_method?: PointPaymentMethod };
}

/**
 * Order Point (cobro empujado al lector en modo PDV). Sin `defaultType` ni
 * cuotas, el cliente elige medio y cuotas en el lector. Cuotas > 1 requieren
 * crédito + `installments_cost` (la API devuelve 400 missing_installments_cost
 * si falta) y que MP haya habilitado la preconfiguración de cuotas.
 */
export function buildPointOrderBody(p: {
  intentId: string;
  amount: number;
  terminalId: string;
  title?: string;
  installments?: number;
  defaultType?: "debit_card" | "credit_card";
}): PointOrderBody {
  const amount = toAmountString(p.amount);
  const body: PointOrderBody = {
    type: "point",
    external_reference: p.intentId,
    description: (p.title || DEFAULT_TITLE).slice(0, 150),
    expiration_time: EXPIRATION,
    transactions: { payments: [{ amount }] },
    config: { point: { terminal_id: p.terminalId } },
  };
  const inst = Math.max(1, Math.floor(Number(p.installments) || 1));
  if (p.defaultType === "debit_card") {
    body.config.payment_method = { default_type: "debit_card" };
  } else if (inst > 1) {
    body.config.payment_method = {
      default_type: "credit_card",
      default_installments: inst,
      installments_cost: "buyer",
    };
  } else if (p.defaultType === "credit_card") {
    body.config.payment_method = { default_type: "credit_card" };
  }
  return body;
}

export function cardTypeOf(type: string | undefined | null): CardType {
  return type === "debit_card" || type === "prepaid_card" ? "debit" : "credit";
}

export interface MpOrderPayment {
  id?: string;
  amount?: string | number;
  status?: string;
  status_detail?: string;
  payment_method?: { type?: string; installments?: number };
}
export interface MpOrder {
  id?: string;
  external_reference?: string;
  status?: string;
  status_detail?: string;
  total_amount?: string;
  transactions?: { payments?: MpOrderPayment[] };
}

export interface ResolvedOrder {
  status: IntentStatus;
  paymentId: string | null;
  cardType: CardType | null;
  reason: "amount_mismatch" | "reference_mismatch" | "not_accredited" | null;
}

/**
 * Traduce una order (SIEMPRE re-leída de la API con el token del tenant, nunca
 * el payload del webhook) al estado local del intent. Sólo `approved` con:
 * order processed (detalle processed/accredited) + pago processed + monto
 * exacto + external_reference = intent.
 */
export function resolveOrder(
  order: MpOrder,
  ctx: { intentId: string; expectedAmount: number },
): ResolvedOrder {
  const none = (status: IntentStatus, reason: ResolvedOrder["reason"] = null): ResolvedOrder => ({
    status,
    paymentId: null,
    cardType: null,
    reason,
  });
  if (order.external_reference !== ctx.intentId) return none("pending", "reference_mismatch");

  const status = String(order.status ?? "").toLowerCase();
  const detail = String(order.status_detail ?? "").toLowerCase();
  const payments = order.transactions?.payments ?? [];
  const paid = payments.find((p) => String(p.status ?? "").toLowerCase() === "processed");

  switch (status) {
    case "processed": {
      if (detail && detail !== "processed" && detail !== "accredited") {
        // p. ej. partially_refunded: ya no es el cobro íntegro.
        return { ...none("rejected", "not_accredited"), paymentId: paid?.id ?? null };
      }
      if (!paid) return none("pending");
      if (!amountsMatch(paid.amount, ctx.expectedAmount)) {
        return { ...none("rejected", "amount_mismatch"), paymentId: paid.id ?? null };
      }
      return {
        status: "approved",
        paymentId: paid.id ?? null,
        cardType: cardTypeOf(paid.payment_method?.type),
        reason: null,
      };
    }
    case "canceled":
    case "cancelled":
      return none("cancelled");
    case "expired":
      return none("expired");
    case "failed":
    case "refunded":
      return none("rejected");
    default:
      // created / at_terminal / action_required / processing / desconocido.
      return none("pending");
  }
}

/** Estado de la Point Payment Intents API (legacy) para intents viejos. */
export function legacyPointStatus(state: string): "finished" | "pending" | "cancelled" {
  const s = String(state ?? "").toUpperCase();
  if (s === "FINISHED") return "finished";
  if (["CANCELED", "CANCELLED", "ERROR", "ABANDONED", "EXPIRED"].includes(s)) return "cancelled";
  return "pending";
}

/** Intents creados sobre la Orders API guardan mp_order_id; los legacy no. */
export function isOrdersIntent(row: { mp_order_id?: string | null }): boolean {
  return typeof row.mp_order_id === "string" && row.mp_order_id.length > 0;
}

/** Webhook topic `order`: type + data.id (body o query). Nunca se confía en el resto. */
export function parseOrderNotification(
  url: URL,
  body: unknown,
): { type: string | null; orderId: string | null; action: string | null } {
  const b = (body && typeof body === "object" ? body : {}) as {
    type?: unknown;
    topic?: unknown;
    action?: unknown;
    data?: { id?: unknown };
  };
  const type =
    (typeof b.type === "string" && b.type) ||
    (typeof b.topic === "string" && b.topic) ||
    url.searchParams.get("type") ||
    url.searchParams.get("topic") ||
    null;
  const rawId =
    (b.data && (typeof b.data.id === "string" || typeof b.data.id === "number")
      ? String(b.data.id)
      : "") ||
    url.searchParams.get("data.id") ||
    url.searchParams.get("id") ||
    "";
  const orderId = /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : null;
  const action = typeof b.action === "string" ? b.action : null;
  return { type, orderId, action };
}

export interface MpSecrets {
  access_token?: string | null;
  test_access_token?: string | null;
}

/**
 * Credencial MP a usar. `sandbox` = switch del medio (tenant_payment_methods);
 * sólo pasa a prueba si además hay token de prueba cargado (las filas legacy
 * nacieron con sandbox=true por default y siempre cobraron en producción).
 * `forceEnv` fija el ambiente de un intent ya creado (status / webhook).
 */
export function pickMpCredential(
  secrets: MpSecrets | null | undefined,
  sandbox: boolean,
  forceEnv?: MpEnv | null,
): { token: string; env: MpEnv } | null {
  const prod = secrets?.access_token || null;
  const test = secrets?.test_access_token || null;
  if (forceEnv === "test") return test ? { token: test, env: "test" } : null;
  if (forceEnv === "prod") return prod ? { token: prod, env: "prod" } : null;
  if (sandbox && test) return { token: test, env: "test" };
  if (prod) return { token: prod, env: "prod" };
  return null;
}

/** external_id de sucursal (≤60) y caja (≤40), alfanuméricos y estables por tenant. */
export function mpExternalIds(tenantId: string): { storeExternalId: string; posExternalId: string } {
  const hex = tenantId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 32);
  return { storeExternalId: `NSPOS${hex}`, posExternalId: `NS${hex}C1` };
}

// Provincias tal como las nombra Mercado Pago en `location.state_name` (AR).
export const MP_AR_STATES = [
  "Buenos Aires",
  "Capital Federal",
  "Catamarca",
  "Chaco",
  "Chubut",
  "Córdoba",
  "Corrientes",
  "Entre Ríos",
  "Formosa",
  "Jujuy",
  "La Pampa",
  "La Rioja",
  "Mendoza",
  "Misiones",
  "Neuquén",
  "Río Negro",
  "Salta",
  "San Juan",
  "San Luis",
  "Santa Cruz",
  "Santa Fe",
  "Santiago del Estero",
  "Tierra del Fuego",
  "Tucumán",
] as const;

export interface StoreSetup {
  name: string;
  location: {
    street_name: string;
    street_number: string;
    city_name: string;
    state_name: string;
    latitude: number;
    longitude: number;
    reference: string;
  };
}

/**
 * Valida los datos de la sucursal que carga el dueño (alta única de sucursal +
 * caja en MP). `coordinates` es el texto que copia de Google Maps
 * ("-34.6037, -58.3816"). Devuelve el primer campo inválido.
 */
export function parseStoreSetup(
  input: Record<string, unknown>,
): { ok: true; value: StoreSetup } | { ok: false; field: string } {
  const str = (k: string, max: number) =>
    typeof input[k] === "string" ? (input[k] as string).trim().slice(0, max) : "";
  const name = str("name", 60);
  if (!name) return { ok: false, field: "name" };
  const street_name = str("street_name", 100);
  if (!street_name) return { ok: false, field: "street_name" };
  const street_number = str("street_number", 20);
  if (!street_number) return { ok: false, field: "street_number" };
  const city_name = str("city_name", 80);
  if (!city_name) return { ok: false, field: "city_name" };
  const state_name = str("state_name", 40);
  if (!(MP_AR_STATES as readonly string[]).includes(state_name)) {
    return { ok: false, field: "state_name" };
  }
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(str("coordinates", 60));
  const latitude = m ? Number(m[1]) : Number.NaN;
  const longitude = m ? Number(m[2]) : Number.NaN;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { ok: false, field: "coordinates" };
  }
  return {
    ok: true,
    value: {
      name,
      location: {
        street_name,
        street_number,
        city_name,
        state_name,
        latitude,
        longitude,
        reference: str("reference", 120),
      },
    },
  };
}

/** Body de POST /users/{user_id}/stores. */
export function buildStoreBody(s: StoreSetup, storeExternalId: string) {
  return { name: s.name, external_id: storeExternalId, location: { ...s.location } };
}

/** Body de POST /v2/pos (caja para orders QR; external_id obligatorio para crear orders). */
export function buildPosBody(
  storeId: string,
  ids: { storeExternalId: string; posExternalId: string },
) {
  return {
    name: "Caja NinjaPos",
    store_id: storeId,
    external_store_id: ids.storeExternalId,
    external_id: ids.posExternalId,
  };
}

export function mapTerminals(resp: unknown): { id: string; operating_mode: string }[] {
  const terminals = (resp as { data?: { terminals?: unknown[] } } | null)?.data?.terminals ?? [];
  const out: { id: string; operating_mode: string }[] = [];
  for (const t of terminals) {
    const x = t as { id?: unknown; operating_mode?: unknown };
    if (typeof x.id !== "string" || !x.id) continue;
    out.push({
      id: x.id,
      operating_mode: typeof x.operating_mode === "string" ? x.operating_mode : "UNKNOWN",
    });
  }
  return out;
}
