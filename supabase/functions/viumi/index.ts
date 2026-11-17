// =============================================================================
// Edge Function: viumi · Viumi (Banco Macro) por link de pago + QR (F8 ·
// ADR-173). Checkout API v2 (developers.viumi.com.ar): token OAuth por
// client_id + client_secret del comercio y orden con checkout hosted de Viumi.
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='viumi', mp_env por el switch Sandbox = stage) + orden
//     POST /api/v2/orders con el intent como id del ítem y en la query del
//     webhookUrl (dominio de hooks). El link de checkout es el init_point que
//     el POS muestra como QR y link. El uuid de la orden queda en preference_id.
//   * status {intent_id} → re-consulta la orden y sincroniza (respaldo del
//     webhook): pago aprobado + orden propia + monto exacto → approved.
//   * cancel {intent_id} → baja local del intent (la API no documenta anular
//     órdenes; el link vence solo por expireLimitMinutes). Si el cliente igual
//     paga, el webhook lo registra como approved y queda en la conciliación.
//   * probe {client_id?, client_secret?, environment?, store_id?} → "Probar
//     conexión": pide un token (dueño o encargado). Sin credenciales tipeadas
//     prueba las guardadas. No guarda nada.
//
// Sin devoluciones: la API no las documenta, se hacen desde la app o el panel
// de Viumi.
//
// Gating real: tenant_has_feature_for(tenant,'viumi') en create (y el trigger
// de payments vía payment_method_plan_key('viumi')).
// Credencial: payment_secrets provider 'viumi' (set_payment_secret). Nunca sale
// del servidor ni se loguea.
// =============================================================================
import {
  isAuthFailure,
  orderAmount,
  parseCreds,
  viumiClient,
  UUID_RE,
  VIUMI_EXPIRE_MINUTES,
  type ViumiEnv,
} from "../_shared/viumi.ts";
import {
  INTENT_COLS,
  clientFor,
  hooksBase,
  intentEnvValue,
  loadCredsScoped,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/viumi_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope, isScopeUuid } from "../_shared/paymentSecrets.ts";
import { authenticateTenantUser, requireTenantMember } from "../_shared/tenantAuth.ts";

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

const envLabel = (e: ViumiEnv) => (e === "stage" ? "Prueba" : "Producción");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // SEC-27: getUser + claim current_tenant_id (401 / 400 no_tenant).
  const session = await authenticateTenantUser(req, { respond: json });
  if (session instanceof Response) return session;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  // Miembro activo (y no suspendido) del tenant del JWT (SEC-27): 403 si no.
  const member = await requireTenantMember(session, { respond: json });
  if (member instanceof Response) return member;
  const { user, tenantId, admin, role } = member;
  const isManager = ["owner", "manager"].includes(String(role));

  // ── probe ("Probar conexión") ──────────────────────────────────────────────
  if (action === "probe") {
    if (!isManager) return json({ error: "forbidden" }, 403);
    const typed = parseCreds({ client_id: b.client_id, client_secret: b.client_secret });
    const storeId = isScopeUuid(b.store_id) ? b.store_id : null;
    const creds =
      typed ?? (await loadCredsScoped(admin, tenantId, { scopeStoreId: storeId }))?.creds ?? null;
    if (!creds) return json({ ok: false, error: "not_connected" });
    const env: ViumiEnv =
      b.environment === "test" ? "stage" : b.environment === "prod" ? "prod" : await loadEnv(admin, tenantId);
    const r = await viumiClient({ creds, env }).token(true);
    if (r.ok) {
      return json({
        ok: true,
        environment: env === "stage" ? "test" : "prod",
        label: `${envLabel(env)}: Viumi aceptó las credenciales`,
      });
    }
    // ¿Son del otro ambiente? Se prueba el otro sin guardar nada.
    const other: ViumiEnv = env === "stage" ? "prod" : "stage";
    const alt = isAuthFailure(r.httpStatus) ? await viumiClient({ creds, env: other }).token(true) : null;
    return json({
      ok: false,
      environment: env === "stage" ? "test" : "prod",
      mismatch: alt?.ok ? (other === "stage" ? "test" : "prod") : null,
      summary: alt?.ok
        ? `Estas credenciales son de ${envLabel(other).toLowerCase()}, no de ${envLabel(env).toLowerCase()}.`
        : isAuthFailure(r.httpStatus)
          ? "Viumi rechazó el Client ID o el Client Secret. Revisalos con el mail de credenciales que te mandó Viumi."
          : "No pudimos comunicarnos con Viumi. Probá de nuevo en unos segundos.",
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
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", { p_tenant: tenantId, p_key: "viumi" });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const check = orderAmount(amount);
    if (!check.ok) return json({ error: check.error }, 400);

    const env = await loadEnv(admin, tenantId);
    const hooks = `${hooksBase()}/viumi`;
    const description = typeof b.title === "string" ? b.title.slice(0, 63) : "Venta";

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "viumi", mp_env: intentEnvValue(env) },
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

    const created = await clientFor(creds, env).createOrder({
      amount,
      description,
      intentId,
      // Regreso del cliente a una página real de la app (pantalla neutra).
      successUrl: `${appUrl}/pagar/listo?estado=ok&medio=viumi${brandQs}`,
      failedUrl: `${appUrl}/pagar/listo?estado=error&medio=viumi${brandQs}`,
      webhookUrl: `${hooks}?intent=${intentId}`,
      expireMinutes: VIUMI_EXPIRE_MINUTES,
    });
    if (!created.ok) {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      const auth = created.httpStatus === 401 || created.httpStatus === 403;
      return json({ error: auth ? "viumi_auth_failed" : "viumi_error", detail: created.detail }, 502);
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
      action: "viumi_order_created",
      after_data: { amount, env, order_uuid: created.value.uuid },
    });

    return json({ intent_id: intentId, init_point: created.value.checkoutLink });
  }

  // ── status / cancel ────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!UUID_RE.test(intentId)) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "viumi")
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
        action: "viumi_order_cancelled",
        after_data: { amount: Number(row.amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  return json({ error: "invalid_action" }, 400);
});
