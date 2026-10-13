// =============================================================================
// _shared/mercadolibre/client.ts (H87 · ADR-104). PURO (fetch inyectado).
//
// Cliente HTTP tipado de la API de Mercado Libre:
//   • Token siempre por header `Authorization: Bearer` (nunca en la query).
//   • 401 (token vencido o revocado): pide un token nuevo UNA vez y reintenta.
//   • 429 (`local_rate_limited` o límite del recurso): MlApiError retryable con
//     `retryAfterMs` (header Retry-After o backoff); el que llama decide
//     (el worker reprograma el trabajo, la UI muestra "probá en unos segundos").
//   • 5xx y errores de red: retryable. 4xx: no (salvo 409, que es de versión).
//   • Respuestas binarias (etiquetas PDF/ZPL) con `raw: true`.
//   • `gate(family)`: antes de cada llamada, el límite por cuenta y familia de
//     recurso (token bucket en la base, ml_rate_take) puede pedir esperar.
//
// Nada de Deno.* acá: lo importan las Edge y los tests de Vitest.
// =============================================================================
import { ML_API } from "./config.ts";
import type { MlErrorBody } from "./types.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type MlErrorCode =
  | "invalid_grant"
  | "unauthorized"
  | "forbidden"
  | "missing_permission"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "validation_error"
  | "bad_request"
  | "server_error"
  | "network"
  | "price_automation"
  | "operator_user";

export class MlApiError extends Error {
  constructor(
    readonly code: MlErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly causes: string[] = [],
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "MlApiError";
  }
}

/** Familias de recurso para el límite por cuenta (ver ml_rate_take). */
export type MlFamily = "default" | "items" | "stock" | "orders" | "shipments" | "labels" | "questions" | "invoices" | "oauth";

export function familyOf(path: string): MlFamily {
  if (path.includes("fiscal_documents")) return "invoices";
  if (path.startsWith("/user-products/") && path.includes("/stock")) return "stock";
  if (path.startsWith("/items") || path.startsWith("/user-products") || path.startsWith("/pictures")) return "items";
  if (path.startsWith("/orders") || path.startsWith("/packs/")) return "orders";
  if (path.startsWith("/shipment_labels")) return "labels";
  if (path.startsWith("/shipments") || path.startsWith("/v2/shipments")) return "shipments";
  if (path.startsWith("/questions") || path.startsWith("/answers")) return "questions";
  if (path.startsWith("/oauth")) return "oauth";
  return "default";
}

function causesOf(body: MlErrorBody | null): string[] {
  const out: string[] = [];
  for (const c of body?.cause ?? []) {
    if (typeof c === "string") out.push(c);
    else if (c && (c.code || c.message)) out.push([c.code, c.message].filter(Boolean).join(": "));
  }
  return out;
}

/** Retry-After en segundos o fecha HTTP → ms (null si no vino). */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, 15 * 60_000);
  const t = Date.parse(value);
  if (Number.isFinite(t)) return Math.max(0, Math.min(t - nowMs, 15 * 60_000));
  return null;
}

/** Clasifica una respuesta de error de ML. Puro (lo cubren los tests). */
export function classifyMlError(status: number, body: MlErrorBody | null, retryAfter: string | null = null): MlApiError {
  const err = String(body?.error ?? "").toLowerCase();
  const msg = String(body?.message ?? "");
  const causes = causesOf(body);
  const text = `${err} ${msg} ${causes.join(" ")}`.toLowerCase();
  if (err === "invalid_grant" || text.includes("invalid_grant")) {
    return new MlApiError("invalid_grant", "La conexión con Mercado Libre venció o fue revocada: hay que reconectar la cuenta.", status, false, null, causes, body);
  }
  if (text.includes("invalid_operator_user_id") || text.includes("operator")) {
    if (status === 400 || status === 403) {
      return new MlApiError("operator_user", "Sólo el usuario administrador de la cuenta de Mercado Libre puede conectarla (no un colaborador).", status, false, null, causes, body);
    }
  }
  if (status === 429 || err === "local_rate_limited" || text.includes("too_many_requests")) {
    return new MlApiError("rate_limited", "Mercado Libre pidió bajar el ritmo de llamadas: se reintenta solo.", status || 429, true, parseRetryAfter(retryAfter) ?? 10_000, causes, body);
  }
  if (status === 401) {
    return new MlApiError("unauthorized", "El token de Mercado Libre no es válido.", status, false, null, causes, body);
  }
  if (status === 403) {
    if (text.includes("pa_unauthorized_result_from_policies") || text.includes("policies")) {
      return new MlApiError("missing_permission", "A la app de Mercado Libre le falta un permiso funcional para esta acción (DevCenter > Permisos).", status, false, null, causes, body);
    }
    return new MlApiError("forbidden", "Mercado Libre no permite esta acción para la cuenta conectada.", status, false, null, causes, body);
  }
  if (status === 404) return new MlApiError("not_found", "Mercado Libre no encontró el recurso.", status, false, null, causes, body);
  if (status === 409) return new MlApiError("conflict", "El recurso cambió en Mercado Libre mientras se actualizaba (versión vieja).", status, true, 500, causes, body);
  if (status === 400 && text.includes("automat")) {
    return new MlApiError("price_automation", "La publicación tiene la automatización de precios de Mercado Libre activa: el precio lo maneja Mercado Libre.", status, false, null, causes, body);
  }
  if (status === 400 || status === 422) {
    const code: MlErrorCode = err.includes("validation") || causes.length > 0 ? "validation_error" : "bad_request";
    return new MlApiError(code, msg || "Mercado Libre rechazó los datos enviados.", status, false, null, causes, body);
  }
  if (status >= 500) return new MlApiError("server_error", "Mercado Libre no respondió bien; se reintenta.", status, true, null, causes, body);
  return new MlApiError("bad_request", msg || `Error ${status} de Mercado Libre`, status, false, null, causes, body);
}

/** Espera antes del intento n (1-based) con jitter ±20 %: 30 s, 1 min, 2 min... tope 30 min. */
export function jobBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(base * jitter);
}

export interface MlRequestOpts {
  body?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** false: sin Authorization (recursos públicos no; ML pide token en todo). */
  auth?: boolean;
  /** Devuelve el cuerpo como bytes (PDF, ZIP). */
  raw?: boolean;
}

export interface MlResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface MlClient {
  request<T = unknown>(method: string, path: string, opts?: MlRequestOpts): Promise<MlResponse<T>>;
  get<T = unknown>(path: string, query?: MlRequestOpts["query"], headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}

export interface MlClientDeps {
  fetch: FetchLike;
  /** Token vigente; `force` = el último fue rechazado (401), renovar ya. */
  getToken?: (force: boolean) => Promise<string>;
  /** Límite por cuenta/familia: resuelve cuando se puede llamar. */
  gate?: (family: MlFamily) => Promise<void>;
  base?: string;
}

function buildUrl(base: string, path: string, query?: MlRequestOpts["query"]): string {
  const u = new URL(path.startsWith("http") ? path : `${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export function createMlClient(deps: MlClientDeps): MlClient {
  const base = deps.base ?? ML_API;

  async function once<T>(method: string, path: string, opts: MlRequestOpts, force: boolean): Promise<MlResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.auth !== false && deps.getToken) headers.Authorization = `Bearer ${await deps.getToken(force)}`;
    let body: BodyInit | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.multipart) {
      body = opts.multipart;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    if (deps.gate) await deps.gate(familyOf(path));
    let res: Response;
    try {
      res = await deps.fetch(buildUrl(base, path, opts.query), { method, headers, body });
    } catch (e) {
      throw new MlApiError("network", `Sin respuesta de Mercado Libre: ${e instanceof Error ? e.message : String(e)}`, 0, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: MlErrorBody | null = null;
      try {
        parsed = text ? (JSON.parse(text) as MlErrorBody) : null;
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
      throw classifyMlError(res.status, parsed, res.headers.get("retry-after"));
    }
    if (opts.raw) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, data: buf as unknown as T, headers: res.headers };
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  async function request<T>(method: string, path: string, opts: MlRequestOpts = {}): Promise<MlResponse<T>> {
    try {
      return await once<T>(method, path, opts, false);
    } catch (e) {
      // Un solo reintento con token renovado ante 401.
      if (e instanceof MlApiError && e.code === "unauthorized" && opts.auth !== false && deps.getToken) {
        return await once<T>(method, path, opts, true);
      }
      throw e;
    }
  }

  return {
    request,
    get: async (path, query, headers) => (await request("GET", path, { query, headers })).data as never,
    post: async (path, body, headers) => (await request("POST", path, { body, headers })).data as never,
    put: async (path, body, headers) => (await request("PUT", path, { body, headers })).data as never,
  };
}
