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
//
// ADR-156: el monto ya no es el total de HOY sino el del PRÓXIMO DÉBITO
// (platform_mp_expected_amount: período que arranca en la fecha del cobro con
// las bajas, pruebas, escalones y descuentos de ese día, más los ajustes
// abiertos como el prorrateo de un complemento). Lo sincronizado queda en
// subscriptions.mp_amount_synced. Modo cron (X-Cron-Secret, body
// { mode: "cron" }, pg_cron platform-mp-amount-sync 08:30 ART): recorre
// platform_mp_amount_targets() y corrige los montos que difieren. Deploy:
// verify_jwt = true (el cron manda el anon key como Bearer).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { platformMpToken, syncPreapprovalAmount } from "../_shared/mpSubscriptionSync.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope, x-cron-secret",
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

  // Modo cron: corrige todos los montos que difieren del esperado.
  const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
  if (cronSecret) {
    const cronAdmin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: sec } = await cronAdmin.from("platform_secrets").select("secrets").eq("key", "internal_cron").maybeSingle();
    const token = String(((sec?.secrets ?? {}) as { token?: string }).token ?? "");
    if (!token || cronSecret !== token) return json({ error: "forbidden" }, 403);
    const { data: targets, error: tErr } = await cronAdmin.rpc("platform_mp_amount_targets", { p_limit: 200 });
    if (tErr) return json({ error: "targets_failed", detail: tErr.message }, 500);
    const accessToken = await platformMpToken(cronAdmin);
    if (!accessToken) return json({ ok: false, reason: "platform_not_configured" });
    const results: { tenant_id: string; ok: boolean; reason?: string; amount?: number }[] = [];
    for (const t of (targets ?? []) as { tenant_id: string }[]) {
      const r = await syncPreapprovalAmount(cronAdmin, t.tenant_id, { actorId: null, via: "cron", accessToken });
      results.push({ tenant_id: t.tenant_id, ok: r.ok, reason: r.reason, amount: r.amount });
    }
    return json({ ok: true, checked: results.length, synced: results.filter((r) => r.ok).length, results });
  }

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
  // El dueño suele ser TAMBIÉN staff (is_internal): si no manda tenant_id en el
  // body, cae a su current_tenant_id (gestiona su propia suscripción). Mismo fix
  // que mp_subscription_checkout/manage.
  const ownTenant = String(meta.current_tenant_id ?? "").trim();
  const bodyTenant = String(b.tenant_id ?? "").trim();
  const tenantId = isInternal ? bodyTenant || ownTenant : ownTenant;
  if (!tenantId) return json({ error: "missing_tenant" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // BUG 2 (escalada multi-tenant): el path interno hace un PUT al preapproval que
  // CAMBIA EL MONTO del cobro de CUALQUIER tenant. Sólo niveles con privilegio
  // real (admin/super_admin) pueden apuntar a OTRO tenant; 'support' NO.
  // Espejamos el guard de internal_set_subscription_status. El dueño que gestiona
  // SU propio tenant (bodyTenant vacío → ownTenant) no toca esta barrera.
  const internalLevel = (meta.internal_level ?? "").trim();
  const internalPrivileged =
    internalLevel === "" ||
    internalLevel === "admin" ||
    internalLevel === "super_admin" ||
    internalLevel === "superadmin";
  const targetsOtherTenant = bodyTenant !== "" && bodyTenant !== ownTenant;
  if (isInternal && targetsOtherTenant && !internalPrivileged) {
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "subscriptions",
      entity_id: null,
      action: "subscription_amount_forbidden",
      after_data: { internal_level: internalLevel || null, reason: "insufficient_level" },
    });
    return json({ error: "forbidden" }, 403);
  }

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

  const r = await syncPreapprovalAmount(admin, tenantId, {
    actorId: user.id,
    via: isInternal ? "staff" : "owner",
    force: true,
  });
  if (r.ok) return json({ ok: true, amount: r.amount, preapproval_id: r.preapproval_id });
  if (r.reason === "mp_error" || r.reason === "mp_unreachable") {
    return json({ error: "mp_error", detail: r.detail ?? "" }, 502);
  }
  if (r.reason === "platform_not_configured") return json({ error: "platform_not_configured" }, 400);
  // Sin débito automático (prueba sin autorizar, cuenta corriente, exento) o
  // monto 0: nada que sincronizar; el panel lo explica con `reason`.
  return json({ ok: false, reason: r.reason, amount: r.amount });
});
