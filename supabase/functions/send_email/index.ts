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

// Carrera contra un timeout: si la promesa no resuelve a tiempo, rechaza.
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

// Representa un proveedor candidato ya normalizado, en orden de prioridad.
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

    // --- Construye la cadena de intentos (slot 1 → slot 2 → legacy) ---------
    const { data: providers } = await admin
      .from("email_providers")
      .select("*")
      .order("slot", { ascending: true });
    const rows = (providers ?? []) as ProviderRow[];

    // Solo proveedores activos y "completos" para su kind entran a la cadena.
    const candidates = rows.filter((p) => {
      if (!p.is_active || !p.from_email) return false;
      if (p.kind === "resend") return !!p.api_key;
      if (p.kind === "smtp") return !!p.smtp_host;
      return false;
    });

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

    const attempts: string[] = [];
    let providerUsed: string | null = null;
    let lastError = "";

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
        providerUsed = label;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        attempts.push(`${label}: ${lastError}`);
      }
    }

    // Fallback: SMTP legacy (system_email_smtp) si ningún provider funcionó.
    if (!providerUsed) {
      const { data: legacy } = await admin
        .from("system_email_smtp")
        .select("*")
        .eq("id", true)
        .maybeSingle();
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
          providerUsed = "smtp#legacy";
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          attempts.push(`smtp#legacy: ${lastError}`);
        }
      } else if (candidates.length === 0) {
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
