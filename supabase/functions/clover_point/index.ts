// =============================================================================
// Edge Function: clover_point: cobro presencial con terminales Clover de Fiserv
// (Flex, Mini) por Cloud Pay Display (REST Pay Display API en la nube).
// ADR-047. Usa la conexión Fiserv del tenant (payment_secrets provider
// 'fiserv': merchant_id, access_token, refresh_token opcional y series de
// terminales opcionales); ambiente por tenant_payment_methods.sandbox de la
// fila 'fiserv'. En la terminal tiene que estar abierta la app Cloud Pay
// Display.
//
// Actions (body.action):
//   * devices                      → terminales del comercio [{id, label}]
//     (id = número de serie, que es lo que pide X-Clover-Device-Id).
//   * ping {device_id}             → ¿la terminal está conectada a la nube?
//   * create {device_id, amount, installments?} → intent local (provider_key
//     'fiserv_point', point_device_id = serie, mp_env = ambiente) y, en segundo
//     plano, POST /connect/v1/payments con Idempotency-Key = id del intent y
//     externalPaymentId = id del intent sin guiones. El monto que viaja a
//     Clover sale del intent guardado, en centavos. El POST bloquea hasta que
//     el cliente termina: por eso corre con EdgeRuntime.waitUntil y el POS
//     sondea `status`.
//   * status {intent_id}           → GET /connect/v1/payments/external/{ext}
//     (fuente de verdad): SUCCESS + monto exacto → approved (+ débito/crédito
//     por el tender del pago); FAIL → rejected; VOIDED → cancelled.
//   * cancel {intent_id}           → PUT /connect/v1/device/reset (corta lo
//     que está en curso en la terminal), re-consulta (si el cliente ya pagó,
//     gana el pago) y cancela local.
//
// Gating real: tenant_has_feature_for(tenant,'fiserv_point') Y
// tenant_has_feature_for(tenant,'fiserv') (la terminal integrada depende de la
// marca Fiserv) en create; sin conexión Fiserv → not_connected. La terminal
// recibida DEBE ser del comercio (Clover) o estar cargada en la conexión.
//
// Terminales (ADR-049): create acepta terminal_id (payment_terminals,
// validado en el servidor con terminal_for_user: negocio, activa, proveedor
// y sucursal del usuario; si viene store_id, esa sucursal). device_id sigue
// funcionando (POS viejos). Si la sucursal o la caja apagaron el medio
// (config_overrides) → payment_method_disabled_in_store.
// =============================================================================
import { buildPayRequest, cloverConnectBase, evaluateCloverPayment, intentEnvOf, isSafeCloverId, payErrorOutcome, toCents } from "../_shared/clover.ts";
import {
  INTENT_COLS,
  PROVIDER,
  applyEvaluation,
  audit,
  closePending,
  listDevices,
  loadCloverConnection,
  loadConnectionForIntent,
  syncIntent,
  type Admin,
  type CloverConnection,
  type IntentRow,
} from "../_shared/clover_server.ts";
import { authMember, cors, json } from "../_shared/nave_server.ts";
import { runInBackground } from "../_shared/mpAuth.ts";
import { locationOf, methodBlockedAt, resolveTerminal, touchTerminal } from "../_shared/terminals.ts";
import { bodyStoreId, insertIntentWithScope } from "../_shared/paymentSecrets.ts";

// La Edge corta el POST antes de su límite de reloj; la terminal sigue con el
// cobro y el poll lo resuelve por externalPaymentId.
const PAY_WAIT_MS = 140_000;

// Corre el POST de cobro y aplica la respuesta directa de Clover.
async function runPayment(admin: Admin, conn: CloverConnection, row: IntentRow, body: unknown) {
  let r: Response;
  try {
    r = await conn.request(`${cloverConnectBase(conn.env)}/v1/payments`, {
      method: "POST",
      deviceId: row.point_device_id,
      idempotencyKey: row.id,
      body,
      signal: AbortSignal.timeout(PAY_WAIT_MS),
    });
  } catch {
    // Timeout o red: indeterminado, decide el poll.
    return;
  }
  const payload = await r.json().catch(() => null);
  if (r.ok) {
    const ev = evaluateCloverPayment(payload, { intentId: row.id, amount: Number(row.amount) });
    await applyEvaluation(admin, row, ev, "pay");
    return;
  }
  const out = payErrorOutcome(r.status, payload);
  if (out.outcome === "pending") {
    await audit(admin, row, "clover_payment_indeterminate", { provider_key: PROVIDER, http_status: r.status, reason: out.reason });
    return;
  }
  await closePending(admin, row, out.outcome, out.reason, "pay");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ctx = await authMember(req);
  if (ctx instanceof Response) return ctx;
  const { admin, tenantId, userId } = ctx;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  // ── status / cancel: en el ambiente en el que se creó el intent ─────────────
  if (action === "status" || action === "cancel") {
    const intentId = String(b.intent_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(intentId)) return json({ error: "invalid_intent" }, 400);
    const { data } = await admin
      .from("mp_payment_intents")
      .select(INTENT_COLS)
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", PROVIDER)
      .maybeSingle();
    if (!data) return json({ error: "intent_not_found" }, 404);
    const row = data as IntentRow;
    const conn = await loadConnectionForIntent(admin, row);
    if (!conn) return json({ error: "not_connected" }, 400);

    if (action === "status") {
      try {
        const res = await syncIntent(admin, conn, row, "status");
        if ("error" in res) return json(res, 502);
        return json(res);
      } catch (e) {
        return json({ error: "clover_unreachable", detail: e instanceof Error ? e.message : "" }, 502);
      }
    }

    // cancel
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    let resetOk = false;
    if (isSafeCloverId(row.point_device_id)) {
      const r = await conn
        .request(`${cloverConnectBase(conn.env)}/v1/device/reset`, { method: "PUT", deviceId: row.point_device_id })
        .catch(() => null);
      resetOk = Boolean(r?.ok);
    }
    // Si el cliente ya pagó, gana el pago (nunca se pierde plata cobrada).
    const sync = await syncIntent(admin, conn, row, "cancel").catch(() => null);
    if (sync && "status" in sync && sync.status !== "pending") return json({ ok: true, status: sync.status });
    const status = await closePending(admin, row, "cancelled", resetOk ? "reset_on_device" : "cancelled_local", "cancel", userId);
    return json({ ok: true, status });
  }

  // ADR-057: conexión de la sucursal del POS (si tiene una propia).
  let conn = await loadCloverConnection(admin, tenantId, undefined, { storeId: bodyStoreId(b) });
  if (!conn) return json({ error: "not_connected" }, 400);

  // ── devices: terminales (sin secretos) ──────────────────────────────────────
  if (action === "devices") {
    const { devices, apiOk } = await listDevices(conn);
    return json({ devices, source: apiOk ? "clover" : "manual" });
  }

  const loc = locationOf(b);
  let deviceId = String(b.device_id ?? "");
  let terminalId: string | null = null;
  let storeId = loc.storeId;
  let registerId = loc.registerId;
  if (action === "create" && b.terminal_id !== undefined && b.terminal_id !== null) {
    const t = await resolveTerminal(admin, {
      tenantId,
      userId: userId,
      terminalId: b.terminal_id,
      providers: [PROVIDER],
      storeId: loc.storeId,
    });
    if (!t.ok) return json({ error: t.error }, 400);
    deviceId = t.terminal.external_id!;
    terminalId = t.terminal.id;
    storeId = t.terminal.store_id;
    registerId = registerId ?? t.terminal.cash_register_id;
    // La terminal manda: su sucursal define la conexión.
    if (storeId !== loc.storeId) {
      conn = await loadCloverConnection(admin, tenantId, undefined, { storeId });
      if (!conn) return json({ error: "not_connected" }, 400);
    }
  }
  if (!isSafeCloverId(deviceId)) return json({ error: "invalid_device" }, 400);

  // ── ping: ¿la terminal está conectada a la nube? ─────────────────────────────
  if (action === "ping") {
    const r = await conn
      .request(`${cloverConnectBase(conn.env)}/v1/device/ping`, { method: "POST", deviceId })
      .catch(() => null);
    const body = (await r?.json().catch(() => null)) as { connected?: boolean } | null;
    return json({ connected: Boolean(r?.ok && body?.connected) });
  }

  // ── create: intent local + cobro en la terminal (segundo plano) ─────────────
  if (action === "create") {
    for (const key of [PROVIDER, "fiserv"]) {
      const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: key });
      if (allowed !== true) return json({ error: "payment_method_not_allowed", feature: key }, 403);
    }

    if (await methodBlockedAt(admin, tenantId, PROVIDER, storeId, registerId)) {
      return json({ error: "payment_method_disabled_in_store" }, 403);
    }
    if (!terminalId) {
      const { devices } = await listDevices(conn);
      if (!devices.some((d) => d.id === deviceId)) {
        // Compatibilidad: id suelto, válido si está registrado como terminal del negocio.
        const { data: reg } = await admin
          .from("payment_terminals")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("provider_key", PROVIDER)
          .eq("external_id", deviceId)
          .eq("active", true)
          .is("deleted_at", null)
          .limit(1);
        if (!(reg as unknown[] | null)?.length) return json({ error: "invalid_device" }, 400);
      }
    }

    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (toCents(amount) === null) return json({ error: "invalid_amount" }, 400);
    const installments = b.installments === undefined || b.installments === null ? null : Number(b.installments);
    if (installments !== null && !(Number.isInteger(installments) && installments >= 1 && installments <= 99)) {
      return json({ error: "invalid_installments" }, 400);
    }

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      {
        tenant_id: tenantId,
        amount,
        provider_key: PROVIDER,
        point_device_id: deviceId,
        mp_env: intentEnvOf(conn.env),
        ...(terminalId ? { payment_terminal_id: terminalId } : {}),
      },
      conn.scopeStoreId,
      INTENT_COLS,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const row = intent as IntentRow;

    // El monto que viaja a Clover es el del intent guardado (no el del body).
    const amountCents = toCents(Number(row.amount));
    if (amountCents === null) return json({ error: "invalid_amount" }, 400);
    const body = buildPayRequest({ intentId: row.id, amountCents, installments });

    await audit(
      admin,
      row,
      "clover_payment_requested",
      { provider_key: PROVIDER, device: deviceId, amount_cents: amountCents, installments, env: conn.env },
      userId,
    );
    runInBackground(runPayment(admin, conn, row, body));
    await touchTerminal(admin, terminalId);
    return json({ intent_id: row.id });
  }

  return json({ error: "invalid_action" }, 400);
});
