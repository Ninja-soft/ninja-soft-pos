// =============================================================================
// _shared/mpWebhookHandlers.ts (OPS-23)
//
// Lógica de los webhooks de Mercado Pago, separada de Deno.serve para que la
// prueben los tests de Vitest (tests/unit/mpWebhooks.test.ts) con una base y
// una API de MP falsas:
//   * handleMpOrdersWebhook: topic `order` de la Orders API (mp_orders_webhook).
//   * handleMpWebhook: pagos de Checkout Pro con ?intent y avisos de
//     contracargos / reclamos (mp_webhook).
// Sin imports de URL ni Deno.*: todo lo que toca la red, la base o el entorno
// llega por `deps`. Cada index.ts arma las deps reales (createClient con
// service_role, fetch, tenantMpCredential, ...) y llama al handler dentro del
// mismo withWebhookLog. El comportamiento es el de antes de la extracción
// (mismos códigos, cuerpos, orden de validaciones, escrituras y logs), salvo
// PAY-27 (ADR-188):
//   * Ante cualquier duda de que el pago pudo quedar sin acreditar se responde
//     503 {ok:false, retry:true} para que MP reintente: lectura a MP que
//     rechaza / vence / 5xx / 429, 401 con credencial OAuth (token vencido),
//     error de base (intent, credencial, alcance, escritura del estado),
//     refresh OAuth fallido con el token vencido, o excepción no prevista.
//     Reintentar es seguro: la acreditación es idempotente.
//   * Un 4xx de MP que reintentar no arregla (404 pago inexistente, 400, 403,
//     401 con token estático) sigue en 200. Queda como error (wh.fail).
//   * Credencial y alcance en modo estricto (`strict: true`) con tope total
//     MP_CREDENTIAL_TIMEOUT_MS; lectura a MP con MP_READ_TIMEOUT_MS
//     (AbortController). Todo el trabajo es sincrónico (sin segundo plano).
// SEC-60 (ADR-189): `x-signature` se verifica según el modo global
// system_settings.mp_webhook_signature_mode (off | report | enforce, default
// report; _shared/mpWebhookSignature.ts). El modo se lee en paralelo con el
// intent (tope 2 s, cache 60 s). En enforce la firma se verifica ANTES de
// pedir la credencial (que puede refrescar el token OAuth y escribir
// payment_secrets): sólo se lee `via` de la fila del alcance, sin refresh.
// En report / off va después de la credencial (orden de siempre). Siempre
// antes de leer MP o escribir el estado: en enforce una firma mala responde
// 401 sin escribir nada. La defensa de fondo sigue siendo re-leer el pago /
// order en MP con el token del negocio.
// PAY-28 (ADR-191):
//   * 401 de MP con credencial OAuth: se fuerza UN refresh del token (aunque
//     expires_at diga vigente) dentro del presupuesto y se vuelve a leer; si
//     el refresh no da un token nuevo o MP vuelve a dar 401 → 503 como antes.
//   * Order que todavía no está en mp_payment_intents (mp_qr / mp_point
//     guardan mp_order_id DESPUÉS del POST a MP y el aviso puede llegar
//     antes): 503 para que MP reintente, sólo si el aviso tiene menos de
//     MP_ORDER_NOT_FOUND_WINDOW_MS (10 min). Hora del aviso: la MÁS VIEJA
//     entre `date_created` del cuerpo y `ts` de x-signature (ms o s). Sin
//     ninguna de las dos, o fuera de la ventana, 200 como siempre (órdenes de
//     otras integraciones de la cuenta no se reintentan para siempre).
//   * La escritura del estado + auditoría es atómica (RPC
//     _mp_intent_transition vía applyOrderToIntent).
// =============================================================================
import { amountsMatch, type MpEnv, type MpOrder, parseOrderNotification } from "./mpOrders.ts";
import {
  claimPaymentId,
  dedupeDisputes,
  type DisputeInput,
  mergeMpChargeback,
  mergeMpClaim,
  mpDisputesFromPayment,
  webhookTopicKind,
} from "./paymentDisputes.ts";
import { readJsonLimited } from "./requestGuard.ts";
import {
  decideMpSignature,
  type MpSignatureMode,
  readMpSignatureMode,
  readPlatformWebhookSecret,
} from "./mpWebhookSignature.ts";
import { loadProviderSecret } from "./paymentSecrets.ts";
import type { WebhookCtx } from "./webhookLog.ts";

// ---------------------------------------------------------------------------
// Puertos
// ---------------------------------------------------------------------------

export type DbResult = { data: unknown; error?: unknown };

/** Lo mínimo del query builder de supabase-js que usan los webhooks. */
export interface WebhookQuery extends PromiseLike<DbResult> {
  select(columns: string): WebhookQuery;
  update(values: Record<string, unknown>): WebhookQuery;
  eq(column: string, value: unknown): WebhookQuery;
  neq(column: string, value: unknown): WebhookQuery;
  limit(count: number): WebhookQuery;
  maybeSingle(): PromiseLike<DbResult>;
}

/** Cliente service_role (en la Edge, el de createClient). */
export interface WebhookDb {
  from(table: string): WebhookQuery;
}

/** `oauth`: credencial conectada por OAuth (un 401 puede ser token vencido). */
export type MpCredential = { token: string; oauth?: boolean } | null;

/** tenantMpCredential (_shared/mpAuth.ts). */
export type CredentialFn = (
  db: WebhookDb,
  tenantId: string,
  env: MpEnv,
  opts: {
    scopeStoreId: string | null;
    strict?: boolean;
    refreshTimeoutMs?: number;
    forceRefresh?: boolean;
    staleToken?: string;
  },
) => Promise<MpCredential>;

/** intentSecretScope (_shared/paymentSecrets.ts); `strict` lanza ante error de base. */
export type SecretScopeFn = (db: WebhookDb, intentId: string, opts?: { strict?: boolean }) => Promise<string | null>;

export type WebhookLogger = { error(message: string, data?: unknown): void };

/** Fila de mp_payment_intents que usa el topic order (ORDER_INTENT_COLUMNS). */
export interface OrdersIntentRow {
  id: string;
  tenant_id: string;
  status: string;
  mp_env: MpEnv | null;
}

export interface MpOrdersWebhookDeps {
  /** Crea el cliente service_role (se llama recién al procesar, como antes). */
  db: () => WebhookDb;
  /** ORDER_INTENT_COLUMNS de _shared/mpIntents.ts. */
  intentColumns: string;
  credential: CredentialFn;
  secretScope: SecretScopeFn;
  /** fetchOrder (_shared/mpIntents.ts): GET /v1/orders/{id} con el token del negocio. */
  fetchOrder: (
    token: string,
    orderId: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ ok: true; order: MpOrder } | { ok: false; status: number; detail: string }>;
  /** applyOrderToIntent (_shared/mpIntents.ts) con actor webhook; `strict` lanza si falla la escritura. */
  applyOrder: (
    db: WebhookDb,
    row: OrdersIntentRow,
    order: MpOrder,
    actor: { userId: null; source: "webhook" },
    opts: { strict: true },
  ) => Promise<unknown>;
  log: WebhookLogger;
  /** Timeout de la lectura a MP (default MP_READ_TIMEOUT_MS; los tests lo bajan). */
  timeoutMs?: number;
  /** Tope de la cadena de credencial (default MP_CREDENTIAL_TIMEOUT_MS). */
  credentialTimeoutMs?: number;
  /** SEC-60: reloj para la ventana anti-replay de la firma (los tests lo fijan). */
  nowMs?: () => number;
}

export interface MpDisputesPort {
  enabled(db: WebhookDb, tenantId: string): Promise<boolean>;
  fetchChargeback(token: string, id: string, caller: string | null): Promise<unknown | null>;
  fetchClaim(token: string, id: string): Promise<unknown | null>;
  fetchPayment(token: string, id: string): Promise<unknown | null>;
  save(db: WebhookDb, tenantId: string, scope: string | null, items: DisputeInput[], actor: string | null): Promise<unknown>;
}

export interface MpWebhookDeps {
  /** Crea el cliente service_role (se llama en cada rama que lo usa, como antes). */
  db: () => WebhookDb;
  credential: CredentialFn;
  secretScope: SecretScopeFn;
  /** fetch hacia api.mercadopago.com (GET /v1/payments/{id}). */
  fetchMp: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** disputesEnabled / fetchChargeback / fetchClaim / fetchPayment / saveDisputes (_shared/disputesSync.ts). */
  disputes: MpDisputesPort;
  log: WebhookLogger;
  /** Timeout de la lectura a MP (default MP_READ_TIMEOUT_MS; los tests lo bajan). */
  timeoutMs?: number;
  /** Tope de la cadena de credencial (default MP_CREDENTIAL_TIMEOUT_MS). */
  credentialTimeoutMs?: number;
  /** SEC-60: reloj para la ventana anti-replay de la firma (los tests lo fijan). */
  nowMs?: () => number;
}

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * PAY-27: falla transitoria (MP caído / lento / 429 o error de base). MP
 * reintenta las notificaciones que no reciben 2xx (con backoff), así que un
 * 503 no pierde el pago. withWebhookLog lo registra como 'error' (status >= 500).
 */
const retryLater = () =>
  new Response(JSON.stringify({ ok: false, retry: true }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });

/**
 * Presupuesto: MP corta la notificación a los 22 s y la reintenta (cabecera de
 * mp_orders_webhook/index.ts). Credencial (alcance + secreto + refresh OAuth)
 * hasta 6 s, lectura del pago / order hasta 8 s, y el resto son consultas
 * cortas a la base: ~14 s en el peor caso.
 */
export const MP_READ_TIMEOUT_MS = 8000;
export const MP_CREDENTIAL_TIMEOUT_MS = 6000;
/** Timeout del POST /oauth/token dentro del tope de la credencial. */
const MP_REFRESH_TIMEOUT_MS = 5000;
/**
 * PAY-28: presupuesto total del handler (MP corta a los 22 s). El refresh
 * forzado ante un 401 y la segunda lectura sólo corren con lo que quede.
 */
export const MP_WEBHOOK_BUDGET_MS = 20000;
/** PAY-28: lo mínimo que tiene que quedar para intentar el refresh forzado + relectura. */
const MP_FORCED_RETRY_MIN_MS = 1500;
/** PAY-28: ventana en la que una order desconocida responde 503 (MP reintenta). */
export const MP_ORDER_NOT_FOUND_WINDOW_MS = 10 * 60 * 1000;

/**
 * PAY-28: hora del aviso (ms) para la ventana de la order desconocida: la más
 * vieja entre `date_created` del cuerpo y `ts` de x-signature (ms, o s si
 * tiene menos de 13 dígitos). Se descartan valores ilegibles o más de 10 min
 * en el futuro. null si no hay ninguna.
 */
export function mpNoticeTimeMs(body: unknown, signature: string | null, nowMs: number): number | null {
  const out: number[] = [];
  const created = (body && typeof body === "object" ? (body as { date_created?: unknown }).date_created : null);
  if (typeof created === "string") {
    const t = Date.parse(created);
    if (Number.isFinite(t)) out.push(t);
  }
  const m = /(?:^|,)\s*ts=(\d{1,13})\s*(?:,|$)/i.exec(signature ?? "");
  if (m?.[1]) {
    const n = Number(m[1]);
    out.push(m[1].length >= 13 ? n : n * 1000);
  }
  const valid = out.filter((t) => t > 0 && t <= nowMs + MP_ORDER_NOT_FOUND_WINDOW_MS);
  return valid.length ? Math.min(...valid) : null;
}

/** SEC-60: firma rechazada en modo enforce (como mp_billing_webhook). */
const invalidSignature = () =>
  new Response(JSON.stringify({ error: "invalid_signature" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

type GateResult = "continue" | "reject" | "retry";

/**
 * SEC-60: verifica `x-signature` con el modo ya leído. `platformApp`: el aviso
 * lo firma la app de NinjaSoft (credencial OAuth o aviso de la app); si no,
 * no hay secreto guardado y nunca se corta. Error al leer el secreto: en
 * enforce "retry" (503, MP reintenta), en report nota y sigue. El motivo
 * queda en webhook_events con wh.note (sin datos sensibles). Una excepción
 * de la verificación sigue de largo (nunca corta un cobro por eso).
 */
async function signatureGate(
  admin: WebhookDb,
  req: Request,
  wh: WebhookCtx,
  opts: { mode: MpSignatureMode; dataId: string | null; platformApp: boolean; nowMs?: () => number },
): Promise<GateResult> {
  if (opts.mode === "off") return "continue";
  try {
    const now = opts.nowMs?.() ?? Date.now();
    let secret: string | null = null;
    if (opts.platformApp) {
      const got = await readPlatformWebhookSecret(admin, now);
      if (got.kind === "error") {
        wh.note("signature_secret_error");
        return opts.mode === "enforce" ? "retry" : "continue";
      }
      if (got.kind === "ok") secret = got.secret;
    }
    const decision = await decideMpSignature({
      mode: opts.mode,
      secret,
      signature: req.headers.get("x-signature"),
      requestId: req.headers.get("x-request-id"),
      dataId: opts.dataId,
      nowMs: now,
    });
    if (decision.reason) wh.note(decision.reason);
    return decision.action;
  } catch {
    wh.note("signature_check_failed");
    return "continue";
  }
}

/**
 * SEC-60, sólo enforce: ¿el cobro es de la app de plataforma (OAuth)? Lee el
 * alcance del intent y la fila de payment_secrets SIN refrescar el token (no
 * escribe nada), con el mismo tope que la credencial. Lanza ante error de
 * base o tope vencido (→ 503). Misma regla que tenantMpCredential: OAuth sólo
 * en producción con access_token.
 */
async function enforcePlatformApp(
  admin: WebhookDb,
  deps: { secretScope: SecretScopeFn; credentialTimeoutMs?: number },
  tenantId: string,
  env: MpEnv,
  intentId: string,
): Promise<boolean> {
  const ms = deps.credentialTimeoutMs ?? MP_CREDENTIAL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("La credencial de Mercado Pago", ms)), ms);
  });
  const work = (async () => {
    const scopeStoreId = await deps.secretScope(admin, intentId, { strict: true });
    const loaded = await loadProviderSecret(admin, tenantId, "mercadopago", { scopeStoreId, strict: true });
    const sec = (loaded?.secrets ?? {}) as { via?: unknown; access_token?: unknown };
    return env === "prod" && sec.via === "oauth" && typeof sec.access_token === "string" && sec.access_token !== "";
  })();
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** SEC-60: modo de la firma, leído en paralelo con el intent (nunca lanza). */
function startModeRead(admin: WebhookDb, nowMs?: () => number): Promise<MpSignatureMode> {
  return readMpSignatureMode(admin, nowMs?.() ?? Date.now()).catch(() => "report" as const);
}

/** 5xx o 429 de MP: reintentar más tarde puede funcionar. */
export function isRetryableMpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Corre `work` con un AbortSignal que se aborta a los `ms`. Además corre una
 * carrera contra el mismo plazo, así una dependencia que ignore el signal
 * tampoco deja la Edge colgada.
 */
class DeadlineError extends DOMException {
  constructor(what: string, ms: number) {
    super(`${what} no respondió en ${ms} ms`, "TimeoutError");
  }
}

async function withMpTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError("Mercado Pago", ms);
      ctrl.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work(ctrl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

type CredentialStep = { kind: "cred"; cred: NonNullable<MpCredential> } | { kind: "none" } | { kind: "retry" };

/**
 * Alcance del intent + credencial en modo estricto, con tope total. Un error
 * de base o un refresh OAuth fallido con el token vencido lanzan → retry.
 * Si vence el tope con un refresh en curso, la cadena NO se aborta: se pasa a
 * wh.defer, que la mantiene viva (EdgeRuntime.waitUntil del registro) hasta
 * que termine de guardar el token nuevo.
 */
async function webhookCredential(
  admin: WebhookDb,
  deps: { credential: CredentialFn; secretScope: SecretScopeFn; credentialTimeoutMs?: number },
  wh: WebhookCtx,
  tenantId: string,
  env: MpEnv,
  intentId: string,
  opts: { forceRefresh?: boolean; staleToken?: string; timeoutMs?: number } = {},
): Promise<CredentialStep> {
  const ms = opts.timeoutMs ?? deps.credentialTimeoutMs ?? MP_CREDENTIAL_TIMEOUT_MS;
  const chain = (async () => {
    const scopeStoreId = await deps.secretScope(admin, intentId, { strict: true });
    return deps.credential(admin, tenantId, env, {
      scopeStoreId,
      strict: true,
      refreshTimeoutMs: Math.min(MP_REFRESH_TIMEOUT_MS, ms),
      ...(opts.forceRefresh ? { forceRefresh: true, staleToken: opts.staleToken } : {}),
    });
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new DeadlineError("La credencial de Mercado Pago", ms));
    }, ms);
  });
  try {
    const cred = await Promise.race([chain, expired]);
    if (!cred) {
      wh.fail("sin credencial de Mercado Pago");
      return { kind: "none" };
    }
    return { kind: "cred", cred };
  } catch (e) {
    if (timedOut) wh.defer(chain.catch(() => null));
    wh.fail(e);
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

/** Respuesta de error de MP que conviene reintentar (5xx, 429, 401 con OAuth). */
function shouldRetryMpStatus(status: number, cred: NonNullable<MpCredential>): boolean {
  return isRetryableMpStatus(status) || (status === 401 && cred.oauth === true);
}

/** PAY-28: reloj del presupuesto total del handler. */
function budgetLeft(startedAt: number): number {
  return MP_WEBHOOK_BUDGET_MS - (Date.now() - startedAt);
}

type ForcedStep = { kind: "cred"; cred: NonNullable<MpCredential>; readMs: number } | { kind: "give_up" };

/**
 * PAY-28: 401 de MP con credencial OAuth. Fuerza UN refresh (aunque
 * `expires_at` diga vigente) con lo que quede del presupuesto. Sólo sigue si
 * el refresh dio un token distinto y queda tiempo para releer; si no, el
 * llamador responde 503 como antes. Un error / tope de la credencial forzada
 * también es give_up (queda en wh.fail).
 */
async function forceRefreshCredential(
  admin: WebhookDb,
  deps: { credential: CredentialFn; secretScope: SecretScopeFn; credentialTimeoutMs?: number; timeoutMs?: number },
  wh: WebhookCtx,
  ids: { tenantId: string; env: MpEnv; intentId: string },
  old: NonNullable<MpCredential>,
  startedAt: number,
): Promise<ForcedStep> {
  const left = budgetLeft(startedAt);
  if (left < MP_FORCED_RETRY_MIN_MS * 2) return { kind: "give_up" };
  const credMs = Math.min(deps.credentialTimeoutMs ?? MP_CREDENTIAL_TIMEOUT_MS, left - MP_FORCED_RETRY_MIN_MS);
  const step = await webhookCredential(admin, deps, wh, ids.tenantId, ids.env, ids.intentId, {
    forceRefresh: true,
    staleToken: old.token,
    timeoutMs: credMs,
  });
  if (step.kind !== "cred" || step.cred.token === old.token) return { kind: "give_up" };
  const leftToRead = budgetLeft(startedAt);
  if (leftToRead < MP_FORCED_RETRY_MIN_MS) return { kind: "give_up" };
  return { kind: "cred", cred: step.cred, readMs: Math.min(deps.timeoutMs ?? MP_READ_TIMEOUT_MS, leftToRead) };
}

// ---------------------------------------------------------------------------
// mp_orders_webhook — topic `order` de la Orders API (QR dinámico y Point).
// ---------------------------------------------------------------------------

type OrderStep =
  | { kind: "skip" }
  | { kind: "retry" }
  | { kind: "reject" }
  | { kind: "apply"; admin: WebhookDb; row: OrdersIntentRow; order: MpOrder };

/**
 * PAY-27 (opción a): busca el intent y RE-LEE la order en MP con timeout
 * antes de responder, así una falla transitoria vuelve como 503 y MP
 * reintenta. Después handleMpOrdersWebhook aplica la order, también
 * sincrónico.
 */
async function readOrder(
  orderId: string,
  req: Request,
  sigDataId: string,
  wh: WebhookCtx,
  deps: MpOrdersWebhookDeps,
  notice: { body: unknown; startedAt: number },
): Promise<OrderStep> {
  const admin = deps.db();
  const modeP = startModeRead(admin, deps.nowMs);

  const { data: rowRaw, error: rowErr } = await admin
    .from("mp_payment_intents")
    .select(deps.intentColumns)
    .eq("mp_order_id", orderId)
    .maybeSingle();
  if (rowErr) {
    wh.fail(rowErr); // base caída: no sabemos si la order es nuestra.
    return { kind: "retry" };
  }
  const row = rowRaw as OrdersIntentRow | null;
  if (!row) {
    // PAY-28: mp_qr / mp_point guardan mp_order_id DESPUÉS del POST a MP; un
    // aviso reciente puede llegar antes. Dentro de la ventana, 503 (MP
    // reintenta); fuera, o sin hora del aviso, es una order que no es nuestra
    // (u otra integración de la cuenta): 200 como siempre.
    const now = deps.nowMs?.() ?? Date.now();
    const at = mpNoticeTimeMs(notice.body, req.headers.get("x-signature"), now);
    if (at != null && now - at <= MP_ORDER_NOT_FOUND_WINDOW_MS) {
      wh.note("order_not_found_yet");
      return { kind: "retry" };
    }
    return { kind: "skip" };
  }
  wh.tenant(row.tenant_id);
  if (row.status === "approved") return { kind: "skip" }; // ya acreditado: idempotente.

  // SEC-60: en enforce, firma antes de la credencial (sin refresh OAuth).
  const mode = await modeP;
  const env = row.mp_env ?? "prod";
  if (mode === "enforce") {
    let platformApp: boolean;
    try {
      platformApp = await enforcePlatformApp(admin, deps, row.tenant_id, env, row.id);
    } catch (e) {
      wh.fail(e);
      return { kind: "retry" };
    }
    const gate = await signatureGate(admin, req, wh, { mode, dataId: sigDataId, platformApp, nowMs: deps.nowMs });
    if (gate === "reject") return { kind: "reject" };
    if (gate === "retry") return { kind: "retry" };
  }

  // ADR-057: la credencial (negocio o sucursal) con la que se creó el cobro.
  const credStep = await webhookCredential(admin, deps, wh, row.tenant_id, env, row.id);
  if (credStep.kind === "retry") return { kind: "retry" };
  if (credStep.kind === "none") return { kind: "skip" };
  const cred = credStep.cred;
  // SEC-60: report / off, después de la credencial y antes de leer MP (no corta).
  if (mode !== "enforce") {
    await signatureGate(admin, req, wh, { mode, dataId: sigDataId, platformApp: cred.oauth === true, nowMs: deps.nowMs });
  }
  type Got = Awaited<ReturnType<MpOrdersWebhookDeps["fetchOrder"]>>;
  const read = async (token: string, ms: number): Promise<Got | null> => {
    try {
      return await withMpTimeout(ms, (signal) => deps.fetchOrder(token, orderId, { signal }));
    } catch (e) {
      deps.log.error("[mp_orders_webhook] no se pudo leer la order", { orderId, error: String(e).slice(0, 200) });
      wh.fail(e);
      return null;
    }
  };
  let got = await read(cred.token, deps.timeoutMs ?? MP_READ_TIMEOUT_MS);
  if (!got) return { kind: "retry" };
  // PAY-28: 401 con OAuth → un refresh forzado y una relectura.
  if (!got.ok && got.status === 401 && cred.oauth === true) {
    const forced = await forceRefreshCredential(
      admin,
      deps,
      wh,
      { tenantId: row.tenant_id, env, intentId: row.id },
      cred,
      notice.startedAt,
    );
    if (forced.kind === "cred") {
      got = await read(forced.cred.token, forced.readMs);
      if (!got) return { kind: "retry" };
    }
  }
  if (!got.ok) {
    deps.log.error("[mp_orders_webhook] no se pudo leer la order", {
      orderId,
      status: got.status,
    });
    wh.fail(`no se pudo leer la order (${got.status})`);
    return shouldRetryMpStatus(got.status, cred) ? { kind: "retry" } : { kind: "skip" };
  }
  return { kind: "apply", admin, row, order: got.order };
}

export async function handleMpOrdersWebhook(
  req: Request,
  wh: WebhookCtx,
  deps: MpOrdersWebhookDeps,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const reqUrl = new URL(req.url);
    let body: unknown = null;
    if (req.method === "POST") {
      try {
        body = await readJsonLimited(req);
      } catch {
        body = null;
      }
    }
    const n = parseOrderNotification(reqUrl, body);
    if (n.type !== "order" || !n.orderId) return ok();
    wh.ref(n.orderId);

    // MP arma el manifest con el data.id de la query (si vino).
    const sigDataId = reqUrl.searchParams.get("data.id") || n.orderId;
    const step = await readOrder(n.orderId, req, sigDataId, wh, deps, { body, startedAt });
    if (step.kind === "retry") return retryLater();
    if (step.kind === "reject") return invalidSignature();
    if (step.kind === "skip") return ok();

    // Sincrónico: si la escritura del estado falla, 503 y MP reintenta.
    // PAY-28: estado + auditoría en una transacción (_mp_intent_transition):
    // un error no deja el intent acreditado sin su auditoría.
    await deps.applyOrder(step.admin, step.row, step.order, { userId: null, source: "webhook" }, { strict: true });
    wh.done();
    return ok();
  } catch (e) {
    // Error no previsto: ante la duda, que MP reintente (idempotente).
    wh.fail(e);
    return retryLater();
  }
}

// ---------------------------------------------------------------------------
// mp_webhook — pagos de Checkout Pro (?intent) y avisos de disputas (ADR-064).
// ---------------------------------------------------------------------------

/**
 * Aviso de contracargo (topic_chargebacks_wh) o reclamo
 * (topic_claims_integration_wh). El aviso sólo trae el id del caso y el
 * vendedor (user_id): se busca qué negocios tienen conectada esa cuenta de
 * Mercado Pago (payment_secrets.secrets.mp_user_id, conexión por OAuth), y
 * con la credencial de cada uno se vuelve a leer el caso y el pago. Si el
 * pago no es de esa cuenta, MP no lo devuelve y no se guarda nada.
 */
async function handleDisputeNotice(
  admin: WebhookDb,
  deps: MpWebhookDeps,
  kind: "chargeback" | "claim",
  caseId: string,
  mpUserId: string,
  hintPaymentId: string,
): Promise<void> {
  if (!/^\d{1,30}$/.test(mpUserId)) return;
  const { data: rows } = await admin
    .from("payment_secrets")
    .select("tenant_id, store_id")
    .eq("provider_key", "mercadopago")
    .eq("secrets->>mp_user_id", mpUserId)
    .limit(10);
  for (const row of (rows ?? []) as { tenant_id: string; store_id: string | null }[]) {
    try {
      if (!(await deps.disputes.enabled(admin, row.tenant_id))) continue;
      const cred = await deps.credential(admin, row.tenant_id, "prod", { scopeStoreId: row.store_id ?? null });
      if (!cred) continue;
      let items: DisputeInput[] = [];
      if (kind === "chargeback") {
        const cb = await deps.disputes.fetchChargeback(cred.token, caseId, mpUserId);
        if (!cb) continue;
        const ids = ((cb as { payments?: unknown[] }).payments ?? []).map(String).slice(0, 3);
        if (ids.length === 0 && hintPaymentId) ids.push(hintPaymentId);
        for (const pid of ids) {
          const pay = await deps.disputes.fetchPayment(cred.token, pid);
          if (!pay) continue; // no es un pago de esta cuenta
          const fromPay = mpDisputesFromPayment(pay);
          const current = fromPay.find((d) => d.kind === "chargeback") ?? null;
          const merged = mergeMpChargeback(current, cb, pid);
          items.push(...fromPay.filter((d) => d.kind !== "chargeback"), ...(merged ? [merged] : []));
        }
      } else {
        const claim = await deps.disputes.fetchClaim(cred.token, caseId);
        const pid = claimPaymentId(claim) ?? (hintPaymentId || null);
        if (!claim || !pid) continue;
        const pay = await deps.disputes.fetchPayment(cred.token, pid);
        if (!pay) continue;
        const fromPay = mpDisputesFromPayment(pay);
        const current = fromPay.find((d) => d.kind === "claim") ?? null;
        const merged = mergeMpClaim(current, claim, pay);
        items.push(...fromPay.filter((d) => d.kind !== "claim"), ...(merged ? [merged] : []));
      }
      items = dedupeDisputes(items);
      if (items.length > 0) await deps.disputes.save(admin, row.tenant_id, row.store_id ?? null, items, null);
    } catch (e) {
      deps.log.error("[mp_webhook] dispute_notice_failed", { tenant: row.tenant_id, kind, error: String(e).slice(0, 200) });
    }
  }
}

export const MP_PAYMENT_STATUS: Record<string, string> = {
  approved: "approved",
  authorized: "approved",
  rejected: "rejected",
  cancelled: "cancelled",
  refunded: "rejected",
  charged_back: "rejected",
  in_process: "pending",
  pending: "pending",
};

export async function handleMpWebhook(req: Request, wh: WebhookCtx, deps: MpWebhookDeps): Promise<Response> {
  const startedAt = Date.now();
  try {
    const reqUrl = new URL(req.url);
    const intentId = reqUrl.searchParams.get("intent");

    // Payment id desde query o body.
    let paymentId =
      reqUrl.searchParams.get("data.id") || reqUrl.searchParams.get("id") || "";
    let topic =
      reqUrl.searchParams.get("type") || reqUrl.searchParams.get("topic") || "";
    let mpUserId = reqUrl.searchParams.get("user_id") || "";
    // SEC-60: MP arma el manifest con el data.id de la query (si vino).
    const queryDataId = reqUrl.searchParams.get("data.id") || "";
    let hintPaymentId = "";
    if (req.method === "POST") {
      try {
        const body = (await readJsonLimited(req)) as {
          type?: string;
          topic?: string;
          user_id?: string | number;
          payment_id?: string | number;
          data?: { id?: string | number; payment_id?: string | number };
        };
        topic = body.type || body.topic || topic;
        paymentId = body.data?.id != null ? String(body.data.id) : paymentId;
        mpUserId = body.user_id != null ? String(body.user_id) : mpUserId;
        const hint = body.data?.payment_id ?? body.payment_id;
        hintPaymentId = hint != null ? String(hint) : "";
      } catch {
        // sin body JSON; seguimos con query.
      }
    }

    wh.ref(paymentId || intentId);

    // ADR-064: contracargos y reclamos (avisos de la aplicación, sin intent).
    const disputeKind = webhookTopicKind(topic);
    if (disputeKind) {
      if (paymentId && mpUserId) {
        const admin = deps.db();
        // SEC-60: aviso de la app de NinjaSoft (platform_secrets.webhook_secret).
        const gate = await signatureGate(admin, req, wh, {
          mode: await startModeRead(admin, deps.nowMs),
          dataId: queryDataId || paymentId,
          platformApp: true,
          nowMs: deps.nowMs,
        });
        if (gate === "reject") return invalidSignature();
        if (gate === "retry") return retryLater();
        await handleDisputeNotice(admin, deps, disputeKind, paymentId, mpUserId, hintPaymentId);
        wh.done();
      }
      return ok();
    }

    if (!intentId) return ok();
    if (topic && topic !== "payment") return ok(); // solo pagos
    if (!paymentId) return ok();

    const admin = deps.db();
    const modeP = startModeRead(admin, deps.nowMs);

    const { data: intentRaw, error: intentErr } = await admin
      .from("mp_payment_intents")
      .select("id, tenant_id, status, amount, mp_env")
      .eq("id", intentId)
      .maybeSingle();
    if (intentErr) {
      wh.fail(intentErr); // base caída: no es un intent desconocido, reintentar.
      return retryLater();
    }
    const intent = intentRaw as { tenant_id: string; amount: unknown; mp_env?: MpEnv | null } | null;
    if (!intent) return ok();
    wh.tenant(intent.tenant_id);

    const env = (intent.mp_env ?? "prod") as MpEnv;
    const sigDataId = queryDataId || paymentId;

    // SEC-60: en enforce, firma antes de la credencial (sin refresh OAuth).
    const mode = await modeP;
    if (mode === "enforce") {
      let platformApp: boolean;
      try {
        platformApp = await enforcePlatformApp(admin, deps, intent.tenant_id, env, intentId);
      } catch (e) {
        wh.fail(e);
        return retryLater();
      }
      const gate = await signatureGate(admin, req, wh, { mode, dataId: sigDataId, platformApp, nowMs: deps.nowMs });
      if (gate === "reject") return invalidSignature();
      if (gate === "retry") return retryLater();
    }

    // ADR-057: verifica con la misma credencial (negocio o sucursal) con la
    // que se creó el cobro.
    const credStep = await webhookCredential(admin, deps, wh, intent.tenant_id, env, intentId);
    if (credStep.kind === "retry") return retryLater();
    if (credStep.kind === "none") return ok();
    let cred = credStep.cred;

    // SEC-60: report / off, después de la credencial y antes de leer MP (no corta).
    if (mode !== "enforce") {
      await signatureGate(admin, req, wh, { mode, dataId: sigDataId, platformApp: cred.oauth === true, nowMs: deps.nowMs });
    }

    type MpPayment = { status?: string; external_reference?: string; transaction_amount?: number };
    type PayRead = { status: number; pay: MpPayment | null };
    const readPay = async (token: string, ms: number): Promise<PayRead | null> => {
      try {
        // Lectura completa (respuesta + cuerpo) dentro del timeout.
        return await withMpTimeout(ms, async (signal) => {
          const payRes = await deps.fetchMp(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            { headers: { Authorization: `Bearer ${token}` }, signal },
          );
          if (!payRes.ok) return { status: payRes.status, pay: null };
          return { status: payRes.status, pay: (await payRes.json()) as MpPayment };
        });
      } catch (e) {
        // Red caída, timeout o cuerpo ilegible: MP reintenta.
        wh.fail(e);
        return null;
      }
    };
    let read = await readPay(cred.token, deps.timeoutMs ?? MP_READ_TIMEOUT_MS);
    if (!read) return retryLater();
    // PAY-28: 401 con OAuth → un refresh forzado y una relectura.
    if (!read.pay && read.status === 401 && cred.oauth === true) {
      const forced = await forceRefreshCredential(
        admin,
        deps,
        wh,
        { tenantId: intent.tenant_id, env, intentId },
        cred,
        startedAt,
      );
      if (forced.kind === "cred") {
        cred = forced.cred;
        read = await readPay(cred.token, forced.readMs);
        if (!read) return retryLater();
      }
    }
    if (!read.pay) {
      wh.fail(`MP /v1/payments respondió ${read.status}`);
      // 5xx / 429 / 401 con OAuth: reintentar. Otros 4xx (pago inexistente,
      // token estático inválido): no sirve.
      return shouldRetryMpStatus(read.status, cred) ? retryLater() : ok();
    }
    const pay = read.pay;

    // Antifraude #1: el pago tiene que referenciar ESTE intent.
    if (pay.external_reference !== intentId) return ok();

    const status = MP_PAYMENT_STATUS[pay.status ?? ""] ?? "pending";

    // Antifraude #2: para acreditar, el monto pagado tiene que coincidir con el
    // esperado (tolerancia de centavos). Si difiere, NO acreditamos: dejamos el
    // intent en pending y logueamos (posible manipulación del precio).
    if (status === "approved") {
      const paid = Number(pay.transaction_amount ?? NaN);
      const expected = Number(intent.amount);
      if (!amountsMatch(paid, expected)) {
        deps.log.error("[mp_webhook] amount_mismatch, leaving pending (NOT crediting)", {
          intentId,
          paid,
          expected,
        });
        wh.fail("amount_mismatch");
        return ok();
      }
    }

    // Idempotente: .neq("status","approved") no pisa un cobro ya acreditado,
    // así que reintentar después de un 503 es seguro.
    const { error: updErr } = await admin
      .from("mp_payment_intents")
      .update({ status, mp_payment_id: String(paymentId) })
      .eq("id", intentId)
      .neq("status", "approved");
    if (updErr) {
      wh.fail(updErr);
      return retryLater();
    }

    wh.done();
    return ok();
  } catch (e) {
    // Error no previsto: ante la duda, que MP reintente (idempotente).
    wh.fail(e);
    return retryLater();
  }
}
