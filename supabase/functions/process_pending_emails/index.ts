// =============================================================================
// Edge Function: process_pending_emails — DESPACHA la cola de emails del sistema.
//
// Lee system_emails (kind 'system') que estén:
//   • status 'pending'  (recién encolados por dunning / webhooks / alta / addons), o
//   • status 'failed'   con next_attempt_at ya cumplido y attempts < MAX_ATTEMPTS
//                        (reintento con backoff).
// y los envía usando la MISMA cadena de proveedores que send_email:
//   email_providers slot 1 → slot 2 → SMTP legacy (system_email_smtp).
//   - 'resend' → POST https://api.resend.com/emails.
//   - 'smtp'   → nodemailer (465→secure, timeouts, handlers globales).
// Actualiza status (sent|failed) + attempts/last_attempt_at/next_attempt_at + audita.
//
// AUTH (dos caminos):
//   1. Staff interno: Authorization con el JWT de un usuario is_internal (el botón
//      "Procesar pendientes" de /internal/emails).
//   2. Cron: header X-Cron-Secret == platform_secrets('internal_cron').token. Lo
//      usa el job pg_cron + pg_net (cada 5 min) para el auto-envío. El JWT que
//      acompaña es el anon key (solo para pasar el gateway; verify_jwt=true).
// NO expone service_role.
//
// Espeja send_email/send_receipt_email: nodemailer + timeouts + handlers globales
// (evitan que una promesa SMTP colgada mate al worker → 503 deployment_id null).
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
// @ts-ignore tipos de nodemailer no resuelven en Deno; el archivo está excluido del tsconfig.
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Cuántos emails procesar por invocación (evita timeouts del worker).
const BATCH = 25;
// Tope de intentos antes de dejar un email definitivamente en 'failed'.
const MAX_ATTEMPTS = 5;
// Backoff (minutos) por número de intento ya hecho: 1→5min, 2→15, 3→60, 4→360, 5→1440.
const BACKOFF_MIN = [5, 15, 60, 360, 1440];

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

interface SendArgs {
  to: string;
  subject: string;
  html: string;
}

// Sin caracteres de control en el nombre (viaja en headers); evita header injection.
function safeFromName(name: string): string {
  return (
    // deno-lint-ignore no-control-regex
    (name || "NinjaPos").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/"/g, "").trim() ||
    "NinjaPos"
  );
}

// --- Resend ----------------------------------------------------------------
async function sendViaResend(
  apiKey: string,
  fromName: string,
  fromEmail: string,
  { to, subject, html }: SendArgs,
): Promise<void> {
  const from = `${safeFromName(fromName)} <${fromEmail}>`;
  const res = await withTimeout(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    }),
    20000,
    "resend",
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend_${res.status}: ${detail.slice(0, 300)}`);
  }
}

// --- SMTP (nodemailer) -----------------------------------------------------
async function sendViaSmtp(
  cfg: {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    pass: string | null;
  },
  fromName: string,
  fromEmail: string,
  { to, subject, html }: SendArgs,
): Promise<void> {
  // 465 = SSL directo (forzar tls); 587 = STARTTLS (nodemailer lo negocia solo).
  const port = cfg.port || 587;
  const secure = port === 465 ? true : !!cfg.secure;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? "" } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    await withTimeout(
      transporter.sendMail({
        from: `"${safeFromName(fromName)}" <${fromEmail}>`,
        to,
        subject,
        text: "Este mensaje se ve mejor con un cliente que soporte HTML.",
        html,
      }),
      25000,
      "smtp_send",
    );
  } finally {
    try {
      transporter.close();
    } catch (_) {
      /* noop */
    }
  }
}

// Proveedor candidato ya normalizado, en orden de prioridad (mirror send_email).
interface ProviderRow {
  slot: number;
  kind: string;
  is_active: boolean;
  api_key: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  smtp_user: string | null;
  smtp_pass: string | null;
  from_name: string | null;
  from_email: string | null;
}

interface LegacySmtp {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string | null;
  password?: string | null;
  from_name?: string | null;
  from_email?: string | null;
}

// Envía un email recorriendo la cadena de proveedores (slot1→slot2→legacy).
// Devuelve la etiqueta del proveedor usado, o lanza con el detalle acumulado.
async function sendWithProviders(
  candidates: ProviderRow[],
  legacy: LegacySmtp | null,
  args: SendArgs,
): Promise<string> {
  const attempts: string[] = [];
  for (const p of candidates) {
    const label = `${p.kind}#${p.slot}`;
    try {
      if (p.kind === "resend") {
        await sendViaResend(p.api_key!, p.from_name ?? "NinjaPos", p.from_email!, args);
      } else {
        await sendViaSmtp(
          {
            host: p.smtp_host!,
            port: p.smtp_port ?? 587,
            secure: !!p.smtp_secure,
            user: p.smtp_user,
            pass: p.smtp_pass,
          },
          p.from_name ?? "NinjaPos",
          p.from_email!,
          args,
        );
      }
      return label;
    } catch (e) {
      attempts.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Fallback: SMTP legacy (system_email_smtp).
  if (legacy?.host && legacy?.from_email) {
    try {
      await sendViaSmtp(
        {
          host: legacy.host,
          port: legacy.port ?? 587,
          secure: !!legacy.secure,
          user: legacy.username ?? null,
          pass: legacy.password ?? null,
        },
        legacy.from_name ?? "NinjaPos",
        legacy.from_email,
        args,
      );
      return "smtp#legacy";
    } catch (e) {
      attempts.push(`smtp#legacy: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    attempts.length ? attempts.join(" | ") : "Sin proveedor de email configurado.",
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // --- AUTH: secreto del cron O JWT de staff interno -----------------------
    const cronSecret = req.headers.get("X-Cron-Secret") ?? "";
    let actorId: string | null = null;
    let viaCron = false;

    if (cronSecret) {
      const { data: sec } = await admin
        .from("platform_secrets")
        .select("secrets")
        .eq("key", "internal_cron")
        .maybeSingle();
      const token = (sec?.secrets as { token?: string } | null)?.token ?? "";
      if (token && cronSecret === token) {
        viaCron = true;
      } else {
        return json({ error: "forbidden" }, 403);
      }
    } else {
      // Camino staff: validar JWT is_internal (mirror send_email).
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
      actorId = user.id;
    }

    // --- Cadena de proveedores (idéntica a send_email) -----------------------
    const { data: providers } = await admin
      .from("email_providers")
      .select("*")
      .order("slot", { ascending: true });
    const candidates = ((providers ?? []) as ProviderRow[]).filter((p) => {
      if (!p.is_active || !p.from_email) return false;
      if (p.kind === "resend") return !!p.api_key;
      if (p.kind === "smtp") return !!p.smtp_host;
      return false;
    });
    const { data: legacy } = await admin
      .from("system_email_smtp")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    const legacyCfg = legacy as LegacySmtp | null;
    const hasLegacy = !!(legacyCfg?.host && legacyCfg?.from_email);
    if (candidates.length === 0 && !hasLegacy) {
      return json(
        {
          error: "no_provider_configured",
          detail: "Configurá un proveedor de email (Resend o SMTP) en /internal/emails.",
        },
        400,
      );
    }

    // --- Cola: pending + failed reintentables -------------------------------
    const nowIso = new Date().toISOString();
    // pending (recién encolados).
    const { data: pendingRows } = await admin
      .from("system_emails")
      .select("id, recipient, subject, html_content, attempts")
      .eq("kind", "system")
      .eq("status", "pending")
      .not("html_content", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    const rows = [...((pendingRows ?? []) as Array<{
      id: string;
      recipient: string;
      subject: string;
      html_content: string | null;
      attempts: number | null;
    }>)];

    // failed con backoff cumplido y bajo el tope (rellena el batch).
    if (rows.length < BATCH) {
      const { data: failedRows } = await admin
        .from("system_emails")
        .select("id, recipient, subject, html_content, attempts")
        .eq("kind", "system")
        .eq("status", "failed")
        .not("html_content", "is", null)
        .lt("attempts", MAX_ATTEMPTS)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(BATCH - rows.length);
      rows.push(
        ...((failedRows ?? []) as Array<{
          id: string;
          recipient: string;
          subject: string;
          html_content: string | null;
          attempts: number | null;
        }>),
      );
    }

    if (rows.length === 0) {
      return json({ processed: 0, sent: 0, failed: 0, via: viaCron ? "cron" : "staff" });
    }

    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      const attempts = (row.attempts ?? 0) + 1;
      const ts = new Date().toISOString();
      try {
        const providerUsed = await sendWithProviders(
          candidates,
          hasLegacy ? legacyCfg : null,
          {
            to: row.recipient,
            subject: row.subject,
            html: row.html_content ?? "",
          },
        );
        await admin
          .from("system_emails")
          .update({
            status: "sent",
            sent_at: ts,
            attempts,
            last_attempt_at: ts,
            next_attempt_at: null,
            error_message: `via ${providerUsed}`,
          })
          .eq("id", row.id);
        sent += 1;
      } catch (e) {
        // Backoff: próximo intento según cuántos llevamos. Al tope, queda failed
        // sin next_attempt_at (no se vuelve a tomar).
        const idx = Math.min(attempts - 1, BACKOFF_MIN.length - 1);
        const next =
          attempts >= MAX_ATTEMPTS
            ? null
            : new Date(Date.now() + BACKOFF_MIN[idx]! * 60_000).toISOString();
        await admin
          .from("system_emails")
          .update({
            status: "failed",
            attempts,
            last_attempt_at: ts,
            next_attempt_at: next,
            error_message: String(e).slice(0, 500),
          })
          .eq("id", row.id);
        failed += 1;
      }
    }

    await admin.from("audit_logs").insert({
      tenant_id: null,
      actor_user_id: actorId,
      entity_type: "email",
      entity_id: null,
      action: "pending_emails_processed",
      after_data: { processed: rows.length, sent, failed, via: viaCron ? "cron" : "staff" },
    });

    return json({ processed: rows.length, sent, failed, via: viaCron ? "cron" : "staff" });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
