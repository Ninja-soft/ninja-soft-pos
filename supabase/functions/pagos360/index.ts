// =============================================================================
// Edge Function: pagos360 — links de pago / cobranzas (F8 · H21).
// Crea una solicitud de pago (payment_request) en Pagos360 y devuelve su
// checkout hosted (checkout_url) que el POS muestra como QR + "Abrir link de
// pago". Sin webhook obligatorio: el POS sondea `status`, que sincroniza el
// estado contra la API de Pagos360 (patrón mp_point) y sólo acredita con
// state=paid y monto exacto (conservador: nunca se registra venta sin esa
// confirmación).
//
// Actions (body.action):
//   * create {amount, title?} → intent local (mp_payment_intents,
//     provider_key='pagos360'; habilita el gating fino del trigger de payments
//     para method='qr') + payment_request en Pagos360. preference_id guarda el
//     id de Pagos360; init_point, el checkout_url.
//   * status {intent_id}      → GET payment-request/{id} y sincroniza:
//     paid (+ monto ok) → approved · expired/canceled/reverted → cancelled.
//
// Sandbox: si tenant_payment_methods.sandbox=true para pagos360, se usa
// https://api.sandbox.pagos360.com (permite probar el flujo completo con la
// API key de sandbox, sin plata real).
//
// Gating real de plan: tenant_has_feature_for(tenant,'pagos360') en create.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Fecha DD-MM-YYYY en hora argentina (primer vencimiento del link). Mañana:
// evita el borde de medianoche AR vs UTC para un cobro de mostrador.
function firstDueDateAr(): string {
  const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const ar = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const get = (t: string) => ar.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

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

  // API key del tenant + base sandbox/prod según la config del medio.
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "pagos360")
    .maybeSingle();
  const apiKey = ((secretRow?.secrets ?? {}) as { api_key?: string }).api_key;
  if (!apiKey) return json({ error: "not_connected" }, 400);

  const { data: methodRow } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "pagos360")
    .maybeSingle();
  const base = methodRow?.sandbox
    ? "https://api.sandbox.pagos360.com"
    : "https://api.pagos360.com";
  const p360Headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // ── create: intent local + payment_request en Pagos360 ──────────────────────
  if (action === "create") {
    const { data: allowed } = await admin.rpc("tenant_has_feature_for", {
      p_tenant: tenantId,
      p_key: "pagos360",
    });
    if (allowed !== true) return json({ error: "payment_method_not_allowed" }, 403);

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "invalid_amount" }, 400);
    }
    const title = String(b.title ?? "Venta NinjaPos").slice(0, 120);

    const { data: intent, error: intErr } = await admin
      .from("mp_payment_intents")
      .insert({ tenant_id: tenantId, amount, provider_key: "pagos360" })
      .select("id")
      .single();
    if (intErr || !intent) return json({ error: "intent_failed" }, 500);

    const r = await fetch(`${base}/payment-request`, {
      method: "POST",
      headers: p360Headers,
      body: JSON.stringify({
        payment_request: {
          description: title,
          first_due_date: firstDueDateAr(),
          first_total: Math.round(amount * 100) / 100,
          payer_name: "Consumidor final",
          external_reference: intent.id,
        },
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "pagos360_error", detail: detail.slice(0, 300) }, 502);
    }
    const pr = (await r.json()) as {
      id: number | string;
      checkout_url?: string;
      form_url?: string;
    };
    const initPoint = pr.checkout_url || pr.form_url || "";
    if (!initPoint) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", intent.id);
      return json({ error: "pagos360_error", detail: "sin checkout_url" }, 502);
    }
    await admin
      .from("mp_payment_intents")
      .update({ preference_id: String(pr.id), init_point: initPoint })
      .eq("id", intent.id);
    return json({ intent_id: intent.id, init_point: initPoint });
  }

  // ── status: sincroniza contra Pagos360 y devuelve el estado local ───────────
  if (action === "status") {
    const intentId = String(b.intent_id ?? "");
    if (!intentId) return json({ error: "invalid_intent" }, 400);
    const { data: row } = await admin
      .from("mp_payment_intents")
      .select("id, status, amount, preference_id, mp_payment_id")
      .eq("id", intentId)
      .eq("tenant_id", tenantId)
      .eq("provider_key", "pagos360")
      .maybeSingle();
    if (!row) return json({ error: "intent_not_found" }, 404);

    if (row.status !== "pending") {
      return json({ status: row.status, mp_payment_id: row.mp_payment_id });
    }

    const r = await fetch(`${base}/payment-request/${row.preference_id}`, {
      headers: p360Headers,
    });
    if (!r.ok) {
      return json(
        { error: "pagos360_error", detail: (await r.text()).slice(0, 300) },
        502,
      );
    }
    const pr = (await r.json()) as { state?: string; first_total?: number };
    const state = String(pr.state ?? "").toLowerCase();

    if (state === "paid") {
      // Verificación de monto: la solicitud la creamos nosotros con el total
      // exacto; igual chequeamos que Pagos360 devuelva el mismo importe.
      const amountOk =
        Math.abs(Number(pr.first_total ?? 0) - Number(row.amount)) < 0.01;
      if (amountOk) {
        await admin
          .from("mp_payment_intents")
          .update({ status: "approved", mp_payment_id: String(row.preference_id) })
          .eq("id", row.id);
        return json({ status: "approved", mp_payment_id: String(row.preference_id) });
      }
      await admin
        .from("mp_payment_intents")
        .update({ status: "rejected" })
        .eq("id", row.id);
      return json({ status: "rejected", mp_payment_id: null });
    }

    if (["expired", "canceled", "cancelled", "reverted"].includes(state)) {
      await admin
        .from("mp_payment_intents")
        .update({ status: "cancelled" })
        .eq("id", row.id);
      return json({ status: "cancelled", mp_payment_id: null });
    }

    return json({ status: "pending", mp_payment_id: null, state });
  }

  return json({ error: "invalid_action" }, 400);
});
