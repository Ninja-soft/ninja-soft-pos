// OPS-23: webhooks de Mercado Pago (mp_webhook y mp_orders_webhook) con una
// base en memoria y la API de MP falsa. Los handlers viven en
// supabase/functions/_shared/mpWebhookHandlers.ts; las Edges sólo arman las
// dependencias reales.
//
// Las dependencias de la Edge (tenantMpCredential, intentSecretScope,
// fetchOrder, applyOrderToIntent, runInBackground) son las REALES: se cargan
// con import() dinámico porque mpAuth.ts y mpIntents.ts importan el tipo
// SupabaseClient desde esm.sh y tsc no resuelve URLs (en runtime ese import de
// tipo no existe). Sólo se falsean la base y la red (fetch).
//
// Los casos marcados `// DIFIERE DE LA TARJETA:` documentan el comportamiento
// actual cuando no coincide con lo que pedía OPS-23 (se decide aparte).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleMpOrdersWebhook,
  handleMpWebhook,
  type MpOrdersWebhookDeps,
  type MpWebhookDeps,
  type WebhookDb,
} from "@/supabase/functions/_shared/mpWebhookHandlers";
import type { WebhookCtx } from "@/supabase/functions/_shared/webhookLog";
import orderProcessed from "@/tests/fixtures/webhooks/mp/order-processed.json";
import orderRefunded from "@/tests/fixtures/webhooks/mp/order-refunded.json";
import orderExpired from "@/tests/fixtures/webhooks/mp/order-expired.json";
import paymentApproved from "@/tests/fixtures/webhooks/mp/payment-approved.json";
import paymentRejected from "@/tests/fixtures/webhooks/mp/payment-rejected.json";
import invalidSignature from "@/tests/fixtures/webhooks/mp/invalid-signature.json";
import signatureWithoutTs from "@/tests/fixtures/webhooks/mp/signature-without-ts.json";
import duplicateRedelivery from "@/tests/fixtures/webhooks/mp/duplicate-redelivery.json";

// ---------------------------------------------------------------------------
// Dependencias reales de las Edges (import dinámico: ver cabecera).
// ---------------------------------------------------------------------------
const SHARED = "../../supabase/functions/_shared/";
type AnyFn = (...args: never[]) => unknown;
let real: {
  tenantMpCredential: AnyFn;
  runInBackground: AnyFn;
  intentSecretScope: AnyFn;
  fetchOrder: AnyFn;
  applyOrderToIntent: AnyFn;
  ORDER_INTENT_COLUMNS: string;
};

const TENANT = "11111111-2222-4333-8444-555555555555";
const TOKEN = "APP_USR-1234567890-111111-abcdef0123456789abcdef0123456789-1234567890";

// ---------------------------------------------------------------------------
// Base en memoria con el subconjunto del query builder de supabase-js que
// usan los webhooks y sus helpers.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;
type Write = { table: string; op: "update" | "insert"; values: Row; affected: number };

function createFakeDb(seed: Record<string, Row[]>) {
  const tables: { mp_payment_intents: Row[]; payment_secrets: Row[]; audit_logs: Row[]; [table: string]: Row[] } = {
    mp_payment_intents: [],
    payment_secrets: [],
    audit_logs: [],
  };
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const writes: Write[] = [];

  const db = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Filter[] = [];
      let op: "select" | "update" | "insert" = "select";
      let values: Row = {};
      let limitN: number | null = null;

      const run = (): { data: unknown; error: null } => {
        if (op === "insert") {
          const list = Array.isArray(values) ? (values as Row[]) : [values];
          for (const v of list) rows.push({ ...v });
          writes.push({ table, op, values, affected: list.length });
          return { data: null, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, values);
          writes.push({ table, op, values, affected: hit.length });
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (limitN != null) hit = hit.slice(0, limitN);
        return { data: hit.map((r) => ({ ...r })), error: null };
      };

      const q = {
        select() {
          return q;
        },
        update(v: Row) {
          op = "update";
          values = v;
          return q;
        },
        insert(v: Row) {
          op = "insert";
          values = v;
          return q;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return q;
        },
        neq(col: string, val: unknown) {
          filters.push((r) => r[col] !== val);
          return q;
        },
        is(col: string, val: unknown) {
          filters.push((r) => (r[col] ?? null) === val);
          return q;
        },
        limit(n: number) {
          limitN = n;
          return q;
        },
        maybeSingle() {
          const res = run();
          const list = res.data as Row[];
          return Promise.resolve({ data: list[0] ?? null, error: null });
        },
        then<T1 = unknown, T2 = never>(
          ok?: ((v: { data: unknown; error: null }) => T1 | PromiseLike<T1>) | null,
          ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
        ) {
          return Promise.resolve().then(run).then(ok, ko);
        },
      };
      return q;
    },
  };
  return { db: db as unknown as WebhookDb, tables, writes };
}

// ---------------------------------------------------------------------------
// API de Mercado Pago falsa (fetch).
// ---------------------------------------------------------------------------
type MpRoute = { body?: unknown; status?: number; reject?: Error };

function createFakeMp(routes: Record<string, MpRoute>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchMp = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.Authorization ?? null });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    if (route.reject) throw route.reject;
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetchMp, calls };
}

// ---------------------------------------------------------------------------
// WebhookCtx que registra lo que el handler le avisa a withWebhookLog.
// ---------------------------------------------------------------------------
function createWh() {
  const state = {
    tenant: null as string | null,
    ref: null as string | number | null,
    done: false,
    failures: [] as unknown[],
    deferred: [] as Promise<unknown>[],
  };
  const wh: WebhookCtx = {
    tenant(id) {
      if (id) state.tenant = id;
    },
    ref(id) {
      if (id != null && id !== "") state.ref = id;
    },
    done() {
      state.done = true;
    },
    fail(err) {
      state.failures.push(err ?? "error");
    },
    defer(work) {
      state.deferred.push(work);
    },
  };
  return { wh, state };
}

type Delivery = { method: string; query: string; headers: Record<string, string>; body: unknown };

function toRequest(fn: "mp_webhook" | "mp_orders_webhook", d: Delivery): Request {
  const qs = d.query ? `?${d.query}` : "";
  return new Request(`https://example.supabase.co/functions/v1/${fn}${qs}`, {
    method: d.method,
    headers: d.headers,
    body: d.method === "POST" ? JSON.stringify(d.body) : undefined,
  });
}

function paymentIntentRow(intent: { id: string; amount: number }, extra: Row = {}): Row {
  return { id: intent.id, tenant_id: TENANT, status: "pending", amount: intent.amount, mp_env: "prod", ...extra };
}

function orderIntentRow(intent: { id: string; amount: number; mp_order_id: string }, extra: Row = {}): Row {
  return {
    id: intent.id,
    tenant_id: TENANT,
    status: "pending",
    amount: intent.amount,
    mp_order_id: intent.mp_order_id,
    mp_payment_id: null,
    mp_env: "prod",
    provider_key: "mercadopago_qr",
    point_device_id: null,
    preference_id: null,
    secret_store_id: null,
    ...extra,
  };
}

const SECRETS: Row = {
  id: "99999999-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  provider_key: "mercadopago",
  store_id: null,
  secrets: { access_token: TOKEN, via: "manual" },
};

function paymentDeps(db: WebhookDb, fetchMp: MpWebhookDeps["fetchMp"], log = { error: vi.fn() }) {
  const deps: MpWebhookDeps = {
    db: vi.fn(() => db),
    credential: real.tenantMpCredential as unknown as MpWebhookDeps["credential"],
    secretScope: real.intentSecretScope as unknown as MpWebhookDeps["secretScope"],
    fetchMp,
    disputes: {
      enabled: vi.fn(async () => false),
      fetchChargeback: vi.fn(async () => null),
      fetchClaim: vi.fn(async () => null),
      fetchPayment: vi.fn(async () => null),
      save: vi.fn(async () => ({})),
    },
    log,
  };
  return deps;
}

function ordersDeps(db: WebhookDb, log = { error: vi.fn() }) {
  const deps: MpOrdersWebhookDeps = {
    db: vi.fn(() => db),
    intentColumns: real.ORDER_INTENT_COLUMNS,
    credential: real.tenantMpCredential as unknown as MpOrdersWebhookDeps["credential"],
    secretScope: real.intentSecretScope as unknown as MpOrdersWebhookDeps["secretScope"],
    fetchOrder: real.fetchOrder as unknown as MpOrdersWebhookDeps["fetchOrder"],
    applyOrder: real.applyOrderToIntent as unknown as MpOrdersWebhookDeps["applyOrder"],
    runInBackground: real.runInBackground as unknown as MpOrdersWebhookDeps["runInBackground"],
    log,
  };
  return deps;
}

beforeEach(async () => {
  const mpAuth = await import(/* @vite-ignore */ `${SHARED}mpAuth.ts`);
  const paymentSecrets = await import(/* @vite-ignore */ `${SHARED}paymentSecrets.ts`);
  const mpIntents = await import(/* @vite-ignore */ `${SHARED}mpIntents.ts`);
  real = {
    tenantMpCredential: mpAuth.tenantMpCredential,
    runInBackground: mpAuth.runInBackground,
    intentSecretScope: paymentSecrets.intentSecretScope,
    fetchOrder: mpIntents.fetchOrder,
    applyOrderToIntent: mpIntents.applyOrderToIntent,
    ORDER_INTENT_COLUMNS: mpIntents.ORDER_INTENT_COLUMNS,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function bodyOf(res: Response) {
  return { status: res.status, type: res.headers.get("Content-Type"), body: await res.json() };
}

const OK_200 = { status: 200, type: "application/json", body: { ok: true } };

// ===========================================================================
// mp_webhook: pagos de Checkout Pro (?intent)
// ===========================================================================
describe("mp_webhook (handleMpWebhook)", () => {
  const intent = paymentApproved.intent;
  const payPath = `/v1/payments/${paymentApproved.mpResponse.id}`;

  it("payment approved con monto exacto: re-lee el pago con el token del negocio y acredita", async () => {
    const { db, tables, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { body: paymentApproved.mpResponse } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(mp.calls).toEqual([
      { url: `https://api.mercadopago.com${payPath}`, auth: `Bearer ${TOKEN}` },
    ]);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved", mp_payment_id: "91234567890" });
    expect(writes).toEqual([
      { table: "mp_payment_intents", op: "update", values: { status: "approved", mp_payment_id: "91234567890" }, affected: 1 },
    ]);
    expect(state).toMatchObject({ tenant: TENANT, ref: "91234567890", done: true, failures: [] });
  });

  it("payment rejected: deja el intent en rejected", async () => {
    const it2 = paymentRejected.intent;
    const { db, tables } = createFakeDb({ mp_payment_intents: [paymentIntentRow(it2)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [`/v1/payments/${paymentRejected.mpResponse.id}`]: { body: paymentRejected.mpResponse } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentRejected.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "rejected", mp_payment_id: "91234567999" });
    expect(state.done).toBe(true);
  });

  it("reentrega duplicada de approved: acredita una sola vez (el segundo update no toca filas)", async () => {
    const { db, tables, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { body: duplicateRedelivery.mpResponse } });

    const results = [];
    for (const d of duplicateRedelivery.deliveries) {
      const { wh } = createWh();
      results.push(await bodyOf(await handleMpWebhook(toRequest("mp_webhook", d), wh, paymentDeps(db, mp.fetchMp))));
    }

    expect(results).toEqual([OK_200, OK_200]);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved", mp_payment_id: "91234567890" });
    // Comportamiento real: la segunda entrega vuelve a leer el pago y emite el
    // update, pero el filtro .neq("status","approved") lo deja sin efecto.
    expect(writes.map((w) => w.affected)).toEqual([1, 0]);
    expect(mp.calls).toHaveLength(2);
  });

  it("monto que no coincide: error en el log, wh.fail y NO acredita", async () => {
    const { db, tables, writes } = createFakeDb({
      mp_payment_intents: [paymentIntentRow(intent, { amount: 15000 })],
      payment_secrets: [SECRETS],
    });
    const mp = createFakeMp({ [payPath]: { body: paymentApproved.mpResponse } });
    const log = { error: vi.fn() };
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp, log));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(log.error).toHaveBeenCalledWith("[mp_webhook] amount_mismatch, leaving pending (NOT crediting)", {
      intentId: intent.id,
      paid: 12000,
      expected: 15000,
    });
    expect(state.failures).toEqual(["amount_mismatch"]);
    expect(state.done).toBe(false);
    expect(writes).toEqual([]);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "pending" });
  });

  it("intent / tenant desconocido: 200 sin escribir ni llamar a MP (MP no reintenta)", async () => {
    const { db, writes } = createFakeDb({ mp_payment_intents: [], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { body: paymentApproved.mpResponse } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(writes).toEqual([]);
    expect(mp.calls).toEqual([]);
    expect(state).toMatchObject({ tenant: null, done: false, failures: [] });
  });

  it("timeout / error de red con MP (fetchMp rechaza): responde 200 y lo registra como error", async () => {
    const { db, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const mp = createFakeMp({ [payPath]: { reject: timeout } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    // DIFIERE DE LA TARJETA: la tarjeta pide 500 para que MP reintente. Hoy el
    // catch general responde 200 {ok:true} (MP no reintenta) y sólo queda
    // 'error' en webhook_events vía wh.fail.
    expect(await bodyOf(res)).toEqual(OK_200);
    expect(state.failures).toEqual([timeout]);
    expect(writes).toEqual([]);
  });

  it("MP responde 5xx en /v1/payments: 200, wh.fail con el status y sin escribir", async () => {
    const { db, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { status: 503, body: { message: "unavailable" } } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(state.failures).toEqual(["MP /v1/payments respondió 503"]);
    expect(writes).toEqual([]);
  });

  it("firma inválida: no se valida x-signature, el aviso se procesa igual", async () => {
    const { db, tables, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { body: invalidSignature.mpResponse } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", invalidSignature.request), wh, paymentDeps(db, mp.fetchMp));

    // DIFIERE DE LA TARJETA: la tarjeta pide 401 sin escribir nada. mp_webhook
    // no valida x-signature (sólo mp_billing_webhook lo hace): responde 200 y
    // acredita, porque la defensa es re-leer el pago en MP con el token del
    // negocio (external_reference + monto), no la firma.
    expect(await bodyOf(res)).toEqual(OK_200);
    expect(writes).toHaveLength(1);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved" });
    expect(state.done).toBe(true);
  });

  it("x-signature sin ts: el header se ignora y el aviso se procesa igual", async () => {
    const { db, tables } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({ [payPath]: { body: signatureWithoutTs.mpResponse } });
    const { wh } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", signatureWithoutTs.request), wh, paymentDeps(db, mp.fetchMp));

    // DIFIERE DE LA TARJETA: igual que la firma inválida, no hay validación.
    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved" });
  });

  it("pago con external_reference de otro intent: 200 sin escribir (antifraude #1)", async () => {
    const { db, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [SECRETS] });
    const mp = createFakeMp({
      [payPath]: { body: { ...paymentApproved.mpResponse, external_reference: "otro-intent" } },
    });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(writes).toEqual([]);
    expect(state).toMatchObject({ done: false, failures: [] });
  });

  it("negocio sin credencial de MP: 200 con wh.fail, sin llamar a MP", async () => {
    const { db, writes } = createFakeDb({ mp_payment_intents: [paymentIntentRow(intent)], payment_secrets: [] });
    const mp = createFakeMp({ [payPath]: { body: paymentApproved.mpResponse } });
    const { wh, state } = createWh();

    const res = await handleMpWebhook(toRequest("mp_webhook", paymentApproved.request), wh, paymentDeps(db, mp.fetchMp));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(state.failures).toEqual(["sin credencial de Mercado Pago"]);
    expect(mp.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("aviso sin ?intent o de otro topic: 200 sin abrir la base", async () => {
    const { db } = createFakeDb({});
    const mp = createFakeMp({});
    const deps = paymentDeps(db, mp.fetchMp);
    const noIntent = { ...paymentApproved.request, query: "data.id=91234567890&type=payment" };
    const otherTopic = { ...paymentApproved.request, body: { ...paymentApproved.request.body, type: "merchant_order" } };

    for (const d of [noIntent, otherTopic]) {
      const { wh } = createWh();
      expect(await bodyOf(await handleMpWebhook(toRequest("mp_webhook", d), wh, deps))).toEqual(OK_200);
    }
    expect(deps.db).not.toHaveBeenCalled();
    expect(mp.calls).toEqual([]);
  });
});

// ===========================================================================
// mp_orders_webhook: topic order de la Orders API
// ===========================================================================
describe("mp_orders_webhook (handleMpOrdersWebhook)", () => {
  function setup(fixture: typeof orderProcessed, route: MpRoute, rowExtra: Row = {}) {
    const fake = createFakeDb({
      mp_payment_intents: [orderIntentRow(fixture.intent, rowExtra)],
      payment_secrets: [SECRETS],
      audit_logs: [],
    });
    const mp = createFakeMp({ [`/v1/orders/${fixture.intent.mp_order_id}`]: route });
    vi.stubGlobal("fetch", mp.fetchMp);
    return { ...fake, mp };
  }

  it("order processed: acredita el intent y audita mp_order_approved", async () => {
    const { db, tables, mp } = setup(orderProcessed, { body: orderProcessed.mpResponse });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(mp.calls).toEqual([
      { url: `https://api.mercadopago.com/v1/orders/${orderProcessed.intent.mp_order_id}`, auth: `Bearer ${TOKEN}` },
    ]);
    expect(tables.mp_payment_intents[0]).toMatchObject({
      status: "approved",
      mp_payment_id: "PAY01JQ4S4KY8HWQ6NA5PXB65B3D4",
    });
    expect(tables.audit_logs).toHaveLength(1);
    expect(tables.audit_logs[0]).toMatchObject({
      tenant_id: TENANT,
      action: "mp_order_approved",
      entity_id: orderProcessed.intent.id,
      after_data: expect.objectContaining({ source: "webhook", previous_status: "pending", amount: 1500 }),
    });
    expect(state).toMatchObject({ tenant: TENANT, ref: orderProcessed.intent.mp_order_id, done: true, failures: [] });
    expect(state.deferred).toHaveLength(1);
  });

  it("reentrega de order processed ya acreditada: no vuelve a leer MP ni a auditar", async () => {
    const { db, tables, writes, mp } = setup(orderProcessed, { body: orderProcessed.mpResponse });

    for (let i = 0; i < 2; i++) {
      const { wh } = createWh();
      const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db));
      expect(await bodyOf(res)).toEqual(OK_200);
    }

    expect(mp.calls).toHaveLength(1);
    expect(tables.audit_logs).toHaveLength(1);
    expect(writes.filter((w) => w.table === "mp_payment_intents").map((w) => w.affected)).toEqual([1]);
  });

  it("order refunded: el intent pending pasa a rejected (sin auditoría)", async () => {
    const { db, tables } = setup(orderRefunded, { body: orderRefunded.mpResponse });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderRefunded.request), wh, ordersDeps(db));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "rejected", mp_payment_id: null });
    expect(tables.audit_logs).toEqual([]);
    expect(state.done).toBe(true);
  });

  it("order refunded sobre un intent ya approved: no lo toca (sale por idempotencia)", async () => {
    const { db, tables, mp } = setup(orderRefunded, { body: orderRefunded.mpResponse }, { status: "approved" });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderRefunded.request), wh, ordersDeps(db));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved" });
    expect(mp.calls).toEqual([]);
    expect(state).toMatchObject({ tenant: TENANT, done: false });
  });

  it("order expired: el intent pending pasa a expired", async () => {
    const { db, tables } = setup(orderExpired, { body: orderExpired.mpResponse });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderExpired.request), wh, ordersDeps(db));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "expired" });
    expect(state.done).toBe(true);
  });

  it("order processed con monto distinto: rejected + audit mp_order_amount_mismatch, no acredita", async () => {
    const { db, tables } = setup(orderProcessed, { body: orderProcessed.mpResponse }, { amount: 1499.99 });
    const { wh } = createWh();

    await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db));

    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "rejected" });
    expect(tables.audit_logs).toHaveLength(1);
    expect(tables.audit_logs[0]).toMatchObject({ action: "mp_order_amount_mismatch" });
    expect(console.error).toHaveBeenCalledWith("[mp_orders] amount_mismatch, NO se acredita", expect.anything());
  });

  it("order desconocida (otro negocio / otra integración): 200 sin escribir ni llamar a MP", async () => {
    const { db, writes, mp } = setup(orderProcessed, { body: orderProcessed.mpResponse }, { mp_order_id: "ORD-OTRA" });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(writes).toEqual([]);
    expect(mp.calls).toEqual([]);
    expect(state).toMatchObject({ tenant: null, done: false, failures: [] });
  });

  it("timeout / error de red con MP al leer la order: 200 y el trabajo diferido queda rechazado", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { db, writes } = setup(orderProcessed, { reject: timeout });
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db));

    // DIFIERE DE LA TARJETA: la tarjeta pide 500 para que MP reintente. Hoy
    // responde 200 {ok:true}; runInBackground se traga el error y
    // withWebhookLog lo registra como 'error' por el wh.defer rechazado.
    expect(await bodyOf(res)).toEqual(OK_200);
    await expect(state.deferred[0]).rejects.toBe(timeout);
    expect(state.done).toBe(false);
    expect(writes).toEqual([]);
  });

  it("MP responde 404 al leer la order: log + wh.fail, sin escribir", async () => {
    const { db, writes } = setup(orderProcessed, { status: 404, body: { message: "order not found" } });
    const log = { error: vi.fn() };
    const { wh, state } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", orderProcessed.request), wh, ordersDeps(db, log));

    expect(await bodyOf(res)).toEqual(OK_200);
    expect(log.error).toHaveBeenCalledWith("[mp_orders_webhook] no se pudo leer la order", {
      orderId: orderProcessed.intent.mp_order_id,
      status: 404,
    });
    expect(state.failures).toEqual(["no se pudo leer la order (404)"]);
    expect(writes).toEqual([]);
  });

  it("firma inválida o sin ts en una order: tampoco se valida", async () => {
    const { db, tables } = setup(orderProcessed, { body: orderProcessed.mpResponse });
    const req = {
      ...orderProcessed.request,
      headers: { ...orderProcessed.request.headers, "x-signature": signatureWithoutTs.request.headers["x-signature"] },
    };
    const { wh } = createWh();

    const res = await handleMpOrdersWebhook(toRequest("mp_orders_webhook", req), wh, ordersDeps(db));

    // DIFIERE DE LA TARJETA: sin validación de x-signature (ver mp_webhook).
    expect(await bodyOf(res)).toEqual(OK_200);
    expect(tables.mp_payment_intents[0]).toMatchObject({ status: "approved" });
  });

  it("aviso que no es topic order o sin data.id válido: 200 sin abrir la base", async () => {
    const { db } = createFakeDb({});
    const deps = ordersDeps(db);
    const notOrder = { ...orderProcessed.request, body: { ...orderProcessed.request.body, type: "payment" } };
    const badId = {
      ...orderProcessed.request,
      body: { ...orderProcessed.request.body, data: { ...orderProcessed.request.body.data, id: "../../x" } },
    };

    for (const d of [notOrder, badId]) {
      const { wh, state } = createWh();
      expect(await bodyOf(await handleMpOrdersWebhook(toRequest("mp_orders_webhook", d), wh, deps))).toEqual(OK_200);
      expect(state.ref).toBeNull();
    }
    expect(deps.db).not.toHaveBeenCalled();
  });
});
