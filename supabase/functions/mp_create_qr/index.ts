// =============================================================================
// Edge Function: mp_create_qr — crea una preferencia de Checkout Pro de Mercado
// Pago para cobrar por QR. Lee el Access Token del tenant (payment_secrets,
// service_role), registra un mp_payment_intents y devuelve el init_point para QR.
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
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: "invalid_amount" }, 400);
  const title = String(b.title ?? "Venta").slice(0, 120);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Miembro activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem) return json({ error: "forbidden" }, 403);

  // Access Token del tenant.
  const { data: secretRow } = await admin
    .from("payment_secrets")
    .select("secrets")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "mercadopago")
    .maybeSingle();
  const accessToken = (secretRow?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "not_connected" }, 400);

  // Intent (pending) → external_reference.
  const { data: intent, error: intErr } = await admin
    .from("mp_payment_intents")
    .insert({ tenant_id: tenantId, amount, provider_key: "mercadopago" })
    .select("id")
    .single();
  if (intErr || !intent) return json({ error: "intent_failed" }, 500);

  const notificationUrl = `${url}/functions/v1/mp_webhook?intent=${intent.id}`;

  const prefRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [
        {
          title,
          quantity: 1,
          unit_price: Math.round(amount * 100) / 100,
          currency_id: "ARS",
        },
      ],
      external_reference: intent.id,
      notification_url: notificationUrl,
      binary_mode: true,
    }),
  });

  if (!prefRes.ok) {
    const detail = await prefRes.text();
    await admin
      .from("mp_payment_intents")
      .update({ status: "rejected" })
      .eq("id", intent.id);
    return json({ error: "mp_error", detail: detail.slice(0, 300) }, 502);
  }
  const pref = (await prefRes.json()) as {
    id: string;
    init_point: string;
    sandbox_init_point?: string;
  };
  const initPoint = pref.init_point || pref.sandbox_init_point || "";

  await admin
    .from("mp_payment_intents")
    .update({ preference_id: pref.id, init_point: initPoint })
    .eq("id", intent.id);

  return json({ intent_id: intent.id, init_point: initPoint });
});
