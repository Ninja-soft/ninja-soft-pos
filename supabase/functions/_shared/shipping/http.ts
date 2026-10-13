// =============================================================================
// _shared/shipping/http.ts  (ADR-103)
//
// Llamadas HTTP de los adaptadores con tope de tiempo y clasificación de
// errores en CarrierError: qué se puede reintentar y qué queda "en duda"
// (una escritura que pudo haberse ejecutado). PURO (recibe el fetch).
// =============================================================================
import { CarrierError, type FetchLike } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** true si la operación escribe en el carrier (un timeout la deja en duda). */
export function isWrite(method: HttpCall["method"]): boolean {
  return method !== "GET";
}

export async function httpCall(fetchFn: FetchLike, call: HttpCall): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    // Una escritura sin respuesta puede haberse ejecutado: queda en duda.
    throw new CarrierError(aborted ? "timeout" : "network", aborted ? "La logística no respondió a tiempo." : "No se pudo conectar con la logística.", {
      retryable: !isWrite(call.method),
      uncertain: isWrite(call.method),
    });
  } finally {
    clearTimeout(t);
  }
}

/** Mensaje legible de un cuerpo de error JSON típico ({detail}, {message}, [{Message}]). */
export function errorMessageFrom(body: unknown, fallback: string): string {
  const pick = (o: Record<string, unknown>): string | null => {
    for (const k of ["detail", "Message", "message", "title", "error_description", "error"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  if (Array.isArray(body)) {
    const msgs = body
      .map((x) => (x && typeof x === "object" ? pick(x as Record<string, unknown>) : null))
      .filter((x): x is string => Boolean(x));
    if (msgs.length) return msgs.join(" · ").slice(0, 300);
  } else if (body && typeof body === "object") {
    const m = pick(body as Record<string, unknown>);
    if (m) return m.slice(0, 300);
  } else if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 300);
  }
  return fallback;
}

/** Respuesta no OK → CarrierError según el código HTTP y si era escritura. */
export async function errorFromResponse(res: Response, method: HttpCall["method"], what: string): Promise<CarrierError> {
  let body: unknown = null;
  try {
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch {
    body = null;
  }
  const msg = errorMessageFrom(body, `${what}: HTTP ${res.status}`);
  const s = res.status;
  if (s === 401 || s === 403) return new CarrierError("invalid_credentials", msg, { httpStatus: s });
  if (s === 404) return new CarrierError("not_found", msg, { httpStatus: s });
  if (s === 429) return new CarrierError("rate_limited", msg, { retryable: true, httpStatus: s });
  if (s >= 500) {
    return new CarrierError("carrier_unavailable", msg, {
      retryable: !isWrite(method),
      uncertain: isWrite(method),
      httpStatus: s,
    });
  }
  return new CarrierError("validation", msg, { httpStatus: s });
}

export function toBase64(s: string): string {
  // UTF-8 → binario → base64 (btoa existe en Deno y en Node 16+).
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
