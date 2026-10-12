// =============================================================================
// Edge Function: send_email — envía un email del sistema con FAILOVER de proveedores.
// Guard: solo staff (is_internal). Bitácora en system_emails (pending→sent|failed).
//
// Envío: usa email_providers (slot 1 = principal, slot 2 = failover). Por cada slot
// activo intenta enviar; si falla, prueba el siguiente. Por kind:
//   - 'resend' → POST https://api.resend.com/emails (Authorization Bearer api_key).
//   - 'smtp'   → nodemailer (mismo patrón que send_receipt_email: 465→secure,
//                 timeouts, handlers globales para no matar el worker).
// Si NINGÚN proveedor está configurado/activo → fallback al SMTP legacy
// (system_email_smtp, nodemailer) para que nada se rompa.
//
// Esto reemplaza el envío con denomailer (que devolvía 502/timeout): nodemailer +
// resend son los caminos soportados ahora.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { sendWithChain, type SendArgs } from "../_shared/mailer.ts";

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

// El cliente SMTP dispara promesas internas (conexión) que pueden rechazar fuera
// de nuestro await: sin esto, Deno mata el worker (503, deployment_id null) y
// ningún try/catch del handler lo evita. Capturamos a nivel global.
addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", (e as PromiseRejectionEvent).reason);
  (e as PromiseRejectionEvent).preventDefault();
});
addEventListener("error", (e) => {
  console.error("uncaught error:", (e as ErrorEvent).message);
  (e as ErrorEvent).preventDefault();
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
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
    const args: SendArgs = { to, subject, html };

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Bitácora (best-effort: nunca altera la respuesta de la función).
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
          html_content: html,
        })
        .select("id")
        .single();
      logId = logRow?.id ?? null;
    } catch (_) {
      /* noop */
    }

    const { providerUsed, attempts, lastError, noProvider } = await sendWithChain(admin, args);

    if (noProvider) {
      // Ni providers ni SMTP legacy configurados.
      if (logId) {
        await admin
          .from("system_emails")
          .update({
            status: "failed",
            error_message: "Sin proveedor de email configurado.",
          })
          .eq("id", logId)
          .then(() => {}, () => {});
      }
      return json(
        {
          error: "no_provider_configured",
          detail:
            "Configurá un proveedor de email (Resend o SMTP) en /internal/emails.",
        },
        400,
      );
    }

    if (!providerUsed) {
      // Hubo proveedores pero todos fallaron.
      if (logId) {
        await admin
          .from("system_emails")
          .update({
            status: "failed",
            error_message: attempts.join(" | ").slice(0, 500),
          })
          .eq("id", logId)
          .then(() => {}, () => {});
      }
      return json(
        { error: "send_failed", detail: lastError || "todos los proveedores fallaron" },
        502,
      );
    }

    if (logId) {
      await admin
        .from("system_emails")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", logId)
        .then(() => {}, () => {});
    }
    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: user.id,
      entity_type: "email",
      entity_id: null,
      action: "email_sent",
      after_data: { to, subject, provider_used: providerUsed },
    });
    return json({ ok: true, provider_used: providerUsed });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
