// =============================================================================
// Edge Function: send_email — envía un email del sistema vía Resend.
// Guard: solo staff NinjaSoft (is_internal). Remitente desde system_email_config.
// Requiere el secret RESEND_API_KEY en el proyecto Supabase. service_role solo acá.
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
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
  if (!(user.app_metadata ?? {}).is_internal) return json({ error: "forbidden" }, 403);
  if (!resendKey)
    return json(
      { error: "missing_resend_key", detail: "Configura el secret RESEND_API_KEY en Supabase." },
      400,
    );

  let body: { to?: string; subject?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const to = String(body.to ?? "").trim().toLowerCase();
  const subject = String(body.subject ?? "").trim();
  const html = String(body.html ?? "");
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
  if (!subject) return json({ error: "missing_subject" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: cfg } = await admin
    .from("system_email_config")
    .select("from_name, from_email")
    .eq("id", true)
    .maybeSingle();
  if (!cfg?.from_email || !EMAIL_RE.test(cfg.from_email))
    return json(
      { error: "missing_sender", detail: "Configura el remitente en /internal/emails." },
      400,
    );
  const from = `${cfg.from_name || "NinjaPos"} <${cfg.from_email}>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: "send_failed", detail: out }, 502);

  await admin.from("audit_logs").insert({
    tenant_id: null,
    actor_user_id: user.id,
    entity_type: "email",
    entity_id: null,
    action: "email_sent",
    after_data: { to, subject },
  });
  return json({ ok: true, id: (out as { id?: string }).id ?? null });
});
