// =============================================================================
// Edge Function: staff_admin  (H11)
// Gestión del staff NinjaSoft (super_admin / admin / support) y de cuentas de
// usuario (suspender/reactivar). Solo super_admin asigna niveles; admin o
// super_admin suspenden cuentas. Bootstrap: si no existe ningún super_admin,
// un interno puede autopromoverse a super_admin una vez. service_role solo
// vive acá. Auditado.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
const LEVELS = ["support", "admin", "super_admin"];

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
    error: uErr,
  } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: "unauthorized" }, 401);
  const meta = (user.app_metadata ?? {}) as {
    is_internal?: boolean;
    internal_level?: string;
  };
  if (!meta.is_internal) return json({ error: "forbidden" }, 403);

  let body: {
    action?: string;
    email?: string;
    user_id?: string;
    level?: string | null;
    active?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Resolver usuario objetivo por id o email.
  let target:
    | { id: string; email: string; internal_level: string | null }
    | null = null;
  if (body.user_id) {
    const { data } = await admin
      .from("users")
      .select("id, email, internal_level")
      .eq("id", body.user_id)
      .maybeSingle();
    target = data;
  } else if (body.email) {
    const { data } = await admin
      .from("users")
      .select("id, email, internal_level")
      .eq("email", String(body.email).trim().toLowerCase())
      .maybeSingle();
    target = data;
  }
  if (!target) return json({ error: "user_not_found" }, 404);

  const isSuper = meta.internal_level === "super_admin";
  const isAdmin = isSuper || meta.internal_level === "admin";

  // ---------------------------------------------------------------------------
  // action: set_level — solo super_admin (+ bootstrap del primero)
  // ---------------------------------------------------------------------------
  if (body.action === "set_level") {
    const level =
      body.level === null || body.level === undefined ? null : String(body.level);
    if (level !== null && !LEVELS.includes(level))
      return json({ error: "invalid_level" }, 400);

    if (!isSuper) {
      const { count } = await admin
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("internal_level", "super_admin");
      const bootstrap =
        (count ?? 0) === 0 && target.id === user.id && level === "super_admin";
      if (!bootstrap) return json({ error: "forbidden" }, 403);
    }

    if (isSuper && target.id === user.id && level !== "super_admin") {
      const { count } = await admin
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("internal_level", "super_admin");
      if ((count ?? 0) <= 1)
        return json({ error: "cannot_remove_last_super_admin" }, 400);
    }

    const { error: aErr } = await admin.auth.admin.updateUserById(target.id, {
      app_metadata: { is_internal: level !== null, internal_level: level },
    });
    if (aErr) return json({ error: "auth_update_failed", detail: aErr.message }, 500);
    const { error: mErr } = await admin
      .from("users")
      .update({ internal_level: level, is_internal: level !== null })
      .eq("id", target.id);
    if (mErr) return json({ error: "mirror_failed", detail: mErr.message }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: user.id,
      entity_type: "staff",
      entity_id: target.id,
      action: "staff_level_set",
      after_data: { email: target.email, level },
    });
    return json({ ok: true, email: target.email, level });
  }

  // ---------------------------------------------------------------------------
  // action: set_active — admin o super_admin. Suspende (ban) o reactiva la
  // cuenta. No te suspendés a vos mismo; a un staff solo lo toca un super.
  // ---------------------------------------------------------------------------
  if (body.action === "set_active") {
    if (!isAdmin) return json({ error: "forbidden" }, 403);
    if (typeof body.active !== "boolean")
      return json({ error: "invalid_active" }, 400);
    if (target.id === user.id) return json({ error: "cannot_suspend_self" }, 400);
    if (target.internal_level && !isSuper)
      return json({ error: "only_super_admin_touches_staff" }, 403);

    const { error: aErr } = await admin.auth.admin.updateUserById(target.id, {
      ban_duration: body.active ? "none" : "876600h", // ~100 años
    });
    if (aErr) return json({ error: "auth_update_failed", detail: aErr.message }, 500);
    const { error: mErr } = await admin
      .from("users")
      .update({ suspended_at: body.active ? null : new Date().toISOString() })
      .eq("id", target.id);
    if (mErr) return json({ error: "mirror_failed", detail: mErr.message }, 500);

    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: user.id,
      entity_type: "users",
      entity_id: target.id,
      action: body.active ? "user_reactivated" : "user_suspended",
      after_data: { email: target.email },
    });
    return json({ ok: true, email: target.email, active: body.active });
  }

  return json({ error: "unknown_action" }, 400);
});
