// =============================================================================
// Edge Function: process_pending_emails — envía los emails del sistema en cola.
// Lee system_emails (kind 'system', status 'pending', con html_content) y los
// despacha por el SMTP del SISTEMA (system_email_smtp). Actualiza sent/failed +
// audita. Guard: solo staff (is_internal). Pensada para el botón "Procesar
// pendientes" de /internal/emails y para automatización futura (pg_cron + pg_net).
//
// Espeja send_receipt_email: nodemailer + timeouts + handlers globales (los que
// evitan que una promesa SMTP colgada mate al worker → 503 deployment_id null).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
// @ts-ignore tipos de nodemailer no resuelven en Deno; el archivo está excluido del tsconfig.
import nodemailer from "npm:nodemailer@6.9.16";

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

// Cuántos emails procesar por invocación (evita timeouts del worker).
const BATCH = 25;

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

// Carrera contra un timeout: si la promesa SMTP no resuelve a tiempo, rechaza.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Guard: solo staff interno (mirror send_email).
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

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // SMTP del sistema.
    const { data: cfg } = await admin
      .from("system_email_smtp")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (!cfg?.host || !cfg?.from_email)
      return json(
        { error: "smtp_not_configured", detail: "Configurá el SMTP en /internal/emails." },
        400,
      );

    // Cola: emails del sistema pendientes con cuerpo HTML.
    const { data: pending } = await admin
      .from("system_emails")
      .select("id, recipient, subject, html_content")
      .eq("kind", "system")
      .eq("status", "pending")
      .not("html_content", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    const rows = pending ?? [];
    if (rows.length === 0) return json({ processed: 0, sent: 0, failed: 0 });

    // Hardening de puerto/TLS: 465 = SSL directo; 587 = STARTTLS.
    const smtpPort = cfg.port || 587;
    const smtpTls = smtpPort === 465 ? true : !!cfg.secure;
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: smtpPort,
      secure: smtpTls,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    const fromName = String(cfg.from_name || "NinjaPos").replace(/"/g, "");

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await withTimeout(
          transporter.sendMail({
            from: `"${fromName}" <${cfg.from_email}>`,
            to: row.recipient,
            subject: row.subject,
            text: "Este mensaje se ve mejor con un cliente que soporte HTML.",
            html: row.html_content ?? "",
          }),
          25000,
          "smtp_send",
        );
        await admin
          .from("system_emails")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
        sent += 1;
      } catch (e) {
        await admin
          .from("system_emails")
          .update({ status: "failed", error_message: String(e).slice(0, 500) })
          .eq("id", row.id);
        failed += 1;
      }
    }
    try {
      transporter.close();
    } catch (_) {
      /* noop */
    }

    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: user.id,
      entity_type: "email",
      entity_id: null,
      action: "pending_emails_processed",
      after_data: { processed: rows.length, sent, failed },
    });

    return json({ processed: rows.length, sent, failed });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
