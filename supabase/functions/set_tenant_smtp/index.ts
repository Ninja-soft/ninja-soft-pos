// =============================================================================
// Edge Function: set_tenant_smtp — guarda la config SMTP del NEGOCIO (tenant).
// SOLO owner/manager activo del tenant. service_role solo acá:
// tenant_email_smtp tiene RLS deny a todos.
// Si password viene vacío, NO se sobrescribe (se conserva el guardado).
// { test: true, test_to } → tras guardar, envía un email de prueba. H9b PR3.
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

// Carrera contra un timeout: si la promesa SMTP no resuelve a tiempo, rechaza.
// Evita que un socket colgado mate al worker (deployment_id:null / 503).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}_timeout`)), ms)),
  ]);
}

// Envío de prueba por Resend (POST a su API con Bearer api_key). Mismo patrón
// que send_receipt_email / send_email.
async function sendViaResend(
  apiKey: string,
  fromName: string,
  fromEmail: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const from = `${fromName.replace(/"/g, "")} <${fromEmail}>`;
  const res = await withTimeout(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    }),
    25000,
    "resend",
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend_${res.status}: ${detail.slice(0, 300)}`);
  }
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

  const tenantId = (user.app_metadata as { current_tenant_id?: string } | null)
    ?.current_tenant_id;
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Guard: owner/manager activo del tenant.
  const { data: mem } = await admin
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!mem || !["owner", "manager"].includes(mem.role as string)) {
    return json({ error: "forbidden" }, 403);
  }

  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return json({ error: "invalid_port" }, 400);
  }
  const fromEmail = String(b.from_email ?? "").trim().toLowerCase();
  if (fromEmail && !EMAIL_RE.test(fromEmail)) {
    return json({ error: "invalid_from_email" }, 400);
  }

  // Diseño del cuerpo del email del comprobante (H9b PR5). Valida contra las 5
  // claves conocidas; cualquier otra cosa cae a 'brand'.
  const BODY_TEMPLATE_KEYS = ["brand", "clean", "dark", "warm", "minimal"];
  const bodyTemplateRaw = String(b.body_template ?? "brand").trim();
  const bodyTemplate = BODY_TEMPLATE_KEYS.includes(bodyTemplateRaw)
    ? bodyTemplateRaw
    : "brand";

  // Proveedor de envío del negocio: 'resend' (API key) o 'smtp' (default).
  const providerRaw = String(b.provider ?? "smtp").trim();
  const provider = providerRaw === "resend" ? "resend" : "smtp";

  const patch: Record<string, unknown> = {
    tenant_id: tenantId,
    provider,
    host: String(b.host ?? "").trim(),
    port,
    secure: !!b.secure,
    username: String(b.username ?? "").trim(),
    from_name: String(b.from_name ?? "").trim().slice(0, 80),
    from_email: fromEmail,
    body_text: String(b.body_text ?? "").trim().slice(0, 2000),
    body_template: bodyTemplate,
    updated_at: new Date().toISOString(),
  };

  // password vacío/ausente → conservar el guardado (no se sobrescribe).
  const pwd = typeof b.password === "string" ? b.password : "";
  // resend_api_key vacío/ausente → conservar la guardada (mismo patrón que el
  // password). NUNCA se devuelve al frontend: se guarda y se olvida.
  const resendKey = typeof b.resend_api_key === "string" ? b.resend_api_key.trim() : "";
  const row: Record<string, unknown> = { ...patch };
  if (pwd) row.password = pwd;
  if (resendKey) row.resend_api_key = resendKey;

  const { error: upErr } = await admin
    .from("tenant_email_smtp")
    .upsert(row, { onConflict: "tenant_id" });
  if (upErr) return json({ error: "save_failed", detail: upErr.message }, 500);

  await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: user.id,
    entity_type: "tenant",
    entity_id: tenantId,
    action: "tenant_smtp_updated",
    after_data: { host: patch.host, from_email: patch.from_email },
  });

  // Test opcional: tras guardar, envía un email de prueba con la config GUARDADA
  // (incluyendo el password retenido si no se reenvió). La config queda guardada
  // pase o no pase el test.
  if (b.test === true) {
    const { data: cfg } = await admin
      .from("tenant_email_smtp")
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const cfgProvider = String(cfg?.provider ?? "smtp");
    // Requisito mínimo por proveedor: Resend (api_key+from), SMTP (host+from).
    const incomplete =
      cfgProvider === "resend"
        ? !cfg?.resend_api_key || !cfg?.from_email
        : !cfg?.host || !cfg?.from_email;
    if (incomplete) {
      return json({ error: "test_failed", detail: "incomplete_config" });
    }
    const testTo = String(b.test_to ?? cfg!.from_email).trim().toLowerCase();
    if (!EMAIL_RE.test(testTo)) {
      return json({ error: "test_failed", detail: "invalid_test_to" });
    }
    // Sin caracteres de control: from_name viaja en headers SMTP.
    const fromName = (cfg!.from_name || "NinjaSoft POS")
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .trim() || "NinjaSoft POS";
    const testSubject = "Prueba de email del negocio";
    const testText =
      "Este es un email de prueba de NinjaSoft POS. Si lo recibís, tu configuración de email funciona.";

    // Bitácora de envíos (best-effort: nunca altera la respuesta de la función).
    let logId: string | null = null;
    try {
      const { data: logRow } = await admin
        .from("system_emails")
        .insert({
          tenant_id: tenantId,
          recipient: testTo,
          subject: testSubject,
          kind: "smtp_test",
          status: "pending",
        })
        .select("id")
        .single();
      logId = logRow?.id ?? null;
    } catch (_) {
      /* noop */
    }

    try {
      if (cfgProvider === "resend") {
        await sendViaResend(
          String(cfg!.resend_api_key),
          fromName,
          cfg!.from_email,
          testTo,
          testSubject,
          testText,
        );
      } else {
        // Hardening de puerto/TLS: 465 = SSL directo (forzar tls); 587 =
        // STARTTLS (nodemailer lo negocia solo si el server lo ofrece).
        const smtpPort = cfg!.port || 587;
        const smtpTls = smtpPort === 465 ? true : !!cfg!.secure;
        const transporter = nodemailer.createTransport({
          host: cfg!.host,
          port: smtpPort,
          secure: smtpTls,
          auth: cfg!.username
            ? { user: cfg!.username, pass: cfg!.password }
            : undefined,
          connectionTimeout: 15000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
        });
        try {
          await withTimeout(
            transporter.sendMail({
              from: `"${fromName.replace(/"/g, "")}" <${cfg!.from_email}>`,
              to: testTo,
              subject: testSubject,
              text: testText,
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
    } catch (e) {
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
      return json({
        error: "test_failed",
        detail: e instanceof Error ? e.message : String(e),
      });
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
    return json({ ok: true, tested: true });
  }

  return json({ ok: true });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
