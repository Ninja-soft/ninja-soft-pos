// =============================================================================
// Edge Function: mp_point — cobro presencial con lectores Mercado Point sobre
// la Orders API unificada (ADR-032; antes Point Payment Intents API, ADR-027).
// Reutiliza la conexión Mercado Pago del tenant (payment_secrets
// provider_key='mercadopago'; OAuth con refresh o token manual; token de
// prueba con el switch Sandbox): NO pide credenciales nuevas.
//
// Actions (body.action):
//   * devices            → GET /terminals/v1/list (id, operating_mode).
//   * pdv    {device_id} → PATCH /terminals/v1/setup operating_mode PDV
//                          (necesario para empujarle cobros por API).
//   * create {device_id, amount, title?, installments?, default_type?}
//                        → intent local (provider_key 'mercadopago_point',
//                          mp_env) + POST /v1/orders type "point" con
//                          X-Idempotency-Key = intent.id. mp_order_id guarda
//                          la order; point_device_id, el lector.
//   * status {intent_id} → GET /v1/orders/{id} y sincroniza (approved sólo con
//                          pago processed + monto exacto; card_type
//                          debit/credit desde payment_method.type).
//   * cancel {intent_id} → POST /v1/orders/{id}/cancel con
//                          x-allow-cancelable-status: at_terminal. created →
//                          200 cancelada; at_terminal → 202 (cancelación
//                          pedida: el estado final llega por status/webhook,
//                          el POS sigue sondeando: si el cliente ya pagó, la
//                          venta se registra igual).
//
// Compatibilidad: los intents creados con la Payment Intents API (sin
// mp_order_id) siguen resolviendo status/cancel por el camino legacy.
//
// Gating real de plan: tenant_has_feature_for(tenant,'mercadopago_point') en
// create (la UI nunca es la única barrera). devices/pdv exigen owner/manager.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { MP_API, mpHeaders, tenantMpCredential } from "../_shared/mpAuth.ts";
import {
  applyOrderToIntent,
  fetchOrder,
  ORDER_INTENT_COLUMNS,
  type OrderIntentRow,
} from "../_shared/mpIntents.ts";
import {
  amountsMatch,
  buildPointOrderBody,
  cardTypeOf,
  isOrdersIntent,
  legacyPointStatus,
  mapTerminals,
  type MpOrder,
} from "../_shared/mpOrders.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

type PointRow = OrderIntentRow & {
  point_device_id: string | null;
  preference_id: string | null;
};

const cardTypeFromOrder = (order: MpOrder): "debit" | "credit" | null => {
  const paid = (order.transactions?.payments ?? []).find(
    (p) => String(p.status ?? "").toLowerCase() === "processed",
  );
  return paid ? cardTypeOf(paid.payment_method?.type) : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");
  if (!["devices", "pdv", "create", "status", "cancel"].includes(action)) {
    return json({ error: "invalid_action" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo del tenant (rol para las actions de configuración).
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  const canManage = mem.role === "owner" || mem.role === "manager";

  // ── devices: lista las terminales Point de la cuenta ───────────────────────
  if (action === "devices" || action === "pdv") {
    if (!canManage) return json({ error: "forbidden" }, 403);
    const cred = await tenantMpCredential(admin, tenantId);
    if (!cred) return json({ error: "not_connected" }, 400);

    if (action === "devices") {
      const r = await fetch(`${MP_API}/terminals/v1/list?limit=50`, {
        headers: mpHeaders(cred.token),
      });
      if (!r.ok) {
        return json({ error: "mp_error", detail: (await r.text()).slice(0, 300) }, 502);
      }
      return json({ devices: mapTerminals(await r.json()), env: cred.env });
    }

    // pdv: modo PDV (acepta cobros por API).
    const deviceId = String(b.device_id ?? "");
    if (!deviceId) return json({ error: "invalid_device" }, 400);
    const r = await fetch(`${MP_API}/terminals/v1/setup`, {
      method: "PATCH",
      headers: mpHeaders(cred.token),
      body: JSON.stringify({ terminals: [{ id: deviceId, operating_mode: "PDV" }] }),
    });
    if (!r.ok) {
      return json({ error: "mp_error", detail: (await r.text()).slice(0, 300) }, 502);
    }
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "tenant_payment_methods",
      entity_id: null,
      action: "mp_point_pdv_mode",
      after_data: { provider_key: "mercadopago_point", device_id: deviceId },
    });
    return json({ ok: true });
  }

  // ── create: intent local + order Point en el lector ────────────────────────
  if (action === "create") {
    // Gating de plan (enforcement real; la UI nunca es la única barrera).
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "mercadopago_point",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const deviceId = String(b.device_id ?? "");
    const amount = Number(b.amount);
    if (!deviceId) return json({ error: "invalid_device" }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const installments = Math.min(24, Math.max(1, Math.floor(Number(b.installments) || 1)));
    const defaultType =
      b.default_type === "debit_card" || b.default_type === "credit_card"
        ? b.default_type
        : undefined;

    const cred = await tenantMpCredential(admin, tenantId);
    if (!cred) return json({ error: "not_connected" }, 400);

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({
        tenant_id: tenantId,
        amount,
        provider_key: "mercadopago_point",
        point_device_id: deviceId,
        mp_env: cred.env,
      })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const r = await fetch(`${MP_API}/v1/orders`, {
      method: "POST",
      headers: mpHeaders(cred.token, intent.id),
      body: JSON.stringify(
        buildPointOrderBody({
          intentId: intent.id,
          amount,
          terminalId: deviceId,
          title: typeof b.title === "string" ? b.title : undefined,
          installments,
          defaultType,
        }),
      ),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
      // 409 típico: el lector no está en modo PDV o tiene un cobro abierto.
      // 400 missing_installments_cost / cuotas no habilitadas por MP.
      return json({ error: "mp_error", detail }, 502);
    }
    const order = (await r.json()) as { id?: string };
    if (!order.id) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intent.id);
      return json({ error: "mp_error", detail: "no_order_id" }, 502);
    }
    await admin.from("mp_payment_intents").update({ mp_order_id: order.id }).eq("id", intent.id);
    return json({ intent_id: intent.id, order_id: order.id });
  }

  // ── status / cancel: sobre un intent Point del tenant ──────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: rowRaw } = await admin
    .from("mp_payment_intents")
    .select(ORDER_INTENT_COLUMNS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago_point")
    .maybeSingle();
  const row = rowRaw as PointRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  // Ya resuelto: estado local (idempotente).
  if (row.status !== "pending") {
    return json({ status: row.status, mp_payment_id: row.mp_payment_id, card_type: null });
  }

  const cred = await tenantMpCredential(admin, tenantId, row.mp_env ?? "prod");
  if (!cred) return json({ error: "not_connected" }, 400);
  const h = mpHeaders(cred.token);

  // ── Orders API ──────────────────────────────────────────────────────────────
  if (isOrdersIntent(row)) {
    const orderId = row.mp_order_id!;
    let cancelRequested = false;
    if (action === "cancel") {
      const c = await fetch(`${MP_API}/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: "POST",
        headers: {
          ...mpHeaders(cred.token, `${row.id}-cancel`),
          "x-allow-cancelable-status": "at_terminal",
        },
      });
      // 202: la order estaba en el lector; la cancelación queda pedida.
      cancelRequested = c.status === 202;
      if (c.ok) {
        await admin.from("audit_logs").insert({
          tenant_id: tenantId,
          actor_user_id: user.id,
          entity_type: "mp_payment_intents",
          entity_id: row.id,
          action: "mp_order_cancelled",
          after_data: {
            provider_key: "mercadopago_point",
            mp_order_id: orderId,
            at_terminal: cancelRequested,
          },
        });
      }
    }

    const got = await fetchOrder(cred.token, orderId);
    if (!got.ok) return json({ error: "mp_error", detail: got.detail }, 502);
    const res = await applyOrderToIntent(admin, row, got.order, {
      userId: user.id,
      source: "poll",
    });
    const status = res.reason === "reference_mismatch" ? "pending" : res.status;
    return json({
      status,
      mp_payment_id: res.paymentId,
      card_type: status === "approved" ? (res.cardType ?? cardTypeFromOrder(got.order)) : null,
      state: String(got.order.status ?? ""),
      cancel_requested: cancelRequested,
    });
  }

  // ── Legacy: Point Payment Intents API (intents creados antes de ADR-032) ───
  if (action === "status") {
    const r = await fetch(
      `${MP_API}/point/integration-api/payment-intents/${row.preference_id}`,
      { headers: h },
    );
    if (!r.ok) {
      return json({ error: "mp_error", detail: (await r.text()).slice(0, 300) }, 502);
    }
    const pi = (await r.json()) as { state?: string; payment?: { id?: number | string } };
    const st = legacyPointStatus(String(pi.state ?? ""));

    if (st === "finished" && pi.payment?.id) {
      // Verificación independiente del pago antes de acreditar.
      const payRes = await fetch(`${MP_API}/v1/payments/${pi.payment.id}`, { headers: h });
      if (!payRes.ok) {
        return json({ error: "mp_error", detail: (await payRes.text()).slice(0, 300) }, 502);
      }
      const pay = (await payRes.json()) as {
        status?: string;
        transaction_amount?: number;
        payment_type_id?: string;
        payment_method?: { type?: string };
      };
      const paymentId = String(pi.payment.id);
      if (pay.status === "approved" && amountsMatch(pay.transaction_amount, row.amount)) {
        await admin
          .from("mp_payment_intents")
          .update({ status: "approved", mp_payment_id: paymentId })
          .eq("id", row.id)
          .neq("status", "approved");
        return json({
          status: "approved",
          mp_payment_id: paymentId,
          card_type: cardTypeOf(pay.payment_type_id ?? pay.payment_method?.type),
        });
      }
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected", mp_payment_id: paymentId })
        .eq("id", row.id)
        .eq("status", "pending");
      return json({ status: "rejected", mp_payment_id: paymentId, card_type: null });
    }

    if (st === "cancelled") {
      await admin
        .from("mp_payment_intents")
        .update({ status: "cancelled" })
        .eq("id", row.id)
        .eq("status", "pending");
      return json({ status: "cancelled", mp_payment_id: null, card_type: null });
    }
    return json({ status: "pending", mp_payment_id: null, card_type: null, state: pi.state });
  }

  // cancel legacy (best-effort: si el lector ya lo procesó, el DELETE falla).
  if (row.point_device_id && row.preference_id) {
    await fetch(
      `${MP_API}/point/integration-api/devices/${row.point_device_id}/payment-intents/${row.preference_id}`,
      { method: "DELETE", headers: h },
    ).catch(() => null);
  }
  await admin
    .from("mp_payment_intents")
    .update({ status: "cancelled" })
    .eq("id", row.id)
    .eq("status", "pending");
  return json({ status: "cancelled", mp_payment_id: null, card_type: null });
});
