// =============================================================================
// Edge Function: mp_update_subscription_amount — sincroniza el monto del
// preapproval de la suscripción a NinjaSoft con el total real (plan + addons).
//
// Se llama después de que el dueño ACTIVA o CANCELA un addon (o cambia de plan):
// el RPC SQL (activate_addon / cancel_addon / request_plan_change) ya actualizó
// subscription_addons / subscriptions (la fuente de verdad); esta función refleja
// ese total en Mercado Pago.
//
// Operatoria MP (verificada contra la doc de PreApproval):
//   • Update EN VIVO del monto: PUT https://api.mercadopago.com/preapproval/{id}
//     con auto_recurring.transaction_amount. MP soporta el update del monto sin
//     recrear el preapproval → NO se cancela ni se recrea (sin doble cobro).
//   • Si no hay preapproval todavía (el tenant aún no pagó / está en trial), no
//     hay nada que sincronizar: se responde no_preapproval con el total calculado
//     para que el panel ofrezca "Pagar y activar".
//
// Quién: staff (tenant_id en el body) o el DUEÑO del tenant (su current_tenant_id,
// verificado owner activo). Idéntico modelo de auth que mp_subscription_checkout.
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
    b = {};
  }
  // El dueño suele ser TAMBIÉN staff (is_internal): si no manda tenant_id en el
  // body, cae a su current_tenant_id (gestiona su propia suscripción). Mismo fix
  // que mp_subscription_checkout/manage.
  const tenantId = isInternal
    ? String(b.tenant_id ?? "").trim() || String(meta.current_tenant_id ?? "").trim()
    : String(meta.current_tenant_id ?? "").trim();
  if (!tenantId) return json({ error: "missing_tenant" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

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

  // Suscripción + preapproval id.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, mp_preapproval_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!sub) return json({ error: "no_subscription" }, 400);

  // Total canónico (plan + addons facturables).
  const { data: billing } = await admin.rpc("subscription_billing_total", {
    p_tenant: tenantId,
  });
  const amount = Number((billing as { total?: number } | null)?.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "invalid_amount" }, 400);
  }

  const preId = (sub.mp_preapproval_id ?? "").trim();
  if (!preId) {
    // Sin suscripción MP creada todavía: nada que sincronizar.
    return json({ ok: false, reason: "no_preapproval", amount });
  }

  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "platform_not_configured" }, 400);

  // PUT del nuevo monto al preapproval (update en vivo, sin recrear).
  const res = await fetch(`https://api.mercadopago.com/preapproval/${preId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auto_recurring: {
        transaction_amount: Math.round(amount * 100) / 100,
        currency_id: "ARS",
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_amount_sync_failed",
      after_data: { preapproval_id: preId, amount, detail: detail.slice(0, 300) },
    });
    return json({ error: "mp_error", detail: detail.slice(0, 400) }, 502);
  }

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "subscriptions",
    entity_id: sub.id,
    action: "subscription_amount_synced",
    after_data: {
      preapproval_id: preId,
      amount,
      via: isInternal ? "staff" : "owner",
    },
  });

  return json({ ok: true, amount, preapproval_id: preId });
});
