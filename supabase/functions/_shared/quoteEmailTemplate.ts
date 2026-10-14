// =============================================================================
// HTML del email del presupuesto (ADR-123) para la Edge send_quote_email.
// MANTENER EN ESPEJO con lib/email/quoteTemplate.ts (vista previa del cliente):
// el bloque entre los marcadores <quote-template> es idéntico
// (tests/unit/quoteEmail.test.ts lo verifica). Deno no importa desde lib/.
// =============================================================================

// <quote-template>
export const QUOTE_EMAIL_APP_URL = "https://pos.soft.ninja";
const QUOTE_EMAIL_LOGO_ON_LIGHT =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
const QUOTE_EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const QUOTE_EMAIL_PAGE_BG = "#f3f2f8";
const QUOTE_EMAIL_INK = "#09051C";
const QUOTE_EMAIL_MUTED = "#6b7280";
const QUOTE_EMAIL_LINE = "#ebe9f2";

export interface QuoteEmailInput {
  /** Color de acento del negocio (#rrggbb). */
  accent: string;
  /** Logo del negocio ("" = su inicial). */
  logoUrl: string;
  businessName: string;
  /** "0001-00000012". */
  numberLabel: string;
  /** Mensaje del negocio (texto plano, se respeta el salto de línea). */
  message: string;
  /** "$ 125.000,00". */
  totalText: string;
  /** "Válido hasta el 30/10/2026" o "Precio de referencia, sujeto a cambios". */
  validityText: string;
  /** Nombre de quien emitió ("" = no se muestra). */
  issuedBy: string;
  /** Link público para ver y responder ("" = sin botón). */
  link: string;
  /** Contacto del negocio ("Tel. 11 5555-5555 · ventas@negocio.com"). */
  contactText: string;
}

export function quoteEmailEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function quoteEmailLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Texto legible sobre el acento (tinta o blanco). */
export function quoteEmailTextOn(bg: string): string {
  return quoteEmailLuminance(bg) > 0.45 ? QUOTE_EMAIL_INK : "#ffffff";
}

export function buildQuoteEmailHtml(input: QuoteEmailInput): string {
  const accent = /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent.toLowerCase() : "#111827";
  const name = (input.businessName || "").trim() || "Presupuesto";
  const safeName = quoteEmailEscape(name);
  const initial = quoteEmailEscape(Array.from(name)[0]!.toUpperCase());
  const logo = (input.logoUrl || "").trim();
  const link = /^https:\/\/[^\s"<>]+$/.test((input.link || "").trim()) ? input.link.trim() : "";
  const ink = quoteEmailTextOn(accent);
  const eyebrow = quoteEmailLuminance(accent) > 0.45 ? QUOTE_EMAIL_INK : accent;

  const logoHtml = logo
    ? `<img src="${quoteEmailEscape(logo)}" alt="${safeName}" height="48" style="display:block;height:48px;width:auto;max-width:200px;border:0" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" height="48" align="center" valign="middle" bgcolor="${accent}" style="width:48px;height:48px;border-radius:10px;background:${accent};font-family:${QUOTE_EMAIL_FONT};font-size:22px;line-height:48px;font-weight:800;color:${ink};text-align:center">${initial}</td></tr></table>`;

  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:10px 0;border-top:1px solid ${QUOTE_EMAIL_LINE};font-size:13px;line-height:18px;color:${QUOTE_EMAIL_MUTED}">${label}</td>` +
    `<td align="right" style="padding:10px 0;border-top:1px solid ${QUOTE_EMAIL_LINE};font-size:${strong ? "20px" : "14px"};line-height:${strong ? "26px" : "18px"};font-weight:${strong ? "800" : "600"};color:${QUOTE_EMAIL_INK};text-align:right">${value}</td></tr>`;

  const summary =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">` +
    row("Total", quoteEmailEscape(input.totalText), true) +
    row("Validez", quoteEmailEscape(input.validityText)) +
    (input.issuedBy.trim() ? row("Emitido por", quoteEmailEscape(input.issuedBy.trim())) : "") +
    `</table>`;

  const button = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>` +
      `<td align="center" bgcolor="${accent}" style="border-radius:8px;background:${accent}">` +
      `<a href="${quoteEmailEscape(link)}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:${QUOTE_EMAIL_FONT};font-size:15px;line-height:20px;font-weight:700;color:${ink};text-decoration:none;border-radius:8px">Ver y responder el presupuesto</a>` +
      `</td></tr></table>`
    : "";

  const contact = input.contactText.trim()
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${QUOTE_EMAIL_MUTED}">${quoteEmailEscape(input.contactText.trim())}</p>`
    : "";

  return (
    `<!doctype html>` +
    `<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${safeName}</title></head>` +
    `<body style="margin:0;padding:0;background:${QUOTE_EMAIL_PAGE_BG};-webkit-font-smoothing:antialiased">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Presupuesto N° ${quoteEmailEscape(input.numberLabel)} de ${safeName} por ${quoteEmailEscape(input.totalText)}.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${QUOTE_EMAIL_PAGE_BG}" style="background:${QUOTE_EMAIL_PAGE_BG}"><tr><td align="center" style="padding:28px 12px 40px">` +
    `<table role="presentation" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;font-family:${QUOTE_EMAIL_FONT}">` +
    `<tr><td height="6" bgcolor="${accent}" style="height:6px;line-height:6px;font-size:6px;background:${accent};border-radius:12px 12px 0 0">&nbsp;</td></tr>` +
    `<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${QUOTE_EMAIL_LINE};border-top:0;border-radius:0 0 12px 12px;padding:30px 32px 32px;text-align:left">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding:0 14px 0 0">${logoHtml}</td>` +
    `<td valign="middle" style="font-size:18px;line-height:1.3;font-weight:800;color:${QUOTE_EMAIL_INK}">${safeName}</td></tr></table>` +
    `<p style="margin:26px 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${eyebrow}">Presupuesto N° ${quoteEmailEscape(input.numberLabel)}</p>` +
    `<p style="margin:0 0 24px;white-space:pre-wrap;font-size:15px;line-height:1.65;color:#374151">${quoteEmailEscape(input.message.trim())}</p>` +
    summary +
    button +
    `<p style="margin:0;font-size:13px;line-height:1.6;color:${QUOTE_EMAIL_MUTED}">El presupuesto va adjunto en PDF a este email.</p>` +
    contact +
    `</td></tr>` +
    `<tr><td align="center" style="padding:24px 0 0;text-align:center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    `<td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:#9ca3af">Enviado con</td>` +
    `<td><a href="${QUOTE_EMAIL_APP_URL}" target="_blank" style="text-decoration:none"><img src="${QUOTE_EMAIL_LOGO_ON_LIGHT}" alt="Enviado con NinjaPos" height="18" style="display:block;height:18px;border:0" /></a></td>` +
    `</tr></table>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
// </quote-template>
