// =============================================================================
// Edge Function: send_receipt_email — envía el comprobante de una venta como
// PDF adjunto (factura.pdf) por email al cliente. Guard: miembro activo del
// tenant de la venta. Proveedor del NEGOCIO (tenant_email_smtp, ver
// Configuración → Email): SMTP (nodemailer) o Resend (API key). H9b PR3.
// Cuerpo HTML con branding del tenant (logo/accent/legal_name).
// El asunto incluye día + hora local (AR) para que Gmail NO agrupe el hilo.
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
// base64 estándar (lo que manda jsPDF.output("datauristring") sin el prefijo
// data:). Validación laxa: charset base64 + padding.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Sello "DD/MM HH:mm" en hora de Argentina para el asunto: con esto el subject
// nunca se repite y Gmail no agrupa cada comprobante en el mismo hilo.
const stampAr = (d = new Date()): string => {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
};

// Carrera contra timeout para el POST a Resend (mismo patrón que el SMTP).
async function sendViaResend(
  apiKey: string,
  fromName: string,
  fromEmail: string,
  args: { to: string; subject: string; html: string; text: string; pdfBase64: string; pdfName: string },
): Promise<void> {
  const from = `${fromName.replace(/"/g, "")} <${fromEmail}>`;
  const res = await withTimeout(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
        attachments: [{ filename: args.pdfName, content: args.pdfBase64 }],
      }),
    }),
    25000,
    "resend",
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`resend_${res.status}: ${detail.slice(0, 300)}`);
  }
}

// Escapa datos provistos por el tenant (legal_name) antes de interpolar en HTML.
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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

// --- Diseños del cuerpo del email del comprobante (H9b PR5 + PR8) ----------
// Cada diseño recibe el contexto ya escapado y devuelve el HTML completo. Solo
// estilos inline (los clientes de email descartan <style>/clases). Todos muestran
// el logo (tenant o NinjaSoft de fallback) y cierran con el footer contrastado.
//
// ⚠️ MANTENER EN ESPEJO con lib/email/receiptTemplates.ts (mismo markup/estilos).
// Deno no puede importar desde lib/ en nuestros deploys single-file, por eso esta
// copia vive acá; el PREVIEW del cliente usa la versión de lib/.
const NINJA_LOGO_URL = "https://ninja-soft-pos.vercel.app/brand/ninjasoft-wordmark.webp";
// Wordmark dark-mode de NinjaPos (texto "pos" blanco → solo sobre fondo oscuro).
const NINJA_LOGO_DARK_URL = "https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp";
const FOOTER_TEXT = "Enviado con NinjaPos";
const ATTACH_NOTE = "Tu comprobante va adjunto en PDF a este email.";

// Footer contrastado: fondo oscuro (#09051C ninja void) con el wordmark
// dark-mode de NinjaPos + texto tenue. En el diseño dark (tarjeta ya oscura) se
// pasa un bg levemente distinto (#1f2937) para separar el footer del cuerpo.
const footerHtml = (bg = "#09051C") =>
  `<div style="background:${bg};padding:18px 12px;text-align:center">
    <img src="${NINJA_LOGO_DARK_URL}" alt="NinjaPos" style="max-height:20px;display:inline-block" />
    <div style="color:#9ca3af;font-size:11px;margin-top:8px">${FOOTER_TEXT}</div>
  </div>`;

interface BodyCtx {
  accent: string;
  logoHtml: string;
  safeName: string;
  safeBodyText: string;
}

type BodyTemplateKey = "brand" | "clean" | "dark" | "warm" | "minimal";

const EMAIL_BODY_TEMPLATES: Record<BodyTemplateKey, (c: BodyCtx) => string> = {
  // 1) brand — header con el accent del tenant + logo/nombre, footer gris.
  brand: ({ accent, logoHtml, safeName, safeBodyText }) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:${accent};padding:20px;text-align:center">
    ${logoHtml}
    <div style="color:#ffffff;font-size:16px;font-weight:bold;margin-top:8px">${safeName}</div>
  </div>
  <div style="padding:24px;color:#111827">
    <p style="white-space:pre-wrap;margin:0 0 12px">${safeBodyText}</p>
    <p style="color:#6b7280;font-size:12px;margin:0">${ATTACH_NOTE}</p>
  </div>
  ${footerHtml()}
</div>`,

  // 2) clean — blanco, borde superior accent 4px, logo centrado, mucho aire.
  clean: ({ accent, logoHtml, safeName, safeBodyText }) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #eef0f3;border-top:4px solid ${accent};border-radius:10px;overflow:hidden">
  <div style="padding:36px 32px;text-align:center">
    ${logoHtml}
    <div style="color:#111827;font-size:17px;font-weight:600;margin-top:14px">${safeName}</div>
  </div>
  <div style="padding:0 32px 36px;color:#374151;text-align:center;line-height:1.6">
    <p style="white-space:pre-wrap;margin:0 0 16px;font-size:15px">${safeBodyText}</p>
    <p style="color:#9ca3af;font-size:12px;margin:0">${ATTACH_NOTE}</p>
  </div>
  ${footerHtml()}
</div>`,

  // 3) dark — tarjeta oscura, texto claro, divisor accent.
  dark: ({ accent, logoHtml, safeName, safeBodyText }) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;background:#111827;border-radius:14px;overflow:hidden">
  <div style="padding:28px 24px 20px;text-align:center">
    ${logoHtml}
    <div style="color:#ffffff;font-size:17px;font-weight:bold;margin-top:10px">${safeName}</div>
    <div style="height:3px;width:48px;background:${accent};border-radius:99px;margin:16px auto 0"></div>
  </div>
  <div style="padding:8px 28px 28px;color:#e5e7eb;line-height:1.6">
    <p style="white-space:pre-wrap;margin:0 0 14px;font-size:15px">${safeBodyText}</p>
    <p style="color:#9ca3af;font-size:12px;margin:0">${ATTACH_NOTE}</p>
  </div>
  ${footerHtml("#1f2937")}
</div>`,

  // 4) warm — fondo cálido, header naranja (accent si está seteado), redondeado.
  warm: ({ accent, logoHtml, safeName, safeBodyText }) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:500px;margin:0 auto;background:#fff7ed;border-radius:16px;overflow:hidden;border:1px solid #fed7aa">
  <div style="background:${accent};padding:24px;text-align:center;border-radius:16px 16px 0 0">
    ${logoHtml}
    <div style="color:#ffffff;font-size:17px;font-weight:bold;margin-top:8px">${safeName}</div>
  </div>
  <div style="padding:26px 28px;color:#7c2d12;line-height:1.6">
    <p style="white-space:pre-wrap;margin:0 0 14px;font-size:15px">${safeBodyText}</p>
    <p style="color:#c2693e;font-size:12px;margin:0">${ATTACH_NOTE}</p>
  </div>
  ${footerHtml()}
</div>`,

  // 5) minimal — sin bloque header; logo chico arriba-izquierda, separadores finos.
  minimal: ({ logoHtml, safeName, safeBodyText }) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:8px 4px;color:#111827">
  <div style="padding:4px 4px 14px;border-bottom:1px solid #ececec">
    ${logoHtml}
  </div>
  <div style="padding:18px 4px;line-height:1.6">
    <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:8px">${safeName}</div>
    <p style="white-space:pre-wrap;margin:0 0 12px;font-size:14px;color:#374151">${safeBodyText}</p>
    <p style="color:#9ca3af;font-size:12px;margin:0">${ATTACH_NOTE}</p>
  </div>
  ${footerHtml()}
</div>`,
};

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

  let b: { sale_id?: string; to?: string; pdf?: string };
  try {
    b = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const saleId = String(b.sale_id ?? "").trim();
  const to = String(b.to ?? "").trim().toLowerCase();
  // PDF en base64 crudo (sin prefijo data:). El cliente lo genera con jsPDF.
  const pdfBase64 = String(b.pdf ?? "").trim();
  if (!saleId) return json({ error: "missing_sale_id" }, 400);
  if (!EMAIL_RE.test(to)) return json({ error: "invalid_to" }, 400);
  if (!pdfBase64 || !BASE64_RE.test(pdfBase64)) return json({ error: "invalid_pdf" }, 400);
  // ~3 MB de PDF (base64 agrega ~33%).
  if (pdfBase64.length > 4_000_000) return json({ error: "pdf_too_large" }, 413);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: sale } = await admin
    .from("sales")
    .select("id, tenant_id, number")
    .eq("id", saleId)
    .maybeSingle();
  if (!sale) return json({ error: "sale_not_found" }, 404);
  const { data: member } = await admin
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", sale.tenant_id)
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!member) return json({ error: "forbidden" }, 403);

  const { data: cfg } = await admin
    .from("tenant_email_smtp")
    .select("*")
    .eq("tenant_id", sale.tenant_id)
    .maybeSingle();
  // Proveedor del negocio: 'resend' (API key) o 'smtp' (default). Cada uno tiene
  // su propio requisito mínimo; sin eso, pedimos configurar el email.
  const provider = String(cfg?.provider ?? "smtp");
  const resendKey = String(cfg?.resend_api_key ?? "");
  const providerReady =
    provider === "resend"
      ? !!resendKey && !!cfg?.from_email
      : !!cfg?.host && !!cfg?.from_email;
  if (!providerReady)
    return json(
      {
        error: "tenant_smtp_not_configured",
        detail: "Configurá el email de tu negocio en Configuración → Email.",
      },
      400,
    );
  const { data: brand } = await admin
    .from("tenant_branding")
    .select("legal_name, logo_url, accent")
    .eq("tenant_id", sale.tenant_id)
    .maybeSingle();
  // Sin caracteres de control: legal_name viaja en headers SMTP (From/Subject);
  // CR/LF permitirían inyectar headers (nodemailer no los filtra).
  const name = (brand?.legal_name || cfg.from_name || "NinjaSoft POS")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim() || "NinjaSoft POS";
  const safeName = escapeHtml(name);

  // Branding del cuerpo HTML.
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(brand?.accent ?? ""))
    ? String(brand!.accent)
    : "#111827";
  const logoUrl = String(brand?.logo_url ?? "").trim();
  const safeLogo = escapeHtml(logoUrl); // escapa comillas para el atributo src
  // Logo del tenant si tiene; si no, el wordmark de NinjaSoft (URL absoluta).
  const logoHtml = logoUrl
    ? `<img src="${safeLogo}" alt="${safeName}" style="max-height:48px;display:inline-block">`
    : `<img src="${NINJA_LOGO_URL}" alt="NinjaSoft" style="max-height:32px;display:inline-block">`;
  const bodyTextRaw =
    String(cfg.body_text ?? "").trim() ||
    "¡Gracias por tu compra! Te enviamos tu comprobante.";
  const safeBodyText = escapeHtml(bodyTextRaw);
  // Diseño elegido por el tenant (fallback 'brand' para claves desconocidas).
  const bodyKey = String(cfg.body_template ?? "brand") as BodyTemplateKey;
  const buildBody = EMAIL_BODY_TEMPLATES[bodyKey] ?? EMAIL_BODY_TEMPLATES.brand;
  const html = buildBody({ accent, logoHtml, safeName, safeBodyText });

  // Asunto con sello día+hora (AR): único por envío → Gmail no agrupa el hilo.
  const subject = `Tu comprobante de ${name} — ${stampAr()}`;
  const pdfName = `factura-${sale.number}.pdf`;

  // Bitácora de envíos (best-effort: nunca altera la respuesta de la función).
  let logId: string | null = null;
  try {
    const { data: logRow } = await admin
      .from("system_emails")
      .insert({
        tenant_id: sale.tenant_id,
        recipient: to,
        subject,
        kind: "receipt",
        status: "pending",
      })
      .select("id")
      .single();
    logId = logRow?.id ?? null;
  } catch (_) {
    /* noop */
  }

  try {
    if (provider === "resend") {
      // Resend: adjunta el PDF (content base64). Sin socket que cerrar.
      await sendViaResend(resendKey, name, cfg.from_email, {
        to,
        subject,
        html,
        text: bodyTextRaw,
        pdfBase64,
        pdfName,
      });
    } else {
      // SMTP (nodemailer). Hardening de puerto/TLS: 465 = SSL directo (forzar
      // tls); 587 = STARTTLS (nodemailer lo negocia solo si el server lo ofrece).
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
      try {
        await withTimeout(
          transporter.sendMail({
            from: `"${name.replace(/"/g, "")}" <${cfg.from_email}>`,
            to,
            subject,
            text: bodyTextRaw,
            html,
            attachments: [
              {
                filename: pdfName,
                content: pdfBase64,
                encoding: "base64",
                contentType: "application/pdf",
              },
            ],
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
  await admin
    .from("sales")
    .update({ receipt_email_to: to, receipt_emailed_at: new Date().toISOString() })
    .eq("id", saleId);
  await admin.from("audit_logs").insert({
    tenant_id: sale.tenant_id,
    actor_user_id: user.id,
    entity_type: "sale",
    entity_id: saleId,
    action: "receipt_emailed",
    after_data: { to },
  });
  return json({ ok: true });
  } catch (e) {
    return json({ error: "internal", detail: String(e) }, 500);
  }
});
