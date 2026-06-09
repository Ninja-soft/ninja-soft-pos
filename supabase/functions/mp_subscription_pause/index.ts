// =============================================================================
// Edge Function: mp_subscription_pause — PAUSA (o cancela) el preapproval de la
// suscripción a NinjaSoft en Mercado Pago. Es la pieza que faltaba para que
// "Cancelar suscripción" / "Dar de baja la cuenta" frenen el cobro recurrente:
// el RPC SQL (set_cancel_at_period_end / request_account_closure) ya marcó
// cancel_at_period_end=true localmente; ESTA función refleja eso en MP para que
// MP deje de cobrar.
//
// Operatoria MP (PreApproval):
//   • PUT https://api.mercadopago.com/preapproval/{id} con { status: "paused" }
//     PAUSA el cobro recurrente sin destruir el preapproval → se puede REANUDAR
//     (status:"authorized") si el dueño deshace la baja ("No cancelar"). Es lo que
//     usamos por defecto (action="pause"), porque la baja es a-fin-de-período:
//     el cliente conserva acceso hasta el vencimiento y NO debe cobrársele otra
//     vez en el ínterin.
//   • { status: "cancelled" } CANCELA definitivamente (no se reanuda). Se usa con
//     action="cancel" (p. ej. baja de cuenta dura, si se quisiera).
//   • Reanudar (action="resume") → { status: "authorized" }: lo invoca el front
//     cuando el dueño deshace la cancelación, para que MP retome el cobro normal.
//
// Tolerante a fallos: si NO hay preapproval todavía (trial / nunca pagó) no hay
// nada que pausar → responde ok:true, reason:"no_preapproval" (la marca local
// cancel_at_period_end alcanza). Si el GET/PUT a MP falla (preapproval viejo) NO
// devuelve 5xx para no romper el flujo de cancelación de la UI: la baja local ya
// quedó registrada por el RPC; se responde mp_unavailable=true con el detalle.
//
// Quién: staff (tenant_id en body) o el DUEÑO del tenant (su current_tenant_id,
// verificado owner activo). Idéntico modelo de auth que
// mp_subscription_manage / mp_update_subscription_amount. No expone secretos.
// Audita la acción.
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

// action → status que se manda a MP en el PUT del preapproval.
const ACTION_STATUS: Record<string, string> = {
  pause: "paused",
  cancel: "cancelled",
  resume: "authorized",
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
    error,
  } = await userClient.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    internal_level?: string;
    current_tenant_id?: string;
  };
  const isInternal = meta.is_internal === true;

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    b = {};
  }

  // action: "pause" (default), "cancel" o "resume".
  const action = String(b.action ?? "pause").trim().toLowerCase();
  const mpStatus = ACTION_STATUS[action];
  if (!mpStatus) return json({ error: "invalid_action" }, 400);

  // El dueño suele ser TAMBIÉN staff (is_internal): si no manda tenant_id en el
  // body (la card del dueño no lo manda), cae a su current_tenant_id. El staff
  // que gestiona OTRO tenant sí manda tenant_id. (Mismo fix que las otras mp_*.)
  const ownTenant = String(meta.current_tenant_id ?? "").trim();
  const bodyTenant = String(b.tenant_id ?? "").trim();
  const tenantId = isInternal ? bodyTenant || ownTenant : ownTenant;
  if (!tenantId) return json({ error: "missing_tenant" }, 400);

  // BUG 2 (escalada multi-tenant): el path interno puede ESCRIBIR en MP
  // (pausar/cancelar/reanudar el cobro) de CUALQUIER tenant. Sólo lo permitimos a
  // niveles con privilegio real (admin / super_admin). 'support' NO. Espejamos el
  // guard de internal_set_subscription_status (RPC): coalesce(level,'admin')==='support'
  // → forbidden (interno legacy sin nivel = admin). El dueño NO interno que
  // gestiona SU PROPIO tenant (bodyTenant vacío → ownTenant) no toca esta barrera.
  // Un interno que apunta a OTRO tenant (bodyTenant distinto del suyo) SÍ debe ser
  // admin+. Auditamos el rechazo.
  const internalLevel = (meta.internal_level ?? "").trim();
  const internalPrivileged =
    internalLevel === "" /* legacy = admin */ ||
    internalLevel === "admin" ||
    internalLevel === "super_admin" ||
    internalLevel === "superadmin";
  const targetsOtherTenant = bodyTenant !== "" && bodyTenant !== ownTenant;
  if (isInternal && targetsOtherTenant && !internalPrivileged) {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: null,
      action: "subscription_pause_forbidden",
      after_data: { action, internal_level: internalLevel || null, reason: "insufficient_level" },
    });
    return json({ error: "forbidden" }, 403);
  }

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
    // Sin preapproval: no hay cobro recurrente que pausar. La marca local
    // (cancel_at_period_end) ya alcanza; no es un error.
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_pause_noop",
      after_data: { action, reason: "no_preapproval" },
    });
    return json({ ok: true, reason: "no_preapproval", action });
  }

  const { data: plat } = await admin
    .from("platform_secrets")
    .select("secrets")
    .eq("key", "mercadopago")
    .maybeSingle();
  const accessToken = (plat?.secrets as { access_token?: string } | null)
    ?.access_token;
  if (!accessToken) return json({ error: "platform_not_configured" }, 400);

  // PUT del nuevo estado al preapproval (pausa/cancelación/reanudación en vivo).
  let res: Response;
  try {
    res = await fetch(`https://api.mercadopago.com/preapproval/${preId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: mpStatus }),
    });
  } catch (e) {
    // MP inalcanzable: la baja local ya quedó (RPC). No rompemos la UI.
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_pause_failed",
      after_data: { action, mp_status: mpStatus, detail: String(e).slice(0, 200) },
    });
    return json({
      ok: false,
      mp_unavailable: true,
      action,
      detail: String(e).slice(0, 200),
    });
  }

  if (!res.ok) {
    const detail = await res.text();
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: sub.id,
      action: "subscription_pause_failed",
      after_data: {
        action,
        mp_status: mpStatus,
        preapproval_id: preId,
        detail: detail.slice(0, 300),
      },
    });
    // No devolvemos 5xx: la cancelación local ya está hecha; la UI no debe
    // tratar esto como fallo del botón. Damos visibilidad con mp_unavailable.
    return json({
      ok: false,
      mp_unavailable: true,
      action,
      detail: detail.slice(0, 400),
    });
  }

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "subscriptions",
    entity_id: sub.id,
    action:
      action === "resume"
        ? "subscription_preapproval_resumed"
        : "subscription_preapproval_paused",
    after_data: {
      action,
      mp_status: mpStatus,
      preapproval_id: preId,
      via: isInternal ? "staff" : "owner",
    },
  });

  return json({ ok: true, action, mp_status: mpStatus, preapproval_id: preId });
});
