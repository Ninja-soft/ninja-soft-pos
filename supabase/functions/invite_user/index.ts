// =============================================================================
// Edge Function: invite_user  (H11b)
// Alta de un usuario CON LOGIN al tenant del dueño/encargado. Ver docs/06.
//   1. Valida JWT y que el llamador sea owner/manager activo del tenant.
//   2. Invita por email (o reusa si ya existe) y crea/activa la membresía con
//      rol, nombre visible (real o genérico) y avatar.
//   3. Audita. service_role solo vive acá (nunca en frontend).
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
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const role = body.role ?? "";
  const displayName = (body.display_name ?? "").trim().slice(0, 80) || null;
  const avatar = (body.avatar ?? "").trim().slice(0, 40) || null;
  if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  if (!ASSIGNABLE_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);

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

  let targetId: string | null = null;
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
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

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "tenant_users",
    entity_id: targetId,
    action: "member_invited",
    after_data: { email, role, display_name: displayName, avatar },
  });
  return json({ user_id: targetId, role, existed: !!existing });
});
