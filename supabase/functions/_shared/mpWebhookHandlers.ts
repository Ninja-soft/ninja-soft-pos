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
//   * Si no se pudo leer el pago / la order en MP por una falla transitoria
//     (fetch rechaza, timeout, 5xx o 429) o falla la base, se responde 503
//     {ok:false, retry:true} para que MP reintente. Reintentar es seguro: la
//     acreditación es idempotente (sólo transiciona desde pending).
//   * Un 4xx de MP (404 pago inexistente, 401/403 credencial) sigue en 200:
//     reintentar no lo arregla. Queda como error en webhook_events (wh.fail).
//   * Toda lectura a MP tiene timeout (MP_READ_TIMEOUT_MS, AbortController).
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

export type MpCredential = { token: string } | null;

/** tenantMpCredential (_shared/mpAuth.ts). */
export type CredentialFn = (
  db: WebhookDb,
  tenantId: string,
  env: MpEnv,
  opts: { scopeStoreId: string | null },
) => Promise<MpCredential>;

/** intentSecretScope (_shared/paymentSecrets.ts). */
export type SecretScopeFn = (db: WebhookDb, intentId: string) => Promise<string | null>;

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
  /** applyOrderToIntent (_shared/mpIntents.ts) con actor webhook. */
  applyOrder: (
    db: WebhookDb,
    row: OrdersIntentRow,
    order: MpOrder,
    actor: { userId: null; source: "webhook" },
  ) => Promise<unknown>;
  /** runInBackground (_shared/mpAuth.ts). */
  runInBackground: (work: Promise<unknown>) => Promise<unknown> | null;
  log: WebhookLogger;
  /** Timeout de la lectura a MP (default MP_READ_TIMEOUT_MS; los tests lo bajan). */
  timeoutMs?: number;
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
 * Timeout de cada lectura a MP. MP corta la notificación a los 22 s y la
 * reintenta (cabecera de mp_orders_webhook/index.ts): 8 s de lectura más las
 * consultas a la base dejan margen de sobra para responder dentro del límite.
 */
export const MP_READ_TIMEOUT_MS = 8000;

/** 5xx o 429 de MP: reintentar más tarde puede funcionar. */
export function isRetryableMpStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Corre `work` con un AbortSignal que se aborta a los `ms`. Además corre una
 * carrera contra el mismo plazo, así una dependencia que ignore el signal
 * tampoco deja la Edge colgada.
 */
async function withMpTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DOMException(`Mercado Pago no respondió en ${ms} ms`, "TimeoutError");
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

// ---------------------------------------------------------------------------
// mp_orders_webhook — topic `order` de la Orders API (QR dinámico y Point).
// ---------------------------------------------------------------------------

type OrderStep =
  | { kind: "skip" }
  | { kind: "retry" }
  | { kind: "apply"; admin: WebhookDb; row: OrdersIntentRow; order: MpOrder };

/**
 * Parte sincrónica (PAY-27, opción a): busca el intent y RE-LEE la order en
 * MP con timeout antes de responder, así una falla transitoria vuelve como
 * 503 y MP reintenta. Sólo applyOrder (escrituras locales) queda en segundo
 * plano.
 */
async function readOrder(orderId: string, wh: WebhookCtx, deps: MpOrdersWebhookDeps): Promise<OrderStep> {
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
  const cred = await deps.credential(admin, row.tenant_id, row.mp_env ?? "prod", {
    scopeStoreId: await deps.secretScope(admin, row.id),
  });
  if (!cred) {
    wh.fail("sin credencial de Mercado Pago");
    return { kind: "skip" };
  }
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
    return isRetryableMpStatus(got.status) ? { kind: "retry" } : { kind: "skip" };
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

    const step = await readOrder(n.orderId, wh, deps);
    if (step.kind === "retry") return retryLater();
    if (step.kind === "skip") return ok();

    const work = (async () => {
      await deps.applyOrder(step.admin, step.row, step.order, { userId: null, source: "webhook" });
      wh.done();
    })();
    wh.defer(work);
    const pending = deps.runInBackground(work);
    if (pending) await pending;
    return ok();
  } catch (e) {
    wh.fail(e);
    return ok();
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
    const cred = await deps.credential(
      admin,
      intent.tenant_id,
      (intent.mp_env ?? "prod") as MpEnv,
      { scopeStoreId: await deps.secretScope(admin, intentId) },
    );
    if (!cred) {
      wh.fail("sin credencial de Mercado Pago");
      return ok();
    }
    const accessToken = cred.token;

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
      // 5xx / 429: reintentar. 4xx (pago inexistente, credencial): no sirve.
      return isRetryableMpStatus(read.status) ? retryLater() : ok();
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
    wh.fail(e);
    return ok();
  }
}
