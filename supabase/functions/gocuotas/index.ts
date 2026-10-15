// =============================================================================
// Edge Function: gocuotas · GO Cuotas (cuotas sin interés con débito) por QR +
// link (F8 · ADR-033). API Redirect V1 de GO Cuotas, auth con la API Key de la
// sucursal como Bearer.
//
// Actions (body.action):
//   * create {amount, title?, email?, phone?} → intent local
//     (mp_payment_intents, provider_key='gocuotas', mp_env por el switch
//     Sandbox) + checkout POST /api_redirect/v1/checkouts con
//     order_reference_id = intent.id y webhook_url por intent. El url_init es
//     el init_point que el POS muestra como QR y link. Mínimo $1.500
//     (error gocuotas_min_amount).
//   * status {intent_id} → re-consulta la orden (por la pista guardada o por
//     order_reference_id) y sincroniza: approved + referencia propia + monto
//     exacto (centavos) → approved · denied → rejected.
//   * cancel {intent_id} → baja local del intent (Redirect no tiene endpoint
//     para anular un checkout sin pagar). Si el cliente igual paga, el webhook
//     lo registra como approved y queda en la conciliación.
//
// Gating real: tenant_has_feature_for(tenant,'gocuotas') en create.
// Credencial: payment_secrets provider 'gocuotas' { api_key } (set_payment_secret).
// Ambiente: tenant_payment_methods.sandbox (sandbox.gocuotas.com vs www).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { buildCheckoutUrl, parseCheckoutResponse } from "../_shared/gocuotas.ts";
import {
  INTENT_COLS,
  intentEnvValue,
  loadApiKeyScoped,
  loadEnv,
  syncIntent,
  type IntentRow,
} from "../_shared/gocuotas_server.ts";
import { bodyStoreId, insertIntentWithScope, intentSecretScope } from "../_shared/paymentSecrets.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

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

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // ADR-057: al crear, la API Key de la sucursal del POS (si tiene); sobre un
  // intent, la misma con la que se creó.
  const cred = await loadApiKeyScoped(
    admin,
    tenantId,
    action === "create"
      ? { storeId: bodyStoreId(b) }
      : { scopeStoreId: await intentSecretScope(admin, String(b.intent_id ?? "")) },
  );
  if (!cred) return json({ error: "not_connected" }, 400);
  const apiKey = cred.key;

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "gocuotas",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Math.round(Number(b.amount) * 100) / 100;
    const env = await loadEnv(admin, tenantId);
    const hook = `${url}/functions/v1/gocuotas_webhook`;
    const checkoutInput = {
      amount,
      orderReferenceId: "",
      webhookUrl: "",
      successUrl: `${hook}?view=success`,
      failureUrl: `${hook}?view=failed`,
      email: typeof b.email === "string" ? b.email : null,
      phone: typeof b.phone === "string" ? b.phone : null,
    };
    // Valida monto y mínimo ANTES de crear el intent.
    try {
      buildCheckoutUrl(env, { ...checkoutInput, orderReferenceId: "x", webhookUrl: hook });
    } catch (e) {
      const code = e instanceof Error ? e.message : "invalid_amount";
      return json({ error: code }, 400);
    }

    const { data: intent, error: intErr } = await insertIntentWithScope(
      admin,
      {
        tenant_id: tenantId,
        amount,
        provider_key: "gocuotas",
        mp_env: intentEnvValue(env),
      },
      cred.scopeStoreId,
    );
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);
    const intentId = (intent as { id: string }).id;

    const fail = async (detail: string) => {
      await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
      return json({ error: "gocuotas_error", detail: detail.slice(0, 300) }, 502);
    };

    let created: ReturnType<typeof parseCheckoutResponse> = null;
    let status = 0;
    try {
      const r = await fetch(
        buildCheckoutUrl(env, {
          ...checkoutInput,
          orderReferenceId: intentId,
          webhookUrl: `${hook}?intent=${intentId}`,
        }),
        {
          method: "POST",
          headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        },
      );
      status = r.status;
      const text = await r.text();
      if (status === 401 || status === 403) {
        await admin.from("mp_payment_intents").update({ status: "rejected" }).eq("id", intentId);
        return json({ error: "gocuotas_auth_failed", detail: text.slice(0, 300) }, 502);
      }
      if (r.ok) {
        try {
          created = parseCheckoutResponse(JSON.parse(text));
        } catch {
          created = null;
        }
      }
      if (!created) return fail(`${status} ${text}`);
    } catch (e) {
      return fail(String(e));
    }

    const { error: upErr } = await admin
      .from("mp_payment_intents")
      .update({ init_point: created.urlInit })
      .eq("id", intentId);
    if (upErr) return json({ error: "intent_failed" }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "mp_payment_intents",
      entity_id: intentId,
      action: "gocuotas_checkout_created",
      after_data: { amount, env },
    });

    return json({ intent_id: intentId, init_point: created.urlInit });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────
  const intentId = String(b.intent_id ?? "");
  if (!intentId) return json({ error: "invalid_intent" }, 400);
  const { data: rowData } = await admin
    .from("mp_payment_intents")
    .select(INTENT_COLS)
    .eq("id", intentId)
    .eq("tenant_id", tenantId)
    .eq("provider_key", "gocuotas")
    .maybeSingle();
  const row = rowData as IntentRow | null;
  if (!row) return json({ error: "intent_not_found" }, 404);

  if (action === "status") {
    if (row.status !== "pending") {
      return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    }
    const res = await syncIntent(admin, row, apiKey, "status", null, user.id);
    if ("error" in res) return json(res, 502);
    return json({ status: res.status, mp_payment_id: res.mp_payment_id });
  }

  if (action === "cancel") {
    if (row.status !== "pending") return json({ ok: true, status: row.status });
    // Última verificación: si el cliente justo pagó, gana el pago.
    const res = await syncIntent(admin, row, apiKey, "status", null, user.id);
    if (!("error" in res) && res.status !== "pending") {
      return json({ ok: true, status: res.status });
    }
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
        action: "gocuotas_checkout_cancelled",
        after_data: { amount: Number(row.amount) },
      });
    }
    return json({ ok: true, status: "cancelled" });
  }

  return json({ error: "invalid_action" }, 400);
});
