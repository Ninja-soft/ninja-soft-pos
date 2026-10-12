// =============================================================================
// Builders canónicos del HTML del email de comprobante (H9b PR5 + PR8).
// Funciones de string PURAS, sin imports: las usa el PREVIEW del cliente
// (TenantEmailCard). La Edge Function send_receipt_email mantiene su PROPIA copia
// de este bloque (los deploys single-file de Deno no pueden importar lib/).
//
// MANTENER EN ESPEJO con supabase/functions/send_receipt_email/index.ts: el
// bloque entre los marcadores <receipt-templates> es idéntico en los dos
// archivos salvo la palabra `export` (tests/unit/emailTemplates.test.ts lo
// verifica).
//
// Diseño: el mismo sistema de los emails de NinjaPos (lib/email/layout.ts: fondo
// #f3f2f8, tarjeta redondeada, ícono en círculo, eyebrow, botón y footer) pero
// con la marca del NEGOCIO: su logo (o su inicial si no tiene), su color de
// acento y su nombre. Solo tablas y estilos inline (Gmail / Outlook).
// =============================================================================

// <receipt-templates>
export type BodyTemplateKey = "brand" | "clean" | "dark" | "warm" | "minimal";

export const RECEIPT_APP_URL = "https://pos.soft.ninja";
// Logo oficial de NinjaPOS con texto negro (va sobre el fondo claro del footer).
export const NINJA_POS_LOGO_ON_LIGHT =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
export const FOOTER_TEXT = "Enviado con NinjaPos";
export const ATTACH_NOTE = "Tu comprobante va adjunto en PDF a este email.";
const RECEIPT_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const RECEIPT_PAGE_BG = "#f3f2f8";
const RECEIPT_INK = "#09051C";

/** Escapa datos provistos por el usuario antes de interpolarlos en HTML. */
export function escapeHtml(s: string): string {
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
export function mixHex(a: string, b: string, t: number): string {
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
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Color de texto legible sobre un fondo dado (blanco o tinta). */
export function textOn(bg: string): string {
  return luminance(bg) > 0.45 ? RECEIPT_INK : "#ffffff";
}

export interface ReceiptCtx {
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

export interface BuildReceiptEmailInput {
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
export function buildReceiptEmailHtml(
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
