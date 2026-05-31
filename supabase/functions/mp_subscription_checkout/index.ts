// =============================================================================
// Edge Function: mp_subscription_checkout — crea una suscripción (preapproval)
// de Mercado Pago con la cuenta de NinjaSoft para cobrarle a un tenant su plan.
// SOLO staff internal. Usa platform_secrets.mercadopago.access_token. Guarda el
// preapproval_id en subscriptions y devuelve el init_point para enviarle al
// cliente. El estado lo confirma mp_billing_webhook.
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
  if (!(user.app_metadata as { is_internal?: boolean } | null)?.is_internal) {
    return json({ error: "forbidden" }, 403);
  }

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const tenantId = String(b.tenant_id ?? "").trim();
  if (!tenantId) return json({ error: "missing_tenant" }, 400);
  const backUrl = String(b.back_url ?? "").trim();

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Access Token de la cuenta de NinjaSoft.
  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "platform_not_configured" }, 400);

  // Suscripción del tenant + plan + email del owner.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, billing_cycle, plans(name, monthly_price_ars, yearly_price_ars)")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!sub) return json({ error: "no_subscription" }, 400);
  const plan = (sub.plans ?? {}) as {
    name?: string;
    monthly_price_ars?: number;
    yearly_price_ars?: number;
  };
  const yearly = sub.billing_cycle === "yearly";
  const amount = Number(yearly ? plan.yearly_price_ars : plan.monthly_price_ars);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "invalid_plan_price" }, 400);
  }

  const { data: ownerRow } = await admin
    .from("tenant_users")
    .select("users(email)")
    .eq("tenant_id", tenantId)
    .eq("role", "owner")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const payerEmail = (ownerRow?.users as { email?: string } | null)?.email;
  if (!payerEmail) return json({ error: "no_owner_email" }, 400);

  const notificationUrl = `${url}/functions/v1/mp_billing_webhook`;

  const res = await fetch("https://api.mercadopago.com/preapproval", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reason: `NinjaSoft POS — Plan ${plan.name ?? ""}`.trim(),
      external_reference: sub.id,
      payer_email: payerEmail,
      auto_recurring: {
        frequency: yearly ? 12 : 1,
        frequency_type: "months",
        transaction_amount: Math.round(amount * 100) / 100,
        currency_id: "ARS",
      },
      back_url: backUrl || undefined,
      notification_url: notificationUrl,
      status: "pending",
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "mp_error", detail: detail.slice(0, 400) }, 502);
  }
  const pre = (await res.json()) as { id?: string; init_point?: string };
  if (!pre.id) return json({ error: "no_preapproval" }, 502);

  await admin
    .from("subscriptions")
    .update({ mp_preapproval_id: pre.id })
    .eq("id", sub.id);

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "subscriptions",
    entity_id: sub.id,
    action: "subscription_checkout_created",
    after_data: { preapproval_id: pre.id, amount },
  });

  return json({ init_point: pre.init_point, preapproval_id: pre.id });
});
