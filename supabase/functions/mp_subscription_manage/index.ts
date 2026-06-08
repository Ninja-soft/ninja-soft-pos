// =============================================================================
// Edge Function: mp_subscription_manage — gestión del MEDIO DE PAGO de la
// suscripción del dueño a NinjaSoft (el preapproval con el que le paga).
//
// Devuelve, leyendo el preapproval real de Mercado Pago (GET /preapproval/{id})
// con el access_token de plataforma:
//   • status            (authorized / pending / paused / cancelled)
//   • payment_method_id  (marca de la tarjeta, ej. "visa"/"master"; MP NO expone
//                         los últimos 4 dígitos en el preapproval — sólo card_id)
//   • card_id            (id interno de la tarjeta, por si se quiere mostrar/log)
//   • next_payment_date
//   • manage_url         (init_point del preapproval): a esta URL se redirige al
//                         pagador para CAMBIAR/actualizar su tarjeta. MP permite
//                         que el pagador actualice el medio desde ahí, sin recrear
//                         el preapproval (sin doble cobro). Si el GET no trae
//                         init_point, se arma el checkout de suscripción estándar.
//
// Quién: staff (tenant_id en body) o el DUEÑO del tenant (su current_tenant_id,
// verificado owner activo). Mismo modelo de auth que mp_subscription_checkout.
// No expone el access_token ni datos sensibles del pagador.
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
  const tenantId = isInternal
    ? String(b.tenant_id ?? "").trim()
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

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, mp_preapproval_id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!sub) return json({ error: "no_subscription" }, 400);

  const preId = (sub.mp_preapproval_id ?? "").trim();
  if (!preId) {
    // Sin preapproval: no hay medio de pago que gestionar todavía.
    return json({ has_preapproval: false });
  }

  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "platform_not_configured" }, 400);

  const res = await fetch(`https://api.mercadopago.com/preapproval/${preId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "mp_error", detail: detail.slice(0, 400) }, 502);
  }
  const pre = (await res.json()) as {
    id?: string;
    status?: string;
    init_point?: string;
    sandbox_init_point?: string;
    payment_method_id?: string;
    card_id?: string;
    next_payment_date?: string;
  };

  // URL a la que se redirige al pagador para cambiar/actualizar su tarjeta.
  const manageUrl =
    pre.init_point ||
    pre.sandbox_init_point ||
    `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=${preId}`;

  return json({
    has_preapproval: true,
    preapproval_id: preId,
    status: pre.status ?? null,
    payment_method_id: pre.payment_method_id ?? null,
    card_id: pre.card_id ?? null,
    next_payment_date: pre.next_payment_date ?? null,
    manage_url: manageUrl,
  });
});
