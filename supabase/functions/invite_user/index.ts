// =============================================================================
// Edge Function: invite_user  (H11b)
// Alta de un usuario CON LOGIN al tenant del dueño/encargado. Ver docs/06.
//   1. Valida JWT y que el llamador sea owner/manager activo del tenant.
//   2. Invita por email (o reusa si ya existe) y crea/activa la membresía con
//      rol, nombre visible (real o genérico) y avatar.
//   3. Audita. service_role solo vive acá (nunca en frontend).
//   4. (F17 · H91) Opcional: `store_ids` (y `store_role`) asigna sucursales de
//      una vez: la primera como base y el resto como acceso adicional, vía
//      staff_assign_on_invite (valida negocio, sucursales vivas, alcance del
//      que invita y la feature multi_sucursal, y audita). Sin `store_ids` el
//      body viejo funciona igual.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const ASSIGNABLE_ROLES = ["manager", "cashier", "viewer"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);
  const tenantId = (user.app_metadata ?? {}).current_tenant_id as
    | string
    | undefined;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let body: {
    email?: string;
    role?: string;
    display_name?: string;
    avatar?: string;
    store_ids?: unknown;
    store_role?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role ?? "";
  const displayName = (body.display_name ?? "").trim().slice(0, 80) || null;
  const avatar = (body.avatar ?? "").trim().slice(0, 300) || null;
  if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  if (!ASSIGNABLE_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawStores = Array.isArray(body.store_ids) ? body.store_ids : [];
  if (rawStores.some((v) => typeof v !== "string" || !UUID_RE.test(v)) || rawStores.length > 50) {
    return json({ error: "invalid_store" }, 400);
  }
  const storeIds = [...new Set(rawStores as string[])];
  const storeRole = body.store_role ? String(body.store_role) : null;
  if (storeRole && !ASSIGNABLE_ROLES.includes(storeRole)) {
    return json({ error: "invalid_role" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: caller } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!caller || !["owner", "manager"].includes(caller.role)) {
    return json({ error: "forbidden" }, 403);
  }
  // ADR-051: sólo el dueño suma encargados.
  if (role === "manager" && caller.role !== "owner") {
    return json({ error: "forbidden_role" }, 403);
  }

  // Sucursales: se validan ANTES de invitar (que no quede un usuario creado
  // con sucursales inválidas). La función SQL vuelve a validar todo.
  if (storeIds.length > 0) {
    const { data: stores } = await admin
      .from("stores")
      .select("id")
      .eq("tenant_id", tenantId)
      .is("deleted_at", null)
      .in("id", storeIds);
    if ((stores ?? []).length !== storeIds.length) return json({ error: "store_not_found" }, 400);
  }

  // Gating server-side (Fase D): enforcement del límite max_users del plan.
  // Replica inline la resolución de tenant_limit (override H12b ?? plan) porque
  // la función corre con service_role (sin current_tenant_id del JWT). null =
  // ilimitado → no se bloquea. Se compara contra los miembros activos actuales;
  // se omite el chequeo si el target ya es miembro activo (no consume cupo nuevo).
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
  const planLimits = ((sub?.plans as { limits?: Record<string, unknown> } | null)?.limits ?? {}) as
    Record<string, unknown>;
  const planRaw = (planLimits["limits"] as Record<string, unknown> | undefined)?.["max_users"];
  const rawLimit = overrideRaw ?? planRaw;
  const maxUsers =
    rawLimit === undefined || rawLimit === null ? null : Number(rawLimit);

  // ¿el target ya es miembro activo? entonces no suma asiento.
  let targetAlreadyActive = false;
  let existingRole: string | null = null;
  let existingStatus: string | null = null;
  const { data: targetUser } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (targetUser) {
    const { data: existingMembership } = await admin
      .from("tenant_users")
      .select("status, role")
      .eq("tenant_id", tenantId)
      .eq("user_id", targetUser.id)
      .maybeSingle();
    targetAlreadyActive = existingMembership?.status === "active";
    existingRole = existingMembership?.role ?? null;
    existingStatus = existingMembership?.status ?? null;
  }

  // ADR-051: invitar NO pisa a un miembro existente (antes un upsert podía
  // degradar al dueño). Un miembro activo se informa tal cual; uno dado de baja
  // vuelve por "Reingreso" (queda en su historial), no por invitación.
  if (existingRole === "owner" || targetAlreadyActive) {
    return json({ error: "already_member", role: existingRole }, 409);
  }
  if (existingStatus === "inactive") {
    return json({ error: "member_terminated" }, 409);
  }

  if (
    maxUsers !== null &&
    !Number.isNaN(maxUsers) &&
    !targetAlreadyActive &&
    (activeCount ?? 0) >= maxUsers
  ) {
    return json(
      {
        error: "limit_reached",
        detail: `Tu plan permite hasta ${maxUsers} usuarios.`,
      },
      403,
    );
  }

  const existing = targetUser;
  let targetId: string | null = targetUser?.id ?? null;
  if (existing) {
    targetId = existing.id;
  } else {
    const redirectTo = `${Deno.env.get("PUBLIC_SITE_URL") ?? ""}/login`;
    const { data: invited, error: invErr } =
      await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (invErr || !invited?.user) {
      return json({ error: "invite_failed", detail: invErr?.message }, 500);
    }
    targetId = invited.user.id;
  }

  const { error: muErr } = await admin.from("tenant_users").upsert(
    {
      tenant_id: tenantId,
      user_id: targetId,
      role,
      status: "active",
      display_name: displayName,
      avatar,
      joined_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,user_id" },
  );
  if (muErr) return json({ error: "membership_failed", detail: muErr.message }, 500);

  // ADR-051 (B-01): sin app_metadata.current_tenant_id la RLS le niega todo al
  // invitado. Se setea sólo si no tiene otro negocio activo.
  if (targetId) {
    const { data: target } = await admin.auth.admin.getUserById(targetId);
    const meta = (target?.user?.app_metadata ?? {}) as Record<string, unknown>;
    if (!meta.current_tenant_id) {
      await admin.auth.admin.updateUserById(targetId, {
        app_metadata: { ...meta, current_tenant_id: tenantId },
      });
    }
  }

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "tenant_users",
    entity_id: targetId,
    action: "member_invited",
    after_data: { email, role, display_name: displayName, avatar, store_ids: storeIds },
  });

  // Sucursales asignadas al invitar. Si falla (p. ej. el plan no tiene
  // multi_sucursal), la membresía ya quedó: se informa para asignarlas a mano.
  let branchesAssigned = 0;
  let branchesError: string | null = null;
  if (storeIds.length > 0) {
    const { data: n, error: brErr } = await admin.rpc("staff_assign_on_invite", {
      p_tenant: tenantId,
      p_actor: user.id,
      p_user: targetId,
      p_store_ids: storeIds,
      p_role: storeRole,
    });
    if (brErr) branchesError = brErr.message.slice(0, 200);
    else branchesAssigned = Number(n) || 0;
  }
  return json({
    user_id: targetId,
    role,
    existed: !!existing,
    branches_assigned: branchesAssigned,
    branches_error: branchesError,
  });
});
