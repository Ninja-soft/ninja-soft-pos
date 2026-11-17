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
// report; _shared/mpWebhookSignature.ts). La verificación va DESPUÉS de leer
// el intent y la credencial (para saber si el cobro es de la app de
// plataforma, OAuth) y ANTES de leer MP o escribir el estado: en enforce una
// firma mala responde 401 sin escribir nada. La defensa de fondo sigue siendo
// re-leer el pago / order en MP con el token del negocio.
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
import { decideMpSignature, readMpSignatureMode, readPlatformWebhookSecret } from "./mpWebhookSignature.ts";
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
  opts: { scopeStoreId: string | null; strict?: boolean; refreshTimeoutMs?: number },
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

/** SEC-60: firma rechazada en modo enforce (como mp_billing_webhook). */
const invalidSignature = () =>
  new Response(JSON.stringify({ error: "invalid_signature" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

/**
 * SEC-60: verifica `x-signature` según el modo global. `platformApp`: el aviso
 * lo firma la app de NinjaSoft (credencial OAuth o aviso de la app); si no,
 * no hay secreto guardado y nunca se corta. El motivo queda en webhook_events
 * con wh.note (sin datos sensibles). Cualquier excepción acá sigue de largo
 * (nunca corta un cobro por un error de la verificación).
 */
async function signatureGate(
  admin: WebhookDb,
  req: Request,
  wh: WebhookCtx,
  opts: { dataId: string | null; platformApp: boolean; nowMs?: () => number },
): Promise<"continue" | "reject"> {
  try {
    const now = opts.nowMs?.() ?? Date.now();
    const mode = await readMpSignatureMode(admin, now);
    if (mode === "off") return "continue";
    const secret = opts.platformApp ? await readPlatformWebhookSecret(admin, now) : null;
    const decision = await decideMpSignature({
      mode,
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
): Promise<CredentialStep> {
  const ms = deps.credentialTimeoutMs ?? MP_CREDENTIAL_TIMEOUT_MS;
  const chain = (async () => {
    const scopeStoreId = await deps.secretScope(admin, intentId, { strict: true });
    return deps.credential(admin, tenantId, env, {
      scopeStoreId,
      strict: true,
      refreshTimeoutMs: Math.min(MP_REFRESH_TIMEOUT_MS, ms),
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
): Promise<OrderStep> {
  const admin = deps.db();

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
  if (!row) return { kind: "skip" }; // order que no es nuestra (u otra integración de la cuenta).
  wh.tenant(row.tenant_id);
  if (row.status === "approved") return { kind: "skip" }; // ya acreditado: idempotente.

  // ADR-057: la credencial (negocio o sucursal) con la que se creó el cobro.
  const credStep = await webhookCredential(admin, deps, wh, row.tenant_id, row.mp_env ?? "prod", row.id);
  if (credStep.kind === "retry") return { kind: "retry" };
  if (credStep.kind === "none") return { kind: "skip" };
  const cred = credStep.cred;
  // SEC-60: firma antes de leer MP y de escribir el estado.
  const gate = await signatureGate(admin, req, wh, {
    dataId: sigDataId,
    platformApp: cred.oauth === true,
    nowMs: deps.nowMs,
  });
  if (gate === "reject") return { kind: "reject" };
  let got: Awaited<ReturnType<MpOrdersWebhookDeps["fetchOrder"]>>;
  try {
    got = await withMpTimeout(deps.timeoutMs ?? MP_READ_TIMEOUT_MS, (signal) =>
      deps.fetchOrder(cred.token, orderId, { signal }),
    );
  } catch (e) {
    deps.log.error("[mp_orders_webhook] no se pudo leer la order", { orderId, error: String(e).slice(0, 200) });
    wh.fail(e);
    return { kind: "retry" };
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
    const step = await readOrder(n.orderId, req, sigDataId, wh, deps);
    if (step.kind === "retry") return retryLater();
    if (step.kind === "reject") return invalidSignature();
    if (step.kind === "skip") return ok();

    // Sincrónico: si la escritura del estado falla, 503 y MP reintenta. La
    // auditoría va después del update; si falla sólo se loguea (el reintento
    // sale por "ya acreditado" y no la duplica).
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
          dataId: queryDataId || paymentId,
          platformApp: true,
          nowMs: deps.nowMs,
        });
        if (gate === "reject") return invalidSignature();
        await handleDisputeNotice(admin, deps, disputeKind, paymentId, mpUserId, hintPaymentId);
        wh.done();
      }
      return ok();
    }

    if (!intentId) return ok();
    if (topic && topic !== "payment") return ok(); // solo pagos
    if (!paymentId) return ok();

    const admin = deps.db();

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

    // ADR-057: verifica con la misma credencial (negocio o sucursal) con la
    // que se creó el cobro.
    const credStep = await webhookCredential(
      admin,
      deps,
      wh,
      intent.tenant_id,
      (intent.mp_env ?? "prod") as MpEnv,
      intentId,
    );
    if (credStep.kind === "retry") return retryLater();
    if (credStep.kind === "none") return ok();
    const cred = credStep.cred;
    const accessToken = cred.token;

    // SEC-60: firma antes de leer MP y de escribir el estado.
    const gate = await signatureGate(admin, req, wh, {
      dataId: queryDataId || paymentId,
      platformApp: cred.oauth === true,
      nowMs: deps.nowMs,
    });
    if (gate === "reject") return invalidSignature();

    type MpPayment = { status?: string; external_reference?: string; transaction_amount?: number };
    let read: { status: number; pay: MpPayment | null };
    try {
      // Lectura completa (respuesta + cuerpo) dentro del timeout.
      read = await withMpTimeout(deps.timeoutMs ?? MP_READ_TIMEOUT_MS, async (signal) => {
        const payRes = await deps.fetchMp(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal },
        );
        if (!payRes.ok) return { status: payRes.status, pay: null };
        return { status: payRes.status, pay: (await payRes.json()) as MpPayment };
      });
    } catch (e) {
      // Red caída, timeout o cuerpo ilegible: MP reintenta.
      wh.fail(e);
      return retryLater();
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
