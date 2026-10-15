// Resultado de "Probar credenciales" de Getnet (Edge getnet, action probe ·
// ADR-065) y su lectura para el wizard de conexión. Sin secretos: la Edge sólo
// devuelve endpoint, HTTP y código o mensaje del proveedor.

export type GetnetProbeAttempt = {
  profile: string;
  api: "geopagos" | "global";
  env: "prod" | "test";
  label: string;
  step: string;
  endpoint: string;
  http_status: number;
  code: string | null;
  message: string | null;
  kind: string;
};

export type GetnetProbeResult = {
  ok: boolean;
  error?: string;
  /** Slot probado (ADR-069). */
  slot?: "web_checkout" | "checkout_api";
  /** La credencial parece del otro slot (Web Checkout vs Checkout API). */
  slot_mismatch?: boolean;
  environment?: "prod" | "test";
  profile?: string;
  api?: "geopagos" | "global" | "checkout_api";
  /** Checkout API: Seller ID y país del token, y si el checkout propio ya está habilitado. */
  seller_id?: string | null;
  country?: string | null;
  own_checkout_ready?: boolean;
  api_attempts?: { step: string; endpoint: string; http_status: number; code: string | null; message: string | null; kind: string }[];
  label?: string;
  mismatch?: string | null;
  summary?: string;
  seller?: { trade_name: string | null; country: string | null; checkout_enabled: boolean | null } | null;
  warnings?: string[];
  attempts?: GetnetProbeAttempt[];
  webhook_url?: string;
};

const KIND: Record<string, string> = {
  invalid_credentials: "credenciales rechazadas",
  forbidden: "producto no habilitado",
  endpoint_not_found: "servicio no encontrado",
  provider_down: "Getnet con problemas",
  network: "sin respuesta",
  unexpected: "respuesta inesperada",
};

/** Una línea por intento: "API · ambiente → HTTP 401 · código: mensaje (host/path)". */
export function probeAttemptLine(a: GetnetProbeAttempt): string {
  const http = a.http_status ? `HTTP ${a.http_status}` : "sin respuesta";
  const prov = [a.code, a.message].filter(Boolean).join(": ");
  return `${a.label}: ${KIND[a.kind] ?? a.kind} (${http}${prov ? ` · ${prov}` : ""}) en ${a.endpoint}`;
}

/** Ambiente al que habría que cambiar si las credenciales son del otro. */
export function probeMismatchEnv(r: GetnetProbeResult): "prod" | "test" | null {
  if (r.ok || !r.mismatch) return null;
  // Ualá Bis (ADR-143) informa el ambiente directo: "prod" o "test".
  return r.mismatch === "geopagos" || r.mismatch === "global_prod" || r.mismatch === "prod" ? "prod" : "test";
}

/** Secretos extra a guardar con la conexión cuando la prueba salió bien. */
export function probeSecrets(r: GetnetProbeResult | null, env: "prod" | "test"): Record<string, string> {
  if (r?.slot === "checkout_api") {
    // Checkout API: el Seller ID del token se guarda para el header x-seller-id.
    return r.ok && r.environment === env && r.seller_id ? { api_seller_id: r.seller_id } : {};
  }
  if (!r?.ok || !r.profile || r.environment !== env) return { environment: env };
  return { environment: env, api_profile: r.profile };
}

/** Una línea por intento de la Checkout API. */
export function probeApiAttemptLine(a: NonNullable<GetnetProbeResult["api_attempts"]>[number]): string {
  const http = a.http_status ? `HTTP ${a.http_status}` : "sin respuesta";
  const prov = [a.code, a.message].filter(Boolean).join(": ");
  return `Checkout API: ${KIND[a.kind] ?? a.kind} (${http}${prov ? ` · ${prov}` : ""}) en ${a.endpoint}`;
}
