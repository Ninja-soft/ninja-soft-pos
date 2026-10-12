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

// Caja QR por caja (ADR-049): una sucursal de MP por sucursal de NinjaPos y
// una caja de MP por caja. Alfanuméricos y cortos (la caja de MP admite hasta
// 40): 16 hex del negocio + 16 hex de la sucursal o de la caja, sin choque
// con los ids de la caja única (NSPOS{32} / NS{32}C1).
export function mpExternalIdsFor(
  tenantId: string,
  storeId: string,
  registerId: string,
): { storeExternalId: string; posExternalId: string } {
  const hex = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
  return {
    storeExternalId: `NSPOS${hex(tenantId)}S${hex(storeId)}`,
    posExternalId: `NS${hex(tenantId)}R${hex(registerId)}`,
  };
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

export type MpArState = (typeof MP_AR_STATES)[number];

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

// ── "QR en el mostrador": dirección del negocio → local en MP ────────────────
// El dueño no carga nada técnico: se parte de la dirección del negocio
// (tenant_branding.address, texto libre), se geocodifica con Nominatim en la
// Edge y se arma la sucursal que pide MP. Todo puro (sin imports) y testeado.

/** Minúsculas, sin acentos ni puntos, espacios simples. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CAPITAL_ALIASES = new Set([
  "caba",
  "capital",
  "capital federal",
  "ciudad autonoma de buenos aires",
  "cdad autonoma de buenos aires",
  "ciudad de buenos aires",
  "autonomous city of buenos aires",
]);
const BSAS_ALIASES = new Set(["bs as", "bsas", "pba", "pcia buenos aires", "buenos aires province"]);

/** Provincia como la nombra MP (`location.state_name`) o null. */
export function normalizeArState(input: string | null | undefined): MpArState | null {
  let k = fold(input ?? "");
  if (!k) return null;
  if (CAPITAL_ALIASES.has(k)) return "Capital Federal";
  k = k.replace(/^(provincia|pcia) (de |del )?/, "");
  if (BSAS_ALIASES.has(k)) return "Buenos Aires";
  if (k.startsWith("tierra del fuego")) return "Tierra del Fuego";
  return MP_AR_STATES.find((st) => fold(st) === k) ?? null;
}

const NUMBER_TOKEN = /^\d{1,6}[a-z]{0,3}$/i;

/** "Av. Corrientes 1234 piso 3" → calle "Av. Corrientes", altura "1234". */
export function splitStreet(input: string): { street_name: string; street_number: string } {
  const s = input.replace(/\s+/g, " ").trim();
  // Marcador explícito de altura: "Calle 50 N° 123", "nro. 123", "# 123".
  const marked = /^(.*?)\s*(?:\bn[°º]|\bnro\.?|\bnum(?:ero)?\.?|\bnúmero|#)\s*(\d{1,6}[a-z]{0,3})\b/i.exec(s);
  if (marked && marked[1]) {
    return { street_name: marked[1].trim(), street_number: marked[2]! };
  }
  const tokens = s.split(" ");
  // La primera palabra puede ser número ("9 de Julio"): la altura es el primer
  // número que aparece después.
  for (let i = 1; i < tokens.length; i++) {
    if (NUMBER_TOKEN.test(tokens[i]!)) {
      return { street_name: tokens.slice(0, i).join(" "), street_number: tokens[i]! };
    }
  }
  return { street_name: s, street_number: "" };
}

export interface StoreAddress {
  street_name: string;
  street_number: string;
  city_name: string;
  state_name: string;
}

/** Código postal suelto ("1414", "B1642", "C1043AAZ") o "CP". */
const POSTAL_TOKEN = /^(?:[a-z]?\d{4}[a-z]{0,3}|cp|c\.p\.?)$/i;

/** Dirección del negocio (texto libre) → campos que pide MP. */
export function parseBusinessAddress(text: string | null | undefined): StoreAddress {
  const out: StoreAddress = { street_name: "", street_number: "", city_name: "", state_name: "" };
  const parts = (text ?? "")
    .split(",")
    // El código postal se limpia fuera de la calle (la altura también son 4 dígitos).
    .map((p, i) =>
      i === 0
        ? p.trim()
        : p
            .trim()
            .split(/\s+/)
            .filter((t) => !POSTAL_TOKEN.test(t))
            .join(" "),
    )
    .filter((p) => p && fold(p) !== "argentina");
  if (!parts.length) return out;
  Object.assign(out, splitStreet(parts[0]!));
  const rest = parts.slice(1);
  const last = rest.length ? normalizeArState(rest[rest.length - 1]) : null;
  if (last) {
    out.state_name = last;
    rest.pop();
  }
  for (const p of rest) {
    if (normalizeArState(p) === "Capital Federal" && (!out.state_name || out.state_name === "Capital Federal")) {
      out.state_name = "Capital Federal";
      continue;
    }
    if (!out.city_name) out.city_name = p;
  }
  return out;
}

/** Texto de búsqueda para el geocodificador (Nominatim, countrycodes=ar). */
export function buildGeocodeQuery(a: StoreAddress): string {
  if (!a.street_name.trim()) return "";
  const street = `${a.street_name.trim()} ${a.street_number.trim()}`.trim();
  const state = normalizeArState(a.state_name);
  const city = normalizeArState(a.city_name) === "Capital Federal" ? "" : a.city_name.trim();
  const stateQ = state === "Capital Federal" ? "Ciudad Autónoma de Buenos Aires" : (state ?? "");
  return [street, city, stateQ, "Argentina"].filter(Boolean).join(", ");
}

export interface GeoPick {
  lat: number;
  lon: number;
  /** true si el mapa encontró la altura exacta (no sólo la calle). */
  precise: boolean;
  /** "Avenida Corrientes 1234, San Nicolás": lo que ve el dueño para confirmar. */
  label: string;
  /** Localidad sugerida para MP (en Capital, el barrio). */
  city_name: string;
  state_name: string;
}

type NominatimAddress = Record<string, string | undefined>;

function cleanLocality(s: string | undefined): string {
  return (s ?? "").replace(/^(partido|municipio|departamento|comuna)\s+(de\s+|del\s+)?/i, "").trim();
}

function cityFromAddress(a: NominatimAddress, state: MpArState | null): string {
  if (state === "Capital Federal") {
    return cleanLocality(a.suburb ?? a.city_district ?? a.neighbourhood ?? a.quarter);
  }
  return cleanLocality(
    a.city ?? a.town ?? a.village ?? a.suburb ?? a.municipality ?? a.county ?? a.state_district,
  );
}

/** Bounding box amplio de Argentina continental + Tierra del Fuego. */
function inArgentina(lat: number, lon: number): boolean {
  return lat <= -21 && lat >= -56 && lon <= -53 && lon >= -74;
}

/**
 * Elige el mejor resultado de Nominatim (format=json, addressdetails=1):
 * dentro de Argentina, de la provincia esperada (si se sabe) y, de ser posible,
 * con la altura exacta.
 */
export function pickGeocodeResult(results: unknown, expectedState?: string): GeoPick | null {
  if (!Array.isArray(results)) return null;
  const expected = expectedState ? normalizeArState(expectedState) : null;
  const picks: GeoPick[] = [];
  for (const raw of results) {
    const r = (raw ?? {}) as {
      lat?: unknown;
      lon?: unknown;
      display_name?: string;
      address?: NominatimAddress;
    };
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inArgentina(lat, lon)) continue;
    const a = r.address ?? {};
    const state = normalizeArState(a.state);
    if (expected && state && state !== expected) continue;
    const city = cityFromAddress(a, state ?? expected);
    const road = a.road ?? a.pedestrian ?? a.footway ?? "";
    const street = [road, a.house_number].filter(Boolean).join(" ");
    const label =
      [street, city].filter(Boolean).join(", ") ||
      (r.display_name ?? "").split(",").slice(0, 2).map((s) => s.trim()).join(", ");
    picks.push({
      lat,
      lon,
      precise: Boolean(a.house_number),
      label,
      city_name: city,
      state_name: state ?? expected ?? "",
    });
  }
  return picks.find((p) => p.precise) ?? picks[0] ?? null;
}

/**
 * Localidad que se manda a MP. Manda la del dueño; en Capital, "CABA" no es
 * una localidad para MP (espera el barrio), así que se usa la del mapa.
 */
export function mpCityName(ownerCity: string, state: string, geoCity: string): string {
  const own = ownerCity.trim();
  const isCapitalAlias = normalizeArState(own) === "Capital Federal";
  if (own && !(isCapitalAlias && normalizeArState(state) === "Capital Federal")) return own;
  return geoCity.trim();
}

export interface StoreAddressInput extends StoreAddress {
  name: string;
  reference: string;
}

/**
 * Valida nombre + dirección (sin coordenadas). En Capital la localidad puede
 * venir vacía: la completa el mapa con el barrio.
 */
export function parseStoreAddress(
  input: Record<string, unknown>,
): { ok: true; value: StoreAddressInput } | { ok: false; field: string } {
  const str = (k: string, max: number) =>
    typeof input[k] === "string" ? (input[k] as string).trim().slice(0, max) : "";
  const name = str("name", 60);
  if (!name) return { ok: false, field: "name" };
  const street_name = str("street_name", 100);
  if (!street_name) return { ok: false, field: "street_name" };
  const street_number = str("street_number", 20);
  if (!street_number) return { ok: false, field: "street_number" };
  const state = normalizeArState(str("state_name", 60));
  const city_name = str("city_name", 80);
  if (!city_name && state !== "Capital Federal") return { ok: false, field: "city_name" };
  if (!state) return { ok: false, field: "state_name" };
  return {
    ok: true,
    value: {
      name,
      street_name,
      street_number,
      city_name,
      state_name: state,
      reference: str("reference", 120),
    },
  };
}

/**
 * Valida los datos completos de la sucursal (alta única de sucursal + caja en
 * MP). Las coordenadas llegan como `latitude`/`longitude` (geocodificadas) o
 * como el texto que copia Google Maps en `coordinates` ("-34.6037, -58.3816",
 * respaldo manual). Devuelve el primer campo inválido.
 */
export function parseStoreSetup(
  input: Record<string, unknown>,
): { ok: true; value: StoreSetup } | { ok: false; field: string } {
  const addr = parseStoreAddress(input);
  if (!addr.ok) return addr;
  if (!addr.value.city_name) return { ok: false, field: "city_name" };
  let latitude = Number.NaN;
  let longitude = Number.NaN;
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    latitude = input.latitude;
    longitude = input.longitude;
  } else {
    const txt = typeof input.coordinates === "string" ? input.coordinates.slice(0, 60) : "";
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(txt);
    if (m) {
      latitude = Number(m[1]);
      longitude = Number(m[2]);
    }
  }
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { ok: false, field: "coordinates" };
  }
  const v = addr.value;
  return {
    ok: true,
    value: {
      name: v.name,
      location: {
        street_name: v.street_name,
        street_number: v.street_number,
        city_name: v.city_name,
        state_name: v.state_name,
        latitude,
        longitude,
        reference: v.reference,
      },
    },
  };
}

/** Qué campo señala el rechazo de MP al crear la sucursal (texto de su error). */
export function mpStoreErrorField(detail: string): "city_name" | "state_name" | "address" | null {
  const d = detail.toLowerCase();
  if (/city/.test(d)) return "city_name";
  if (/state/.test(d)) return "state_name";
  if (/latitude|longitude|location|street|address/.test(d)) return "address";
  return null;
}

export type MpQrFix = "address" | "retry" | "reconnect" | "plan" | "none";
export interface MpQrError {
  title: string;
  message: string;
  fix: MpQrFix;
  field?: string;
}

const FIELD_MSG: Record<string, string> = {
  name: "Poné el nombre de tu local, como lo ven tus clientes.",
  street_name: "Falta la calle de tu local.",
  street_number: "Falta la altura de la calle.",
  city_name: "Falta la localidad o el barrio.",
  state_name: "Elegí la provincia.",
  coordinates: "La ubicación a mano tiene que verse como -34.6037, -58.3816.",
};

/** Error de la Edge mp_qr → mensaje en criollo + qué puede hacer el dueño. */
export function mapMpQrError(code: string, field?: string | null): MpQrError {
  switch (code) {
    case "geocode_not_found":
      return {
        title: "No encontramos la dirección en el mapa",
        message:
          "Revisá la calle, la altura y la localidad. Si está todo bien, podés marcar la ubicación a mano.",
        fix: "address",
      };
    case "geocode_unavailable":
      return {
        title: "No pudimos buscar la dirección ahora",
        message: "El buscador de mapas no respondió. Probá de nuevo en un rato.",
        fix: "retry",
      };
    case "invalid_store":
      return {
        title: "Revisá los datos del local",
        message: (field && FIELD_MSG[field]) || "Revisá el nombre y la dirección del local.",
        fix: "address",
        ...(field ? { field } : {}),
      };
    case "mp_store_error":
      if (field === "city_name") {
        return {
          title: "Mercado Pago no reconoce la localidad",
          message:
            "Probá con el nombre oficial de tu localidad o barrio (por ejemplo, Palermo en lugar de CABA).",
          fix: "address",
          field,
        };
      }
      if (field === "state_name") {
        return {
          title: "Mercado Pago no reconoce la provincia",
          message: "Elegí la provincia de la lista y probá de nuevo.",
          fix: "address",
          field,
        };
      }
      return {
        title: "Mercado Pago no aceptó la dirección",
        message: "Revisá la dirección del local y probá de nuevo.",
        fix: "address",
        ...(field && field !== "address" ? { field } : {}),
      };
    case "not_connected":
      return {
        title: "Tu cuenta de Mercado Pago no está conectada",
        message: "Volvé a conectarla y después activá el QR.",
        fix: "reconnect",
      };
    case "payment_method_not_allowed":
      return {
        title: "Tu plan no incluye Mercado Pago",
        message: "Mirá los planes para sumarlo.",
        fix: "plan",
      };
    case "forbidden":
      return {
        title: "Solo el dueño o el encargado puede hacerlo",
        message: "Pedile a quien administra el negocio que lo active.",
        fix: "none",
      };
    case "mp_pos_error":
    case "mp_error":
      return {
        title: "Mercado Pago no respondió",
        message: "Probá de nuevo en unos minutos.",
        fix: "retry",
      };
    default:
      return {
        title: "Algo salió mal",
        message: "Probá de nuevo en unos minutos.",
        fix: "retry",
      };
  }
}

/** Body de POST /users/{user_id}/stores. */
export function buildStoreBody(s: StoreSetup, storeExternalId: string) {
  return { name: s.name, external_id: storeExternalId, location: { ...s.location } };
}

/** Body de POST /v2/pos (caja para orders QR; external_id obligatorio para crear orders). */
export function buildPosBody(
  storeId: string,
  ids: { storeExternalId: string; posExternalId: string },
  name = "Caja NinjaPos",
) {
  return {
    name: name.slice(0, 60),
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
