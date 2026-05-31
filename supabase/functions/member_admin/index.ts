// =============================================================================
// Edge Function: member_admin  (H11b)
// Gestión de miembros del negocio por el dueño/encargado. Ver docs/06 y roadmap H11b.
// Acciones (body.action):
//   update_member       {user_id, display_name?, avatar?, role?}
//   set_member_status    {user_id, status: active|suspended}
//   create_profile       {display_name, avatar?, pin?}   -> cajero SIN login
//   update_profile       {profile_id, display_name?, avatar?, pin?}
//   set_profile_status   {profile_id, status: active|suspended}
// Guard: el llamador debe ser owner/manager activo del tenant del JWT.
// service_role solo vive acá. Todo se audita.
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
const ASSIGNABLE_ROLES = ["owner", "manager", "cashier", "viewer"];
const clip = (s: unknown, n: number) =>
  typeof s === "string" ? s.trim().slice(0, n) : "";

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`ninjapos:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = String(body.action ?? "");

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
  const isOwner = caller.role === "owner";

  async function audit(name: string, entityId: string | null, after: unknown) {
    await admin.from("audit_logs").insert({
      tenant_id: tenantId,
      actor_user_id: user.id,
      entity_type: "member",
      entity_id: entityId,
      action: name,
      after_data: after as never,
    });
  }

  try {
    if (action === "update_member") {
      const targetId = String(body.user_id ?? "");
      if (!targetId) return json({ error: "missing_user_id" }, 400);
      const patch: Record<string, unknown> = {};
      if (body.display_name !== undefined)
        patch.display_name = clip(body.display_name, 80) || null;
      if (body.avatar !== undefined) patch.avatar = clip(body.avatar, 300) || null;
      if (body.role !== undefined) {
        const role = String(body.role);
        if (!ASSIGNABLE_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);
        if ((role === "owner" || targetId === user.id) && !isOwner)
          return json({ error: "forbidden_role" }, 403);
        patch.role = role;
      }
      if (Object.keys(patch).length === 0)
        return json({ error: "nothing_to_update" }, 400);
      const { error } = await admin
        .from("tenant_users")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("user_id", targetId);
      if (error) return json({ error: "update_failed", detail: error.message }, 500);
      await audit("member_updated", targetId, patch);
      return json({ ok: true });
    }

    if (action === "set_member_status") {
      const targetId = String(body.user_id ?? "");
      const status = String(body.status ?? "");
      if (!["active", "suspended"].includes(status))
        return json({ error: "invalid_status" }, 400);
      if (targetId === user.id) return json({ error: "cannot_change_self" }, 400);
      const { error } = await admin
        .from("tenant_users")
        .update({ status })
        .eq("tenant_id", tenantId)
        .eq("user_id", targetId);
      if (error) return json({ error: "update_failed", detail: error.message }, 500);
      await audit("member_status_changed", targetId, { status });
      return json({ ok: true });
    }

    if (action === "create_profile") {
      const displayName = clip(body.display_name, 80);
      if (!displayName) return json({ error: "missing_display_name" }, 400);
      const avatar = clip(body.avatar, 300) || null;
      const pin = clip(body.pin, 12);
      const pin_hash = pin ? await hashPin(pin) : null;
      const { data, error } = await admin
        .from("cashier_profiles")
        .insert({ tenant_id: tenantId, display_name: displayName, avatar, pin_hash })
        .select("id")
        .single();
      if (error) return json({ error: "create_failed", detail: error.message }, 500);
      await audit("profile_created", data.id, { display_name: displayName, avatar });
      return json({ ok: true, id: data.id });
    }

    if (action === "update_profile") {
      const profileId = String(body.profile_id ?? "");
      if (!profileId) return json({ error: "missing_profile_id" }, 400);
      const patch: Record<string, unknown> = {};
      if (body.display_name !== undefined)
        patch.display_name = clip(body.display_name, 80);
      if (body.avatar !== undefined) patch.avatar = clip(body.avatar, 300) || null;
      if (body.pin !== undefined) {
        const pin = clip(body.pin, 12);
        patch.pin_hash = pin ? await hashPin(pin) : null;
      }
      if (Object.keys(patch).length === 0)
        return json({ error: "nothing_to_update" }, 400);
      const { error } = await admin
        .from("cashier_profiles")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", profileId);
      if (error) return json({ error: "update_failed", detail: error.message }, 500);
      await audit("profile_updated", profileId, {
        display_name: patch.display_name,
        avatar: patch.avatar,
      });
      return json({ ok: true });
    }

    if (action === "set_profile_status") {
      const profileId = String(body.profile_id ?? "");
      const status = String(body.status ?? "");
      if (!["active", "suspended"].includes(status))
        return json({ error: "invalid_status" }, 400);
      const { error } = await admin
        .from("cashier_profiles")
        .update({ status })
        .eq("tenant_id", tenantId)
        .eq("id", profileId);
      if (error) return json({ error: "update_failed", detail: error.message }, 500);
      await audit("profile_status_changed", profileId, { status });
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json(
      { error: "internal", detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});
