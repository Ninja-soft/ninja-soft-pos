// =============================================================================
// Edge Function: internal_tenant_members  (F7 · H11c, ADR-084)
// Miembros de un negocio desde el panel interno, en lo que necesita la API de
// administración de Auth (service_role):
//   invite        {tenant_id, email, role, display_name?, reason, origin?}
//   resend_invite {tenant_id, user_id, reason, origin?}
//   reset_access  {tenant_id, user_id, reason, origin?}
// Cambiar rol, suspender y reactivar van directo a la RPC internal_member_admin.
// reset_access también pasa por esa RPC (con el JWT del staff y el header de
// scope interno): corta las sesiones, valida nivel y motivo y audita; después
// se manda el email de recupero con la Edge send_password_recovery.
// Guard: staff interno; soporte sólo resetea el acceso (matriz H11). Todo con
// motivo y en audit_logs ANTES de responder.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import {
  canStaffDo,
  cleanReason,
  isUuid,
  parseInviteMemberInput,
  type StaffLevel,
} from "../_shared/tenantMembers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ninja-scope",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const DEFAULT_ORIGIN = "https://pos.soft.ninja";
const ALLOWED_ORIGINS = [
  /^https:\/\/pos\.soft\.ninja$/,
  /^https:\/\/ninja-soft-pos(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/localhost:\d+$/,
];
function safeOrigin(raw: unknown): string {
  const o = String(raw ?? "");
  return ALLOWED_ORIGINS.some((re) => re.test(o)) ? o : DEFAULT_ORIGIN;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // Cliente con el JWT del staff y el scope interno: las RPC validan nivel y
  // auditan con auth.uid() del staff.
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader, "x-ninja-scope": "internal" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: uErr,
  } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: "unauthorized" }, 401);

  const meta = (user.app_metadata ?? {}) as { is_internal?: boolean; internal_level?: string };
  if (!meta.is_internal) return json({ error: "forbidden" }, 403);
  const lv = meta.internal_level;
  const level: StaffLevel =
    lv === "super_admin" || lv === "admin" || lv === "support" ? lv : "admin";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(body.action ?? "");
  if (!["invite", "resend_invite", "reset_access"].includes(action)) {
    return json({ error: "unknown_action" }, 400);
  }
  if (!canStaffDo(level, action as "invite")) return json({ error: "forbidden" }, 403);
  const origin = safeOrigin(body.origin);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  async function audit(name: string, tenantId: string, entityId: string | null, after: unknown, reason: string) {
    return await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user!.id,
      entity_type: "tenant_users",
      entity_id: entityId,
      action: name,
      after_data: after as never,
      reason,
    });
  }

  async function tenantAlive(id: string): Promise<boolean> {
    const { data } = await admin.from("tenants").select("id, deleted_at").eq("id", id).maybeSingle();
    return Boolean(data && !data.deleted_at);
  }

  try {
    // -------------------------------------------------------------------------
    // invite
    // -------------------------------------------------------------------------
    if (action === "invite") {
      const parsed = parseInviteMemberInput(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { tenantId, email, role, displayName, reason } = parsed.value;
      if (!(await tenantAlive(tenantId))) return json({ error: "tenant_not_found" }, 404);

      if (role === "owner") {
        if (level !== "super_admin") return json({ error: "forbidden_super_admin_only" }, 403);
        const { count: owners } = await admin
          .from("tenant_users")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("role", "owner")
          .eq("status", "active");
        if ((owners ?? 0) > 0) return json({ error: "owner_exists" }, 409);
      }

      const { data: existingUser } = await admin
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      if (existingUser) {
        const { data: m } = await admin
          .from("tenant_users")
          .select("status")
          .eq("tenant_id", tenantId)
          .eq("user_id", existingUser.id)
          .maybeSingle();
        if (m?.status === "active") return json({ error: "already_member" }, 409);
        if (m?.status === "invited") return json({ error: "already_invited" }, 409);
        if (m?.status === "suspended") return json({ error: "member_suspended" }, 409);
        if (m?.status === "inactive") return json({ error: "member_terminated" }, 409);
      }

      // Límite de usuarios del plan (override ?? plan), igual que invite_user.
      const { count: activeCount } = await admin
        .from("tenant_users")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "active");
      const { data: sub } = await admin
        .from("subscriptions")
        .select("limit_overrides, plans(limits)")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const overrideRaw = (sub?.limit_overrides as Record<string, unknown> | null)?.["max_users"];
      const planLimits = ((sub?.plans as { limits?: Record<string, unknown> } | null)?.limits ??
        {}) as Record<string, unknown>;
      const planRaw = (planLimits["limits"] as Record<string, unknown> | undefined)?.["max_users"];
      const rawLimit = overrideRaw ?? planRaw;
      const maxUsers = rawLimit === undefined || rawLimit === null ? null : Number(rawLimit);
      if (maxUsers !== null && !Number.isNaN(maxUsers) && (activeCount ?? 0) >= maxUsers) {
        return json({ error: "limit_reached", detail: `max_users=${maxUsers}` }, 403);
      }

      let targetId = existingUser?.id ?? null;
      let invited = false;
      if (!targetId) {
        const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
          redirectTo: `${origin}/login`,
        });
        if (invErr || !inv?.user) return json({ error: "invite_failed", detail: invErr?.message }, 500);
        targetId = inv.user.id;
        invited = true;
        // El trigger de alta crea public.users; por las dudas se asegura la fila.
        await admin.from("users").upsert({ id: targetId, email }, { onConflict: "id", ignoreDuplicates: true });
      }

      const now = new Date().toISOString();
      const { error: muErr } = await admin.from("tenant_users").upsert(
        {
          tenant_id: tenantId,
          user_id: targetId,
          role,
          status: "active",
          display_name: displayName,
          invited_at: now,
          joined_at: now,
        },
        { onConflict: "tenant_id,user_id" },
      );
      if (muErr) return json({ error: "membership_failed", detail: muErr.message }, 500);

      // Sin current_tenant_id la RLS le niega todo (ADR-051, B-01).
      const { data: target } = await admin.auth.admin.getUserById(targetId!);
      const tMeta = (target?.user?.app_metadata ?? {}) as Record<string, unknown>;
      if (!tMeta.current_tenant_id) {
        await admin.auth.admin.updateUserById(targetId!, {
          app_metadata: { ...tMeta, current_tenant_id: tenantId },
        });
      }

      const { error: aErr } = await audit(
        "member_invited_internal",
        tenantId,
        targetId,
        { email, role, display_name: displayName, invited_by_email: invited },
        reason,
      );
      if (aErr) return json({ error: "audit_failed" }, 500);
      return json({ ok: true, user_id: targetId, invited });
    }

    // Acciones sobre un miembro existente.
    if (!isUuid(body.tenant_id) || !isUuid(body.user_id)) return json({ error: "missing_ids" }, 400);
    const tenantId = body.tenant_id as string;
    const targetId = body.user_id as string;
    const reason = cleanReason(body.reason);
    if (!reason) return json({ error: "reason_required" }, 400);
    if (targetId === user.id) return json({ error: "cannot_change_self" }, 400);

    const { data: member } = await admin
      .from("tenant_users")
      .select("status, users(email)")
      .eq("tenant_id", tenantId)
      .eq("user_id", targetId)
      .maybeSingle();
    if (!member) return json({ error: "member_not_found" }, 404);
    const email = (member as unknown as { users: { email: string } | null }).users?.email ?? null;
    if (!email) return json({ error: "member_not_found" }, 404);

    // -------------------------------------------------------------------------
    // resend_invite
    // -------------------------------------------------------------------------
    if (action === "resend_invite") {
      if (member.status === "inactive") return json({ error: "member_terminated" }, 409);
      const { data: au } = await admin.auth.admin.getUserById(targetId);
      if (au?.user?.email_confirmed_at || au?.user?.last_sign_in_at) {
        return json({ error: "already_confirmed" }, 409);
      }
      const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${origin}/login`,
      });
      if (invErr) return json({ error: "invite_failed", detail: invErr.message }, 500);
      const { error: aErr } = await audit("member_invite_resent", tenantId, targetId, { email }, reason);
      if (aErr) return json({ error: "audit_failed" }, 500);
      return json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // reset_access: RPC (corta sesiones + audita) y después el email.
    // -------------------------------------------------------------------------
    const { error: rpcErr } = await userClient.rpc("internal_member_admin", {
      p_tenant: tenantId,
      p_user: targetId,
      p_action: "reset_access",
      p_role: null,
      p_reason: reason,
    });
    if (rpcErr) return json({ error: rpcErr.message }, 400);

    const r = await fetch(`${url}/functions/v1/send_password_recovery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ email, origin }),
    }).catch(() => null);
    return json({ ok: true, email_sent: Boolean(r?.ok) });
  } catch (e) {
    return json({ error: "internal", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
