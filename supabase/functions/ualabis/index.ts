// =============================================================================
// Edge Function: ualabis · Ualá Bis por link de pago + QR (F8 · ADR-143).
// API Cobros Online v2 (developers.ualabis.com.ar): token por username +
// client_id + client_secret_id del comercio y orden con checkout hosted de
// Ualá (tarjeta de crédito, débito o prepaga, con cuotas).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='ualabis', mp_env por el switch Sandbox = stage) + orden
//     POST /checkout con external_reference = intent.id y notification_url por
//     intent (dominio de hooks). El checkout_link es el init_point que el POS
//     muestra como QR y link. El uuid de la orden queda en preference_id.
//   * status {intent_id} → re-consulta la orden y sincroniza (respaldo del
//     webhook): PROCESSED o APPROVED + referencia propia + monto exacto →
//     approved · REJECTED → rejected.
//   * cancel {intent_id} → baja local del intent (la API no anula órdenes sin
//     pagar). Si el cliente igual paga, el webhook lo registra como approved y
//     queda en la conciliación.
//   * probe {username?, client_id?, client_secret_id?, environment?,
//     store_id?} → "Probar conexión": pide un token (dueño o encargado). Sin
//     credenciales tipeadas prueba las guardadas. No guarda nada.
//   * refund {intent_id} → devolución TOTAL de un cobro aprobado (dueño o
//     encargado) que no tiene una venta vigente (la venta se anula primero).
//     Fila en ualabis_refunds (una devolución viva por cobro) + POST
//     /orders/{uuid}/refund. El resultado final llega por ualabis_webhook.
//
// Gating real: tenant_has_feature_for(tenant,'ualabis') en create y refund (y
// el trigger de payments vía payment_method_plan_key('ualabis')).
// Credencial: payment_secrets provider 'ualabis' (set_payment_secret). Nunca
// sale del servidor ni se loguea.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  classifyRefundResponse,
  isAuthFailure,
  orderAmount,
  parseCreds,
  ualabisClient,
  UUID_RE,
  type UalaEnv,
} from "../_shared/ualabis.ts";
import {
  INTENT_COLS,
  clientFor,
  envOfIntent,
  hooksBase,
  intentEnvValue,
  loadCredsScoped,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/ualabis_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, isScopeUuid } from "../_shared/paymentSecrets.ts";

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

const envLabel = (e: UalaEnv) => (e === "stage" ? "Prueba" : "Producción");

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
  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);
  const isManager = ["owner", "manager"].includes(String((mem as { role?: string }).role));

  // ── probe ("Probar conexión") ──────────────────────────────────────────────
  if (action === "probe") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const typed = parseCreds({
      username: b.username,
      client_id: b.client_id,
      client_secret_id: b.client_secret_id,
    });
    const storeId = isScopeUuid(b.store_id) ? b.store_id : null;
    const creds =
      typed ?? (await loadCredsScoped(admin, tenantId, { scopeStoreId: storeId }))?.creds ?? null;
    if (!creds) return json({ ok: false, error: "not_connected" });
    const env: UalaEnv =
      b.environment === "test" ? "stage" : b.environment === "prod" ? "prod" : await loadEnv(admin, tenantId);
    const r = await ualabisClient({ creds, env }).token(true);
    if (r.ok) {
      return json({
        ok: true,
        environment: env === "stage" ? "test" : "prod",
        label: `${envLabel(env)}: Ualá Bis aceptó las credenciales`,
      });
    }
    // ¿Son del otro ambiente? Se prueba el otro sin guardar nada.
    const other: UalaEnv = env === "stage" ? "prod" : "stage";
    const alt = isAuthFailure(r.httpStatus) ? await ualabisClient({ creds, env: other }).token(true) : null;
    return json({
      ok: false,
      environment: env === "stage" ? "test" : "prod",
      mismatch: alt?.ok ? (other === "stage" ? "test" : "prod") : null,
      summary: alt?.ok
        ? `Estas credenciales son de ${envLabel(other).toLowerCase()}, no de ${envLabel(env).toLowerCase()}.`
        : isAuthFailure(r.httpStatus)
          ? "Ualá Bis rechazó el usuario, el Client ID o el Client Secret. Copialos de nuevo desde Ualá Bis, Cobros online, API."
          : "No pudimos comunicarnos con Ualá Bis. Probá de nuevo en unos segundos.",
    });
  }

  // ADR-057: al crear, la conexión de la sucursal del POS (si tiene); sobre
  // un intent, la misma con la que se creó.
  const conn = await loadCredsScoped(
    admin,
    tenantId,
    action === "create"
      ? { storeId: bodyStoreId(b) }
      : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  if (!conn) return json({ error: "not_connected" }, 400);
  const creds = conn.creds;

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "ualabis" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const check = orderAmount(amount);
    if (!check.ok) return json({ error: check.error }, 400);

    const env = await loadEnv(admin, tenantId);
    const hooks = `${hooksBase()}/ualabis`;
    const description = typeof b.title === "string" ? b.title.slice(0, 120) : "Venta";

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "ualabis", mp_env: intentEnvValue(env) },
      conn.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const appUrl = (Deno.env.get("APP_URL") ?? "https://pos.soft.ninja").replace(/\/+$/, "");
    const input = {
      amount,
      description,
      // Regreso del cliente a una página real de la app: las Edge Functions
      // sirven HTML como texto plano (se veía el código de la página).
      callbackSuccess: `${appUrl}/pagar/listo?estado=ok&medio=ualabis`,
      callbackFail: `${appUrl}/pagar/listo?estado=error&medio=ualabis`,
      notificationUrl: `${hooks}?intent=${intentId}`,
      externalReference: intentId,
    };

    const created = await clientFor(creds, env).createOrder(input);
    if (!created.ok) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      const auth = created.httpStatus === 401 || created.httpStatus === 403;
      return json({ error: auth ? "ualabis_auth_failed" : "ualabis_error", detail: created.detail }, 502);
    }

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: created.value.checkoutLink, preference_id: created.value.uuid })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "ualabis_order_created",
      after_data: { amount, env, order_uuid: created.value.uuid },
    });

    return json({ intent_id: intentId, init_point: created.value.checkoutLink });
  }

  // ── status / cancel / refund ───────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "ualabis")
    .maybeSingle();
  const row = rowData as IntentRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  const resync = async () =>
    row.status === "pending" && row.preference_id ? await syncIntent(admin, row, creds, "status", user.id) : null;

  if (action === "status") {
    const res = await resync();
    if (!res) return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    if ("error" in res) return json(res, 502);
    return json({ status: res.status, mp_payment_id: res.mp_payment_id });
  }

  if (action === "cancel") {
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    // Última verificación: si el cliente justo pagó, gana el pago.
    const res = await resync();
    if (res && !("error" in res) && res.status !== "pending") return json({ ok: true, status: res.status });
    const { data: changed } = await admin
      .from("mp_payment_intents")
      .update({ status: "cancelled" })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (changed && changed.length > 0) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId,
        actor_user_id: user.id,
        entity_type: "mp_payment_intents",
        entity_id: row.id,
        action: "ualabis_order_cancelled",
        after_data: { amount: Number(row.amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  if (action === "refund") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "ualabis" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
    if (row.status !== "approved" || !row.preference_id) return json({ error: "not_refundable" }, 409);

    // Con una venta vigente, primero se anula la venta (la devolución es total).
    const { data: pays } = await admin
      .from("payments")
      .select("sale_id, sales(status)")
      .eq("tenant_id", tenantId)
      .eq("method", "qr")
      .in("reference", [row.id, row.preference_id]);
    const liveSale = ((pays ?? []) as { sales: { status?: string } | null }[]).some(
      (p) => p.sales && p.sales.status !== "voided",
    );
    if (liveSale) return json({ error: "sale_active" }, 409);

    // Una devolución viva por cobro (índice único parcial): el reintento de un
    // pedido que ya salió no manda otro.
    const amount = Number(row.amount);
    const { data: refund, error: insErr } = await admin
      .from("ualabis_refunds")
      .insert({
        tenant_id: tenantId,
        intent_id: row.id,
        order_uuid: row.preference_id,
        amount,
        status: "requested",
        requested_by: user.id,
      })
      .select("id")
      .single();
    if (insErr || !refund) {
      const dup = (insErr as { code?: string } | null)?.code === "23505";
      return json({ error: dup ? "refund_in_progress" : "refund_failed" }, dup ? 409 : 500);
    }
    const refundId = (refund as { id: string }).id;

    const r = await clientFor(creds, envOfIntent(row)).refund(
      row.preference_id,
      amount,
      `${hooksBase()}/ualabis?refund=${refundId}`,
    );
    const c = classifyRefundResponse(r.httpStatus, r.body);
    await admin
      .from("ualabis_refunds")
      .update({ status: c.state, error_code: c.code })
      .eq("id", refundId)
      .eq("status", "requested");
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "ualabis_refunds",
      entity_id: refundId,
      action: `ualabis_refund_${c.state}`,
      after_data: { intent_id: row.id, order_uuid: row.preference_id, amount, code: c.code, env: envOfIntent(row) },
    });
    return json({ refund_id: refundId, status: c.state, error: c.state === "failed" ? c.code : undefined });
  }

  return json({ error: "invalid_action" }, 400);
});
