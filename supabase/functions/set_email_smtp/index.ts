// =============================================================================
// Edge Function: set_email_smtp — guarda la config SMTP del sistema. Solo staff.
// Si password viene vacío, NO se sobrescribe. service_role solo acá.
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
  if (!(user.app_metadata ?? {}).is_internal) return json({ error: "forbidden" }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const patch: Record<string, unknown> = {
    host: String(b.host ?? "").trim(),
    port: Number(b.port) || 587,
    secure: !!b.secure,
    username: String(b.username ?? "").trim(),
    from_name: String(b.from_name ?? "NinjaPos").trim().slice(0, 80),
    from_email: String(b.from_email ?? "").trim().toLowerCase(),
  };
  const pwd = typeof b.password === "string" ? b.password : "";
  const row = pwd ? { id: true, ...patch, password: pwd } : { id: true, ...patch };
  const { error: upErr } = await admin
    .from("system_email_smtp")
    .upsert(row, { onConflict: "id" });
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);
  await admin.from("audit_logs").insert({
    tenant_id: null,
    actor_user_id: user.id,
    entity_type: "email_smtp",
    entity_id: null,
    action: "smtp_configured",
    after_data: { host: patch.host, from_email: patch.from_email },
  });
  return json({ ok: true });
});
