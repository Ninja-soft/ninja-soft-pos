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
import { fetchTradeName } from "../_shared/businessName.ts";

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
// MANTENER EN ESPEJO con lib/email/receiptTemplates.ts: el bloque entre los
// marcadores <receipt-templates> es idéntico salvo la palabra `export`
// (tests/unit/emailTemplates.test.ts lo verifica). Deno no puede importar desde
// lib/ en nuestros deploys single-file, por eso esta copia vive acá; el PREVIEW
// del cliente usa la versión de lib/.
// <receipt-templates>
type BodyTemplateKey = "brand" | "clean" | "dark" | "warm" | "minimal";

const RECEIPT_APP_URL = "https://pos.soft.ninja";
// Logo oficial de NinjaPOS con texto negro (va sobre el fondo claro del footer).
const NINJA_POS_LOGO_ON_LIGHT =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
const FOOTER_TEXT = "Enviado con NinjaPos";
const ATTACH_NOTE = "Tu comprobante va adjunto en PDF a este email.";
const RECEIPT_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const RECEIPT_PAGE_BG = "#f3f2f8";
const RECEIPT_INK = "#09051C";

/** Escapa datos provistos por el usuario antes de interpolarlos en HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mezcla dos colores #rrggbb: t=0 devuelve `a`, t=1 devuelve `b`. */
function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return (
    "#" +
    ca
      .map((v, i) => Math.round(v + (cb[i]! - v) * t).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Luminancia relativa (0 negro, 1 blanco) de un color #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Color de texto legible sobre un fondo dado (blanco o tinta). */
function textOn(bg: string): string {
  return luminance(bg) > 0.45 ? RECEIPT_INK : "#ffffff";
}

interface ReceiptCtx {
  accent: string;
  // URL del logo del negocio, ya escapada ("" si no tiene).
  safeLogo: string;
  // Nombre del negocio, ya escapado.
  safeName: string;
  // Texto del cuerpo, ya escapado.
  safeBodyText: string;
  // Inicial del negocio para el monograma (si no tiene logo), ya escapada.
  initial: string;
}

// Logo del negocio, o un monograma con su inicial si no cargó logo.
function receiptLogo(c: ReceiptCtx, bg: string, align: "center" | "left"): string {
  const margin = align === "center" ? "0 auto" : "0";
  if (c.safeLogo) {
    return `<img src="${c.safeLogo}" alt="${c.safeName}" height="56" style="display:block;margin:${margin};height:56px;width:auto;max-width:220px;border:0" />`;
  }
  const fill = bg === c.accent ? textOn(c.accent) : c.accent;
  const ink = textOn(fill);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${align === "center" ? ' align="center"' : ""} style="margin:${margin}"><tr>` +
    `<td width="56" height="56" align="center" valign="middle" bgcolor="${fill}" style="width:56px;height:56px;border-radius:50%;background:${fill};font-family:${RECEIPT_FONT};font-size:24px;line-height:56px;font-weight:800;color:${ink};text-align:center">${c.initial}</td>` +
    `</tr></table>`
  );
}

// Ícono + eyebrow + texto del negocio + aviso del adjunto. Compartido por todos
// los diseños; `p` define los colores según el fondo de la tarjeta.
function receiptBody(
  c: ReceiptCtx,
  p: {
    bg: string;
    text: string;
    muted: string;
    chip: string;
    eyebrow: string;
    align: "center" | "left";
    icon: boolean;
  },
): string {
  const circle = mixHex(c.accent, p.bg, 0.86);
  const icon = p.icon
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px"><tr>` +
      `<td width="64" height="64" align="center" valign="middle" bgcolor="${circle}" style="width:64px;height:64px;border-radius:50%;background:${circle};font-size:28px;line-height:64px;text-align:center">🧾</td>` +
      `</tr></table>`
    : "";
  return (
    icon +
    `<p style="margin:0 0 10px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${p.eyebrow};text-align:${p.align}">Comprobante de compra</p>` +
    `<p style="margin:0 0 24px;white-space:pre-wrap;font-size:16px;line-height:1.6;color:${p.text};text-align:${p.align}">${c.safeBodyText}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.chip}" style="background:${p.chip};border-radius:14px"><tr>` +
    `<td width="44" align="center" valign="middle" style="padding:14px 0 14px 16px;font-size:20px;line-height:20px">📎</td>` +
    `<td valign="middle" style="padding:14px 18px 14px 10px;font-size:13px;line-height:1.5;color:${p.muted};text-align:left">${ATTACH_NOTE}</td>` +
    `</tr></table>`
  );
}

// Documento completo: fondo, preheader, tarjeta (filas) y el pie "Enviado con".
function receiptDoc(c: ReceiptCtx, cardRows: string): string {
  return (
    `<!doctype html>` +
    `<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${c.safeName}</title></head>` +
    `<body style="margin:0;padding:0;background:${RECEIPT_PAGE_BG};-webkit-font-smoothing:antialiased">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Tu comprobante de ${c.safeName} va adjunto en PDF.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${RECEIPT_PAGE_BG}" style="background:${RECEIPT_PAGE_BG}"><tr><td align="center" style="padding:28px 12px 40px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:${RECEIPT_FONT}">` +
    cardRows +
    `<tr><td align="center" style="padding:28px 0 0;text-align:center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    `<td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Enviado con</td>` +
    `<td><a href="${RECEIPT_APP_URL}" target="_blank" style="text-decoration:none"><img src="${NINJA_POS_LOGO_ON_LIGHT}" alt="${FOOTER_TEXT}" height="18" style="display:block;height:18px;border:0" /></a></td>` +
    `</tr></table>` +
    `<p style="margin:10px 0 0;font-size:11px;line-height:1.6;color:#b0b3ba">El punto de venta de Ninja Soft para negocios de Argentina.</p>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

const RECEIPT_TEMPLATES: Record<BodyTemplateKey, (c: ReceiptCtx) => string> = {
  // 1) brand: header lleno con el color del negocio, logo y nombre.
  brand: (c) => {
    const ink = textOn(c.accent);
    return receiptDoc(
      c,
      `<tr><td align="center" bgcolor="${c.accent}" style="background:${c.accent};border-radius:20px 20px 0 0;padding:36px 32px 30px;text-align:center">` +
        receiptLogo(c, c.accent, "center") +
        `<p style="margin:14px 0 0;font-size:20px;line-height:1.3;font-weight:800;color:${ink}">${c.safeName}</p>` +
        `</td></tr>` +
        `<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 20px 20px;padding:36px 36px 36px;text-align:center">` +
        receiptBody(c, {
          bg: "#ffffff",
          text: "#374151",
          muted: "#6b7280",
          chip: "#f7f6fb",
          eyebrow: luminance(c.accent) > 0.45 ? mixHex(c.accent, "#000000", 0.45) : c.accent,
          align: "center",
          icon: true,
        }) +
        `</td></tr>`,
    );
  },

  // 2) clean: tarjeta blanca con una franja fina del color del negocio arriba.
  clean: (c) =>
    receiptDoc(
      c,
      `<tr><td height="6" bgcolor="${c.accent}" style="height:6px;line-height:6px;font-size:6px;background:${c.accent};border-radius:20px 20px 0 0">&nbsp;</td></tr>` +
        `<tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:38px 36px 8px;text-align:center">` +
        receiptLogo(c, "#ffffff", "center") +
        `<p style="margin:14px 0 0;font-size:19px;line-height:1.3;font-weight:800;color:${RECEIPT_INK}">${c.safeName}</p>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:28px 0 30px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table>` +
        `</td></tr>` +
        `<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 20px 20px;padding:0 36px 36px;text-align:center">` +
        receiptBody(c, {
          bg: "#ffffff",
          text: "#374151",
          muted: "#6b7280",
          chip: "#f7f6fb",
          eyebrow: luminance(c.accent) > 0.45 ? mixHex(c.accent, "#000000", 0.45) : c.accent,
          align: "center",
          icon: false,
        }) +
        `</td></tr>`,
    ),

  // 3) dark: tarjeta oscura con un brillo del color del negocio arriba.
  dark: (c) => {
    const glow = mixHex(c.accent, RECEIPT_INK, 0.62);
    const eyebrow = luminance(c.accent) < 0.08 ? mixHex(c.accent, "#ffffff", 0.55) : c.accent;
    return receiptDoc(
      c,
      `<tr><td align="center" bgcolor="${RECEIPT_INK}" style="background:${RECEIPT_INK};background-image:radial-gradient(120% 90% at 50% 0%,${glow} 0%,${RECEIPT_INK} 62%);border-radius:20px 20px 0 0;padding:40px 32px 8px;text-align:center">` +
        receiptLogo(c, RECEIPT_INK, "center") +
        `<p style="margin:14px 0 0;font-size:20px;line-height:1.3;font-weight:800;color:#ffffff">${c.safeName}</p>` +
        `</td></tr>` +
        `<tr><td bgcolor="${RECEIPT_INK}" style="background:${RECEIPT_INK};border-radius:0 0 20px 20px;padding:30px 36px 36px;text-align:center">` +
        receiptBody(c, {
          bg: RECEIPT_INK,
          text: "#e5e7eb",
          muted: "#b8aedc",
          chip: "#17122e",
          eyebrow,
          align: "center",
          icon: true,
        }) +
        `</td></tr>`,
    );
  },

  // 4) warm: header del color del negocio y cuerpo en un tono cálido.
  warm: (c) => {
    const ink = textOn(c.accent);
    return receiptDoc(
      c,
      `<tr><td align="center" bgcolor="${c.accent}" style="background:${c.accent};border-radius:20px 20px 0 0;padding:36px 32px 30px;text-align:center">` +
        receiptLogo(c, c.accent, "center") +
        `<p style="margin:14px 0 0;font-size:20px;line-height:1.3;font-weight:800;color:${ink}">${c.safeName}</p>` +
        `</td></tr>` +
        `<tr><td bgcolor="#fff7ed" style="background:#fff7ed;border-radius:0 0 20px 20px;padding:36px 36px 36px;text-align:center">` +
        receiptBody(c, {
          bg: "#fff7ed",
          text: "#7c2d12",
          muted: "#9a3412",
          chip: "#ffedd5",
          eyebrow: "#c2410c",
          align: "center",
          icon: true,
        }) +
        `</td></tr>`,
    );
  },

  // 5) minimal: sin bloque de header; logo y nombre a la izquierda, todo sobrio.
  minimal: (c) =>
    receiptDoc(
      c,
      `<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:20px 20px 0 0;padding:32px 36px 0;text-align:left">` +
        receiptLogo(c, "#ffffff", "left") +
        `<p style="margin:14px 0 0;font-size:18px;line-height:1.3;font-weight:800;color:${RECEIPT_INK};text-align:left">${c.safeName}</p>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 26px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table>` +
        `</td></tr>` +
        `<tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 20px 20px;padding:0 36px 34px;text-align:left">` +
        receiptBody(c, {
          bg: "#ffffff",
          text: "#374151",
          muted: "#6b7280",
          chip: "#f7f6fb",
          eyebrow: "#9ca3af",
          align: "left",
          icon: false,
        }) +
        `</td></tr>`,
    ),
};

interface BuildReceiptEmailInput {
  accent: string;
  // URL del logo del negocio ("" si no tiene: se usa su inicial).
  logoUrl: string;
  // Nombre del negocio (sin escapar).
  name: string;
  // Texto del cuerpo (sin escapar).
  bodyText: string;
}

/**
 * Construye el HTML completo del email del comprobante para un diseño dado.
 * Strings estáticos confiables + inputs escapados. Lo usan el PREVIEW del
 * cliente y la Edge Function (copia en espejo).
 */
function buildReceiptEmailHtml(
  design: BodyTemplateKey,
  { accent, logoUrl, name, bodyText }: BuildReceiptEmailInput,
): string {
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent.toLowerCase() : "#111827";
  const cleanName = (name || "").trim() || "NinjaSoft POS";
  const safeName = escapeHtml(cleanName);
  const safeBodyText = escapeHtml(
    bodyText || "¡Gracias por tu compra! Te enviamos tu comprobante.",
  );
  const safeLogo = escapeHtml(logoUrl.trim());
  const initial = escapeHtml(Array.from(cleanName)[0]!.toUpperCase());
  const build = RECEIPT_TEMPLATES[design] ?? RECEIPT_TEMPLATES.brand;
  return build({ accent: safeAccent, safeLogo, safeName, safeBodyText, initial });
}
// </receipt-templates>

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
  const [{ data: brand }, tradeName] = await Promise.all([
    admin
      .from("tenant_branding")
      .select("legal_name, logo_url, accent")
      .eq("tenant_id", sale.tenant_id)
      .maybeSingle(),
    // ADR-124: el email sale con el nombre de fantasía si el negocio lo cargó.
    fetchTradeName(admin, sale.tenant_id),
  ]);
  // Sin caracteres de control: legal_name viaja en headers SMTP (From/Subject);
  // CR/LF permitirían inyectar headers (nodemailer no los filtra).
  const name = (tradeName || brand?.legal_name || cfg.from_name || "NinjaSoft POS")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim() || "NinjaSoft POS";

  // Cuerpo HTML con la marca del negocio (logo o inicial, acento, nombre).
  const bodyTextRaw =
    String(cfg.body_text ?? "").trim() ||
    "¡Gracias por tu compra! Te enviamos tu comprobante.";
  // Diseño elegido por el tenant (fallback 'brand' para claves desconocidas).
  const bodyKey = String(cfg.body_template ?? "brand") as BodyTemplateKey;
  const html = buildReceiptEmailHtml(bodyKey, {
    accent: String(brand?.accent ?? ""),
    logoUrl: String(brand?.logo_url ?? ""),
    name,
    bodyText: bodyTextRaw,
  });

  // Asunto con sello día+hora (AR): único por envío → Gmail no agrupa el hilo.
  const subject = `Tu comprobante de ${name} (${stampAr()})`;
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
