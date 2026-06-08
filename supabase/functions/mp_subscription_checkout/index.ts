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
//
// Diagnóstico: cada validación que devuelve 400/401/403/502 deja un console.error
// con el detalle real (incluido el error de PostgREST, que antes se tragaba
// silencioso al mirar sólo `data`) para que un fallo se vea en los logs de la
// función. El cuerpo de error sólo expone un `error` estable; los detalles
// técnicos van al log, no al cliente.
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

// Error tipado de PostgREST (lo que devuelve supabase-js en `error`).
type PgError = {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
} | null;

// Loguea el detalle real (incluido el error de PostgREST) y devuelve la respuesta
// con un `error` estable para el cliente. Antes estos errores se tragaban (solo
// se miraba `data`), así que un fallo de query parecía "sin datos" → 400 opaco.
const fail = (error: string, status: number, detail?: unknown) => {
  console.error(`[mp_subscription_checkout] ${error}`, detail ?? "");
  return json({ error }, status);
};

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
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) return fail("unauthorized", 401, authError?.message);

  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    current_tenant_id?: string;
  };
  const isInternal = meta.is_internal === true;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return fail("invalid_json", 400);
  }
  const backUrl = String(b.back_url ?? "").trim();

  // Resolución del tenant según el invocador:
  //   • staff: usa el tenant_id del body (path original: cobra a cualquier
  //     tenant desde el panel interno). Si NO manda tenant_id (p. ej. un
  //     operador interno que ADEMÁS es dueño y paga SU propia suscripción desde
  //     la card de Suscripción, que nunca envía tenant_id), cae a su propio
  //     current_tenant_id. Antes esto devolvía missing_tenant y rompía el pago.
  //   • dueño (is_internal=false): SIEMPRE su current_tenant_id (ignora el body
  //     para no permitir crear preapprovals de otros tenants).
  const tenantId = isInternal
    ? String(b.tenant_id ?? meta.current_tenant_id ?? "").trim()
    : String(meta.current_tenant_id ?? "").trim();
  if (!tenantId) {
    return fail("missing_tenant", 400, {
      isInternal,
      hasBodyTenant: Boolean(b.tenant_id),
      hasCurrentTenant: Boolean(meta.current_tenant_id),
    });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Autorización del path dueño: debe ser owner activo del tenant.
  if (!isInternal) {
    const { data: mem, error: memErr } = await admin
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (memErr) return fail("membership_lookup_failed", 400, memErr as PgError);
    if (!mem || mem.role !== "owner") {
      return fail("forbidden", 403, { role: mem?.role ?? null });
    }
  }

  // Access Token de la cuenta de NinjaSoft.
  const { data: plat, error: platErr } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  if (platErr) return fail("platform_lookup_failed", 400, platErr as PgError);
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return fail("platform_not_configured", 400);

  // Suscripción del tenant + plan (para reason/frecuencia).
  const { data: sub, error: subErr } = await admin
    .from("subscriptions")
    .select("id, billing_cycle, plans(name)")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (subErr) return fail("subscription_lookup_failed", 400, subErr as PgError);
  if (!sub) return fail("no_subscription", 400, { tenantId });
  // `plans` puede venir como objeto (to-one) o array según el cache de PostgREST;
  // se normaliza para leer el nombre sin romper.
  const planRel = sub.plans as { name?: string } | { name?: string }[] | null;
  const plan = (Array.isArray(planRel) ? planRel[0] : planRel) ?? {};
  const yearly = sub.billing_cycle === "yearly";

  // Monto canónico: plan + addons facturables (RPC, fuente de verdad).
  const { data: billing, error: billErr } = await admin.rpc(
    "subscription_billing_total",
    { p_tenant: tenantId },
  );
  if (billErr) return fail("billing_total_failed", 400, billErr as PgError);
  const amount = Number((billing as { total?: number } | null)?.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail("invalid_plan_price", 400, { billing });
  }

  // Email del pagador (owner). Primero el embed tenant_users → users(email);
  // si por algún motivo no hay fila/clave (p. ej. una cuenta recién creada por
  // OAuth cuyo espejo public.users todavía no sincronizó el email), se cae al
  // email real del invocador vía Auth Admin, que SIEMPRE existe. Así un dueño
  // legítimo nunca queda bloqueado por un desfase de datos.
  let payerEmail = "";
  const { data: ownerRow, error: ownerErr } = await admin
    .from("tenant_users")
    .select("users(email)")
    .eq("tenant_id", tenantId)
    .eq("role", "owner")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ownerErr) {
    // No es fatal: hay fallback. Se loguea para visibilidad.
    console.error(
      "[mp_subscription_checkout] owner_email_embed_failed",
      ownerErr as PgError,
    );
  } else {
    const usersRel = ownerRow?.users as
      | { email?: string }
      | { email?: string }[]
      | null;
    const ownerUser = Array.isArray(usersRel) ? usersRel[0] : usersRel;
    payerEmail = (ownerUser?.email ?? "").trim();
  }
  // ¿El invocador está pagando SU PROPIO tenant? (dueño self-service, o un
  // operador interno que también es dueño y paga su suscripción). En ese caso su
  // email de auth.users es un payer_email válido y se usa como fallback. Para el
  // staff que cobra a OTRO tenant NO se sustituye por el email del operador: se
  // exige el email del owner real de ese tenant.
  const isSelfPay =
    String(meta.current_tenant_id ?? "").trim() === tenantId;
  // Fallback 1: el email del propio invocador desde el JWT/Auth.
  if (!payerEmail && isSelfPay) {
    payerEmail = (user.email ?? "").trim();
  }
  // Fallback 2: Auth Admin por id (cubre cualquier desfase del espejo
  // public.users; el invocador siempre tiene email en auth.users).
  if (!payerEmail && isSelfPay) {
    const { data: au } = await admin.auth.admin.getUserById(user.id);
    payerEmail = (au?.user?.email ?? "").trim();
  }
  if (!payerEmail) return fail("no_owner_email", 400, { tenantId, isInternal });

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
    console.error("[mp_subscription_checkout] mp_error", detail.slice(0, 400));
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
