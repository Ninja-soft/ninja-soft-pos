// =============================================================================
// Edge Function: mp_subscription_checkout — crea una suscripción (preapproval)
// de Mercado Pago con la cuenta de NinjaSoft para cobrarle a un tenant su plan
// + addons activos. Guarda el preapproval_id en subscriptions y devuelve el
// init_point para enviarle al cliente. El estado lo confirma mp_billing_webhook.
//
// Quién puede invocarla:
//   • Staff interno (app_metadata.is_internal): puede pasar cualquier tenant_id
//     (path original, NO se rompe).
//   • El DUEÑO del tenant (self-service): NO pasa tenant_id; se usa SIEMPRE su
//     app_metadata.current_tenant_id y se verifica que sea owner activo en
//     tenant_users. Así el dueño paga su propia suscripción en el alta o desde
//     el panel (planes sin trial, reactivación, cambio a plan pago).
//
// Monto: plan + addons facturables, calculado por el RPC subscription_billing_total
// (fuente de verdad = subscriptions.plan + subscription_addons activos). Antes se
// cobraba SOLO el plan; ahora el preapproval refleja el total real.
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

  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    current_tenant_id?: string;
  };
  const isInternal = meta.is_internal === true;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const backUrl = String(b.back_url ?? "").trim();

  // Resolución del tenant según el invocador:
  //   • staff: usa el tenant_id del body (path original).
  //   • dueño: SIEMPRE su current_tenant_id (ignora el body para no permitir
  //     crear preapprovals de otros tenants).
  const tenantId = isInternal
    ? String(b.tenant_id ?? "").trim()
    : String(meta.current_tenant_id ?? "").trim();
  if (!tenantId) return json({ error: "missing_tenant" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Autorización del path dueño: debe ser owner activo del tenant.
  if (!isInternal) {
    const { data: mem } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!mem || mem.role !== "owner") return json({ error: "forbidden" }, 403);
  }

  // Access Token de la cuenta de NinjaSoft.
  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "platform_not_configured" }, 400);

  // Suscripción del tenant + plan (para reason/frecuencia) + email del owner.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, billing_cycle, plans(name)")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!sub) return json({ error: "no_subscription" }, 400);
  const plan = (sub.plans ?? {}) as { name?: string };
  const yearly = sub.billing_cycle === "yearly";

  // Monto canónico: plan + addons facturables (RPC, fuente de verdad).
  const { data: billing } = await admin.rpc("subscription_billing_total", {
    p_tenant: tenantId,
  });
  const amount = Number((billing as { total?: number } | null)?.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "invalid_plan_price" }, 400);
  }

  const { data: ownerRow } = await admin
    .from("tenant_users")
    .select("users(email)")
    .eq("tenant_id", tenantId)
    .eq("role", "owner")
    .eq("status", "active")
    .order("created_at", { ascending: true })
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
      reason: `NinjaSoft POS • Plan ${plan.name ?? ""}`.trim(),
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
  const pre = (await res.json()) as {
    id?: string;
    init_point?: string;
    sandbox_init_point?: string;
  };
  if (!pre.id) return json({ error: "no_preapproval" }, 502);
  const initPoint = pre.init_point || pre.sandbox_init_point || "";

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
    after_data: {
      preapproval_id: pre.id,
      amount,
      via: isInternal ? "staff" : "owner",
    },
  });

  return json({ init_point: initPoint, preapproval_id: pre.id });
});
