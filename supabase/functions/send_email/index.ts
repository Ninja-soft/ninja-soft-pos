// =============================================================================
// Edge Function: send_email — envía email del sistema por SMTP propio (denomailer).
// Guard: solo staff (is_internal). Config desde system_email_smtp (service_role).
// Sin secrets de backend: el SMTP se configura desde /internal/emails.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  let b: { to?: string; subject?: string; html?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const to = String(b.to ?? "").trim().toLowerCase();
  const subject = String(b.subject ?? "").trim();
  const html = String(b.html ?? "");
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
  if (!subject) return json({ error: "missing_subject" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: cfg } = await admin
    .from("system_email_smtp")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (!cfg?.host || !cfg?.from_email)
    return json(
      { error: "smtp_not_configured", detail: "Configura el SMTP en /internal/emails." },
      400,
    );

  const client = new SMTPClient({
    connection: {
      hostname: cfg.host,
      port: cfg.port || 587,
      tls: !!cfg.secure,
      auth: cfg.username ? { username: cfg.username, password: cfg.password } : undefined,
    },
  });

  // Bitácora de envíos (best-effort: nunca altera la respuesta de la función).
  let logId: string | null = null;
  try {
    const { data: logRow } = await admin
      .from("system_emails")
      .insert({
        tenant_id: null,
        recipient: to,
        subject,
        kind: "system",
        status: "pending",
      })
      .select("id")
      .single();
    logId = logRow?.id ?? null;
  } catch (_) {
    /* noop */
  }

  try {
    await client.send({
      from: `${cfg.from_name || "NinjaPos"} <${cfg.from_email}>`,
      to,
      subject,
      content: "Este mensaje se ve mejor con un cliente que soporte HTML.",
      html,
    });
    await client.close();
  } catch (e) {
    try {
      await client.close();
    } catch (_) {
      /* noop */
    }
    if (logId) {
      try {
        await admin
          .from("system_emails")
          .update({
            status: "failed",
            error_message: String(e).slice(0, 500),
          })
          .eq("id", logId);
      } catch (_) {
        /* noop */
      }
    }
    return json(
      { error: "send_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }
  if (logId) {
    try {
      await admin
        .from("system_emails")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", logId);
    } catch (_) {
      /* noop */
    }
  }
  await admin.from("audit_logs").insert({
    tenant_id: null,
    actor_user_id: user.id,
    entity_type: "email",
    entity_id: null,
    action: "email_sent",
    after_data: { to, subject },
  });
  return json({ ok: true });
});
