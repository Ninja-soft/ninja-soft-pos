// =============================================================================
// Edge Function: nave: cobro con Nave (Banco Galicia / Naranja X, plataforma
// Ranty) por QR interoperable + link de pago (F8 · H21c, ADR-030).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='nave') + payment_request `ecommerce` en Nave con
//     external_payment_id = intent.id. preference_id guarda el
//     payment_request_id e init_point el checkout_url (link). Devuelve también
//     qr_data (QR EMV interoperable: se renderiza TAL CUAL, sin tocarlo).
//   * status {intent_id}      → fallback manual (el webhook es el camino
//     principal): GET payment_requests/{id}; si hay un pago aprobado se
//     verifica contra GET payments/{id} (APPROVED + monto exacto) y recién ahí
//     se acredita. EXPIRED/DISABLED/BLOCKED → cancelled.
//   * cancel {intent_id}      → DELETE payment_requests/{id} (best-effort) y
//     cancela el intent local (si el pago ya se aprobó, gana el pago).
//
// Gating real: tenant_has_feature_for(tenant,'nave') en create. Credenciales:
// payment_secrets provider 'nave' (client_id, client_secret, pos_id); la
// misma conexión la usa nave_point. Ambiente por tenant_payment_methods.sandbox.
// El webhook (nave_webhook, URL registrada en el onboarding de Nave) es la
// confirmación principal; este poll es el respaldo cuando no llega.
// =============================================================================
import { buildPaymentRequest, naveApiBase } from "../_shared/nave.ts";
import {
  INTENT_COLS,
  audit,
  authMember,
  cancelIntent,
  cors,
  json,
  loadNaveConnection,
  syncIntent,
  type IntentRow,
} from "../_shared/nave_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope } from "../_shared/paymentSecrets.ts";

// Vida de la intención: alcanza para escanear o abrir el link en el mostrador.
const QR_DURATION_SECONDS = 15 * 60;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ctx = await authMember(req);
  if (ctx instanceof Response) return ctx;
  const { admin, tenantId, userId, supabaseUrl } = ctx;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(b.action ?? "");

  // ADR-057: al crear, la conexión de la sucursal del POS (si tiene una
  // propia); sobre un intent, la misma con la que se creó.
  const conn = await loadNaveConnection(
    admin,
    tenantId,
    action === "create"
      ? { storeId: bodyStoreId(b) }
      : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  if (!conn) return json({ error: "not_connected" }, 400);

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "nave",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);
    if (!conn.posId) return json({ error: "not_connected", detail: "pos_id" }, 400);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      { tenant_id: tenantId, amount, provider_key: "nave" },
      conn.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const body = buildPaymentRequest({
      externalPaymentId: intentId,
      posId: conn.posId,
      amount,
      title: String(b.title ?? "Venta NinjaPos"),
      durationSeconds: QR_DURATION_SECONDS,
      // Pantalla neutra de "volver" del checkout hosted (no confirma nada).
      callbackUrl: `${supabaseUrl}/functions/v1/nave_webhook?view=return`,
    });

    const fail = async (error: string, detail: string, status = 502) => {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error, detail: detail.slice(0, 300) }, status);
    };

    // Sin reintento automático del POST: Nave no documenta idempotencia.
    let r: Response;
    try {
      r = await conn.client.request(
        "POST",
        `${naveApiBase(conn.env, "qr")}/integrations/payment_requests/ecommerce`,
        body,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      return fail(msg === "nave_auth_failed" ? "nave_auth_failed" : "nave_unreachable", msg);
    }
    if (!r.ok) return fail("nave_error", await r.text());
    const pr = (await r.json().catch(() => null)) as {
      id?: string;
      checkout_url?: string;
      qr_data?: string;
    } | null;
    if (!pr?.id || !pr.qr_data || !pr.checkout_url) {
      return fail("nave_error", "respuesta sin id/qr_data/checkout_url");
    }

    // Persistir ANTES de entregar el QR/link al POS (si falla, no se expone).
    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ preference_id: pr.id, init_point: pr.checkout_url })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await audit(
      admin,
      { id: intentId, tenant_id: tenantId },
      "nave_payment_request_created",
      { provider_key: "nave", payment_request_id: pr.id, amount, env: conn.env },
      userId,
    );
    return json({ intent_id: intentId, init_point: pr.checkout_url, qr_data: pr.qr_data });
  }

  // ── status / cancel: sobre un intent Nave (QR + link) del tenant ────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: row } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "nave")
    .maybeSingle();
  if (!row) return json({ error: "intent_not_found" }, 404);

  if (action === "status") {
    try {
      const res = await syncIntent(admin, conn, row as IntentRow, "status");
      if ("error" in res) return json(res, 502);
      return json({ status: res.status, mp_payment_id: res.mp_payment_id });
    } catch (e) {
      return json({ error: "nave_unreachable", detail: e instanceof Error ? e.message : "" }, 502);
    }
  }

  if (action === "cancel") {
    const status = await cancelIntent(admin, conn, row as IntentRow, userId).catch(() => "pending");
    return json({ ok: true, status });
  }

  return json({ error: "invalid_action" }, 400);
});
