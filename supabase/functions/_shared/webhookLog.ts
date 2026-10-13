// =============================================================================
// _shared/webhookLog.ts: observabilidad de los webhooks de cobro (ADR-070).
//
// withWebhookLog(provider, fn, handler) envuelve el handler de Deno.serve:
//   * mide la duración, toma el status HTTP de la respuesta y decide el
//     resultado: 'ok' (el handler llamó wh.done()), 'error' (wh.fail(), status
//     >= 500, 401/403 o excepción) o 'ignored' (2xx sin procesar nada);
//   * escribe una línea JSON en el log de Supabase ({"evt":"webhook",...});
//   * inserta una fila en webhook_events con service_role (sin payload, sólo
//     el id externo en payload_ref).
// La respuesta del webhook NO cambia: el registro corre en segundo plano
// (EdgeRuntime.waitUntil cuando existe) y cualquier error del registro se
// traga. Una excepción del handler se vuelve a lanzar igual que antes. Si el
// handler sigue trabajando en segundo plano (wh.defer), el registro espera a
// que termine.
// Las GET/HEAD/OPTIONS (páginas de retorno del navegador) no se registran.
// Las funciones puras (resolveWebhookStatus, buildWebhookEvent) se testean en
// tests/unit/webhookLog.test.ts.
// =============================================================================

export type WebhookStatus = "ok" | "error" | "ignored";

export interface WebhookEventRow {
  tenant_id: string | null;
  provider: string;
  function_name: string;
  status: WebhookStatus;
  http_status: number | null;
  error: string | null;
  duration_ms: number;
  payload_ref: string | null;
}

export interface WebhookCtx {
  /** Negocio al que pertenece la notificación (cuando se conoce). */
  tenant(id: string | null | undefined): void;
  /** Id externo de la notificación, pago u orden (nunca el payload). */
  ref(id: string | number | null | undefined): void;
  /** La notificación se procesó (se actualizó un cobro o similar). */
  done(): void;
  /** Hubo un error aunque la respuesta sea 200 (p. ej. catch que responde ok). */
  fail(err: unknown): void;
  /**
   * Trabajo que sigue en segundo plano después de responder: el registro
   * espera a que termine (si falla, queda 'error').
   */
  defer(work: Promise<unknown>): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 500;
const REF_MAX = 200;
const SKIP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function errorText(err: unknown): string | null {
  if (err == null) return null;
  let s: string;
  if (err instanceof Error) s = err.message || err.name;
  else if (typeof err === "string") s = err;
  else {
    try {
      s = JSON.stringify(err);
    } catch {
      s = String(err);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  // Tapa tokens tipo Bearer o access_token que pudieran venir en un mensaje.
  s = s.replace(/(bearer\s+)[\w.\-]+/gi, "$1***").replace(/(access_token=)[^&\s]+/gi, "$1***");
  if (!s) return null;
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX - 1) + "…" : s;
}

export function resolveWebhookStatus(input: {
  httpStatus: number | null;
  processed: boolean;
  failed: boolean;
}): WebhookStatus {
  const { httpStatus, processed, failed } = input;
  if (failed) return "error";
  if (httpStatus == null || httpStatus >= 500) return "error";
  if (httpStatus === 401 || httpStatus === 403) return "error";
  if (httpStatus >= 400) return "ignored";
  return processed ? "ok" : "ignored";
}

export function buildWebhookEvent(input: {
  provider: string;
  functionName: string;
  httpStatus: number | null;
  processed: boolean;
  error: unknown;
  durationMs: number;
  tenantId: string | null;
  payloadRef: string | number | null;
}): WebhookEventRow {
  const error = errorText(input.error);
  const ref = input.payloadRef == null ? null : String(input.payloadRef).trim();
  const tenant = input.tenantId && UUID_RE.test(input.tenantId) ? input.tenantId : null;
  return {
    tenant_id: tenant,
    provider: input.provider,
    function_name: input.functionName,
    status: resolveWebhookStatus({
      httpStatus: input.httpStatus,
      processed: input.processed,
      failed: error != null,
    }),
    http_status: input.httpStatus,
    error,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    payload_ref: ref ? ref.slice(0, REF_MAX) : null,
  };
}

// Inserta la fila con service_role vía PostgREST (sin cliente, sin
// dependencias). Nunca lanza.
export async function logWebhook(row: WebhookEventRow): Promise<void> {
  try {
    console.log(JSON.stringify({ evt: "webhook", ...row }));
  } catch {
    // nada
  }
  try {
    const env = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
    const url = env?.get("SUPABASE_URL");
    const key = env?.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const res = await fetch(`${url}/rest/v1/webhook_events`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ evt: "webhook_log_failed", status: res.status, fn: row.function_name }));
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: "webhook_log_failed", fn: row.function_name, error: errorText(e) }));
  }
}

function background(p: Promise<void>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?(p: Promise<unknown>): void } }).EdgeRuntime;
  if (rt?.waitUntil) {
    try {
      rt.waitUntil(p);
      return;
    } catch {
      // cae al fire-and-forget
    }
  }
  p.catch(() => {});
}

export function withWebhookLog(
  provider: string,
  functionName: string,
  handler: (req: Request, wh: WebhookCtx) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const t0 = performance.now();
    let tenantId: string | null = null;
    let ref: string | number | null = null;
    let processed = false;
    let failure: unknown = null;
    const deferred: Promise<unknown>[] = [];
    const wh: WebhookCtx = {
      tenant(id) {
        if (id) tenantId = id;
      },
      ref(id) {
        if (id != null && id !== "") ref = id;
      },
      done() {
        processed = true;
      },
      fail(err) {
        failure = err ?? "error";
      },
      defer(work) {
        deferred.push(work);
      },
    };
    const record = (httpStatus: number | null, err: unknown) => {
      if (SKIP_METHODS.has(req.method.toUpperCase())) return;
      const write = async () => {
        if (deferred.length > 0) {
          const results = await Promise.allSettled(deferred);
          const rejected = results.find((r) => r.status === "rejected");
          if (rejected && err == null && failure == null) err = (rejected as PromiseRejectedResult).reason;
          if (err == null && failure != null) err = failure;
        }
        const row = buildWebhookEvent({
          provider,
          functionName,
          httpStatus,
          processed,
          error: err,
          durationMs: performance.now() - t0,
          tenantId,
          payloadRef: ref,
        });
        await logWebhook(row);
      };
      try {
        background(write().catch(() => {}));
      } catch {
        // el registro nunca rompe el webhook
      }
    };
    let res: Response;
    try {
      res = await handler(req, wh);
    } catch (e) {
      record(null, e);
      throw e;
    }
    record(res.status, failure ?? (res.status >= 500 ? `http_${res.status}` : null));
    return res;
  };
}
