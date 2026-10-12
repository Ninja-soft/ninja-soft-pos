// =============================================================================
// Email "link de pago" de un cobro en espera (ADR-048). Lo manda la Edge
// pending_charge_share al cliente del negocio: marca del negocio (logo o
// inicial y color de acento), monto grande, detalle de la compra, botón
// "Pagar ahora" y vencimiento. Mismas reglas que el resto de los emails:
// tablas + estilos inline, sin <style>, imágenes PNG absolutas, sin guion largo.
//
// MANTENER EN ESPEJO con supabase/functions/pending_charge_share/index.ts: el
// bloque entre los marcadores <payment-link-template> es idéntico salvo la
// palabra `export` (tests/unit/pendingCharges.test.ts lo verifica).
// =============================================================================

// <payment-link-template>
export interface PaymentLinkEmailInput {
  businessName: string;
  logoUrl: string;
  accent: string;
  customerName: string;
  amountLabel: string;
  payUrl: string;
  expiresLabel: string;
  providerName: string;
  lines: { name: string; quantity: number; subtotalLabel: string }[];
  note: string;
}

const PL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const PL_PAGE = "#f3f2f8";
const PL_INK = "#09051C";
const PL_MUTED = "#6b7280";
const PL_SOFT = "#f7f6fb";
const PL_HAIR = "#ecebf3";
const PL_LOGO_POS =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
const PL_MAX_LINES = 12;

export function plEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/—/g, "-");
}

function plHex(v: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "#ff5a1f";
}

function plInk(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return lum > 0.45 ? PL_INK : "#ffffff";
}

/** Sólo links https para el botón (nunca javascript: ni data:). */
export function plSafeUrl(u: string): string {
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : "";
}

export function buildPaymentLinkEmailHtml(i: PaymentLinkEmailInput): string {
  const accent = plHex(i.accent);
  const onAccent = plInk(accent);
  const name = plEscape(i.businessName || "Tu comercio");
  const logo = plSafeUrl(i.logoUrl);
  const url = plSafeUrl(i.payUrl);
  const hello = i.customerName ? `Hola ${plEscape(i.customerName.split(" ")[0] ?? "")},` : "Hola,";
  const brand = logo
    ? `<img src="${plEscape(logo)}" alt="${name}" height="52" style="display:block;margin:0 auto;height:52px;width:auto;max-width:220px;border:0" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
      `<td width="56" height="56" align="center" valign="middle" bgcolor="${accent}" style="width:56px;height:56px;border-radius:50%;background:${accent};font-size:24px;line-height:56px;font-weight:800;color:${onAccent};text-align:center">${plEscape((i.businessName || "N").trim().charAt(0).toUpperCase())}</td>` +
      `</tr></table>`;
  const shown = i.lines.slice(0, PL_MAX_LINES);
  const more = i.lines.length - shown.length;
  const rows = shown
    .map(
      (l, idx) =>
        `<tr>` +
        `<td style="padding:10px 18px;${idx ? `border-top:1px solid ${PL_HAIR};` : ""}font-size:14px;line-height:20px;color:${PL_INK}">${plEscape(l.name)}${l.quantity !== 1 ? ` <span style="color:${PL_MUTED}">x ${plEscape(String(l.quantity))}</span>` : ""}</td>` +
        `<td align="right" style="padding:10px 18px;${idx ? `border-top:1px solid ${PL_HAIR};` : ""}font-size:14px;line-height:20px;font-weight:600;color:${PL_INK};white-space:nowrap">${plEscape(l.subtotalLabel)}</td>` +
        `</tr>`,
    )
    .join("");
  const moreRow = more > 0
    ? `<tr><td colspan="2" style="padding:10px 18px;border-top:1px solid ${PL_HAIR};font-size:13px;color:${PL_MUTED}">Y ${more} producto${more === 1 ? "" : "s"} más</td></tr>`
    : "";
  const detail = shown.length
    ? `<tr><td style="padding:0 36px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PL_SOFT}" style="background:${PL_SOFT};border-radius:14px">${rows}${moreRow}</table></td></tr>`
    : "";
  const button = url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
      `<td align="center" bgcolor="${accent}" style="border-radius:999px;background:${accent}">` +
      `<a href="${plEscape(url)}" target="_blank" style="display:inline-block;padding:16px 40px;font-family:${PL_FONT};font-size:16px;font-weight:700;line-height:20px;color:${onAccent};text-decoration:none;border-radius:999px">Pagar ahora</a>` +
      `</td></tr></table>` +
      `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${PL_MUTED};word-break:break-all">Si el botón no funciona, copiá este link: <a href="${plEscape(url)}" target="_blank" style="color:${PL_INK}">${plEscape(url)}</a></p>`
    : "";
  const note = i.note
    ? `<p style="margin:0 0 18px;white-space:pre-wrap;font-size:14px;line-height:1.6;color:${PL_MUTED};text-align:center">${plEscape(i.note)}</p>`
    : "";
  const via = i.providerName ? ` con ${plEscape(i.providerName)}` : "";
  return (
    `<!doctype html>` +
    `<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${name}</title></head>` +
    `<body style="margin:0;padding:0;background:${PL_PAGE};-webkit-font-smoothing:antialiased">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">Tu link de pago de ${name} por ${plEscape(i.amountLabel)}.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PL_PAGE}" style="background:${PL_PAGE}"><tr><td align="center" style="padding:28px 12px 40px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:560px;width:100%;font-family:${PL_FONT};background:#ffffff;border-radius:20px">` +
    `<tr><td height="6" bgcolor="${accent}" style="height:6px;line-height:6px;font-size:6px;background:${accent};border-radius:20px 20px 0 0">&nbsp;</td></tr>` +
    `<tr><td align="center" style="padding:36px 36px 8px;text-align:center">${brand}` +
    `<p style="margin:14px 0 0;font-size:15px;line-height:20px;font-weight:700;color:${PL_INK}">${name}</p></td></tr>` +
    `<tr><td align="center" style="padding:18px 36px 6px;text-align:center">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${accent === "#ffffff" ? PL_INK : accent}">Link de pago</p>` +
    `<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:${PL_MUTED}">${hello} podés pagar tu compra${via} desde este link.</p>` +
    `<p style="margin:6px 0 18px;font-size:40px;line-height:1.1;font-weight:800;letter-spacing:-0.5px;color:${PL_INK}">${plEscape(i.amountLabel)}</p>` +
    `</td></tr>` +
    detail +
    `<tr><td align="center" style="padding:22px 36px 36px;text-align:center">` +
    note +
    button +
    (i.expiresLabel
      ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${PL_MUTED}">${plEscape(i.expiresLabel)}</p>`
      : "") +
    `</td></tr>` +
    `</table>` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:${PL_FONT}"><tr><td align="center" style="padding:24px 0 0;text-align:center">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${PL_MUTED}">Si no hiciste esta compra, ignorá este email.</p>` +
    `<img src="${PL_LOGO_POS}" alt="NinjaPOS" height="20" style="display:block;margin:0 auto;height:20px;border:0" />` +
    `<p style="margin:6px 0 0;font-size:11px;line-height:1.5;color:#9ca3af">Enviado con NinjaPos</p>` +
    `</td></tr></table>` +
    `</td></tr></table></body></html>`
  );
}
// </payment-link-template>
