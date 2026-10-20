// =============================================================================
// Edge Function: dlocalgo · dLocal Go por link de pago + QR (F8 · ADR-180).
// Payments API (docs.dlocalgo.com): header Bearer API_KEY:SECRET_KEY del
// comercio y pago con checkout hosted de dLocal Go (redirect_url).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='dlocalgo', mp_env por el switch Sandbox = test) + POST
//     /v1/payments en ARS con order_id = intent.id y notification_url por
//     intent (dominio de hooks). El redirect_url es el init_point que el POS
//     muestra como QR y link. El id del pago (DP-...) queda en preference_id.
//   * status {intent_id} → re-consulta el pago y sincroniza (respaldo del
//     webhook): PAID + order_id propio + ARS + monto exacto → approved ·
//     REJECTED → rejected · CANCELLED → cancelled · EXPIRED → expired.
//   * cancel {intent_id} → baja local del intent (la API no anula pagos). Si el
//     cliente igual paga, el webhook lo registra como approved y queda en la
//     conciliación.
//   * probe {api_key?, secret_key?, environment?, store_id?} → "Probar
//     conexión": GET /v1/currency-exchanges (dueño o encargado). Sin
//     credenciales tipeadas prueba las guardadas. No guarda nada.
//   * refund {intent_id} → devolución TOTAL de un cobro aprobado (dueño o
//     encargado) sin venta vigente (la venta se anula primero). Fila en
//     dlocalgo_refunds (una devolución viva por cobro) + POST /v1/refunds. El
//     resultado final llega por dlocalgo_webhook (re-consulta la devolución).
//
// Gating real: tenant_has_feature_for(tenant,'dlocalgo') en create y refund (y
// el alta del medio vía payment_method_plan_key('dlocalgo')).
// Credencial: payment_secrets provider 'dlocalgo' (set_payment_secret). Nunca
// sale del servidor ni se loguea.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  classifyRefundResponse,
  createErrorCode,
  dlocalgoClient,
  isAuthFailure,
  parseCreds,
  paymentAmount,
  UUID_RE,
  type DlocalEnv,
} from "../_shared/dlocalgo.ts";
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
} from "../_shared/dlocalgo_server.ts";
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

const envLabel = (e: DlocalEnv) => (e === "sandbox" ? "Prueba" : "Producción");

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
    const typed = parseCreds({ api_key: b.api_key, secret_key: b.secret_key });
    const storeId = isScopeUuid(b.store_id) ? b.store_id : null;
    const creds = typed ?? (await loadCredsScoped(admin, tenantId, { scopeStoreId: storeId }))?.creds ?? null;
    if (!creds) return json({ ok: false, error: "not_connected" });
    const env: DlocalEnv =
      b.environment === "test" ? "sandbox" : b.environment === "prod" ? "prod" : await loadEnv(admin, tenantId);
    const r = await dlocalgoClient({ creds, env }).probe();
    if (r.ok) {
      return json({
        ok: true,
        environment: env === "sandbox" ? "test" : "prod",
        label: `${envLabel(env)}: dLocal Go aceptó las credenciales`,
      });
    }
    // ¿Son del otro ambiente? Se prueba el otro sin guardar nada.
    const other: DlocalEnv = env === "sandbox" ? "prod" : "sandbox";
    const alt = isAuthFailure(r.httpStatus) ? await dlocalgoClient({ creds, env: other }).probe() : null;
    return json({
      ok: false,
      environment: env === "sandbox" ? "test" : "prod",
      mismatch: alt?.ok ? (other === "sandbox" ? "test" : "prod") : null,
      summary: alt?.ok
        ? `Estas credenciales son de ${envLabel(other).toLowerCase()}, no de ${envLabel(env).toLowerCase()}.`
        : isAuthFailure(r.httpStatus)
          ? "dLocal Go rechazó la API Key o la Secret Key. Copialas de nuevo desde Integraciones, API Integration."
          : "No pudimos comunicarnos con dLocal Go. Probá de nuevo en unos segundos.",
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
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "dlocalgo" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const check = paymentAmount(amount);
    if (!check.ok) return json({ error: check.error }, 400);

    const env = await loadEnv(admin, tenantId);
    const hooks = `${hooksBase()}/dlocalgo`;
    const description = typeof b.title === "string" ? b.title.slice(0, 100) : "Venta";

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "dlocalgo", mp_env: intentEnvValue(env) },
      conn.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const appUrl = (Deno.env.get("APP_URL") ?? "https://pos.soft.ninja").replace(/\/+$/, "");
    // Marca del negocio para la pantalla de regreso (dato público: nombre y logo).
    const { data: br } = await admin.from("tenant_branding").select("trade_name, logo_url").eq("tenant_id", tenantId).maybeSingle();
    const { data: tn } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const shopName = String((br as { trade_name?: string } | null)?.trade_name || (tn as { name?: string } | null)?.name || "").trim().slice(0, 80);
    const shopLogo = String((br as { logo_url?: string } | null)?.logo_url ?? "").trim();
    const brandQs =
      (shopName ? `&n=${encodeURIComponent(shopName)}` : "") +
      (/^https:\/\//.test(shopLogo) && shopLogo.length < 600 ? `&l=${encodeURIComponent(shopLogo)}` : "");

    const created = await clientFor(creds, env).createPayment({
      amount,
      description,
      orderId: intentId,
      // Regreso del cliente a una página real de la app (neutra: no confirma nada).
      successUrl: `${appUrl}/pagar/listo?estado=ok&medio=dlocalgo${brandQs}`,
      backUrl: `${appUrl}/pagar/listo?estado=error&medio=dlocalgo${brandQs}`,
      notificationUrl: `${hooks}?intent=${intentId}`,
    });
    if (!created.ok) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: createErrorCode(created.httpStatus, created.code), detail: created.detail }, 502);
    }

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: created.value.redirectUrl, preference_id: created.value.id })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "dlocalgo_payment_created",
      after_data: { amount, env, payment_id: created.value.id },
    });

    return json({ intent_id: intentId, init_point: created.value.redirectUrl });
  }

  // ── status / cancel / refund ───────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "dlocalgo")
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
        action: "dlocalgo_payment_cancelled",
        after_data: { amount: Number(row.amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  if (action === "refund") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "dlocalgo" });
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

    // Una devolución viva o hecha por cobro (índice único parcial): el
    // reintento de un pedido que ya salió no manda otro.
    const amount = Number(row.amount);
    const { data: refund, error: insErr } = await admin
      .from("dlocalgo_refunds")
      .insert({
        tenant_id: tenantId,
        intent_id: row.id,
        payment_id: row.preference_id,
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
      `${hooksBase()}/dlocalgo?refund=${refundId}`,
    );
    const c = classifyRefundResponse(r.httpStatus, r.body);
    await admin
      .from("dlocalgo_refunds")
      .update({ status: c.state, error_code: c.code, refund_ref: c.ref })
      .eq("id", refundId)
      .eq("status", "requested");
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "dlocalgo_refunds",
      entity_id: refundId,
      action: `dlocalgo_refund_${c.state}`,
      after_data: { intent_id: row.id, payment_id: row.preference_id, amount, code: c.code, env: envOfIntent(row) },
    });
    return json({ refund_id: refundId, status: c.state, error: c.state === "failed" ? c.code : undefined });
  }

  return json({ error: "invalid_action" }, 400);
});
