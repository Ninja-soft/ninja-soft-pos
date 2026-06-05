// =============================================================================
// Edge Function: internal_impersonate  (H11c)
// Genera un magic link de acceso para el dueño de un tenant. Solo admin y
// super_admin pueden usarlo (support: denegado). El link se abre en incógnito
// para no cerrar la sesión del staff. Auditado.
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
  if (meta.internal_level === "support")
    return json({ error: "forbidden_support_level" }, 403);

  let body: { tenant_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.tenant_id) return json({ error: "missing_tenant_id" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Buscar el owner del tenant; fallback a cualquier miembro.
  type TuRow = {
    user_id: string;
    users: { email: string } | null;
  };
  const { data: ownerRow } = await admin
    .from("tenant_users")
    .select("user_id, users(email)")
    .eq("tenant_id", body.tenant_id)
    .eq("role", "owner")
    .maybeSingle();

  let ownerEmail: string | null = (ownerRow as unknown as TuRow | null)?.users?.email ?? null;

  if (!ownerEmail) {
    const { data: anyRow } = await admin
      .from("tenant_users")
      .select("user_id, users(email)")
      .eq("tenant_id", body.tenant_id)
      .limit(1)
      .maybeSingle();
    ownerEmail = (anyRow as unknown as TuRow | null)?.users?.email ?? null;
  }
  if (!ownerEmail) return json({ error: "tenant_owner_not_found" }, 404);

  // Generar magic link con service_role.
  const { data: linkData, error: linkErr } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ownerEmail,
    });
  if (linkErr)
    return json({ error: "link_generation_failed", detail: linkErr.message }, 500);

  await admin.from("audit_logs").insert({
    tenant_id: body.tenant_id,
    actor_user_id: user.id,
    entity_type: "impersonation",
    entity_id: body.tenant_id,
    action: "impersonation_link_generated",
    after_data: { owner_email: ownerEmail, actor_email: user.email },
  });

  return json({
    ok: true,
    action_link: linkData.properties.action_link,
    owner_email: ownerEmail,
  });
});
