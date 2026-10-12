// =============================================================================
// Layout de los emails del sistema NinjaPos, con el lenguaje visual de Ninja
// Soft (ver ninja-soft-web, plantillas v3): fondo #f3f2f8, header oscuro
// #09051C con brillo de fuego, isotipo de la llama + logo de NinjaPOS, cuerpo
// blanco con ícono en círculo suave, eyebrow naranja, título grande, botón
// pastilla con degradé y footer claro con logos y dirección.
//
// Reglas para que se vea bien en Gmail y Outlook:
//   - Solo tablas + estilos inline (los clientes descartan <style> y clases).
//   - Imágenes PNG con URL absoluta (WebP no se ve en Outlook).
//   - Botón "a prueba de balas": celda con bgcolor + degradé como mejora.
//   - Los degradés y bordes redondeados son mejora progresiva: Outlook cae al
//     color sólido, que ya alcanza para que se lea bien.
//
// Todo el HTML que recibe este builder es CONFIABLE (sale del catálogo o del
// generador de la migración), no de input de usuario: no se escapa acá.
// =============================================================================

export const APP_URL = "https://pos.soft.ninja";

// Logos oficiales (Cloudinary, PNG). "Light" = texto blanco (fondo oscuro),
// "Dark" = texto negro (fondo claro).
export const LOGO_POS_ON_DARK =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Light_glckmm";
export const LOGO_POS_ON_LIGHT =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_POS_Dark_majzi0";
export const LOGO_SOFT_ON_LIGHT =
  "https://res.cloudinary.com/dl6yhrcx0/image/upload/f_png,h_120/Ninja_Soft_Dark_h9aklw";
export const FLAME_ISOTIPO =
  "https://tgaromemhaixgdsdlxiq.supabase.co/storage/v1/object/public/brand/ninja-isotipo-flame.png";

export const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const COLORS = {
  page: "#f3f2f8",
  ink: "#09051C",
  muted: "#6b7280",
  faint: "#9ca3af",
  orange: "#ff5a1f",
  gradFrom: "#ff4b22",
  gradTo: "#ff8a1f",
  soft: "#f7f6fb",
  hair: "#ecebf3",
} as const;

export type EmailTone = "brand" | "success" | "danger";

const TONES: Record<EmailTone, { circle: string; eyebrow: string }> = {
  brand: { circle: "#fff1ea", eyebrow: COLORS.orange },
  success: { circle: "#e8f7ee", eyebrow: "#15803d" },
  danger: { circle: "#fdecec", eyebrow: "#dc2626" },
};

export interface EmailLayoutOpts {
  /** Texto oculto que los clientes muestran como vista previa en la bandeja. */
  preheader: string;
  /** Emoji del círculo superior. */
  icon: string;
  /** Rótulo corto en mayúsculas arriba del título. */
  eyebrow: string;
  /** Título principal (HTML confiable). */
  title: string;
  /** Párrafo principal (HTML confiable). */
  intro: string;
  /** Filas de datos clave (etiqueta, valor) en una tarjeta suave. */
  rows?: Array<[string, string]>;
  /** Botón de acción principal. */
  cta?: { href: string; label: string };
  /** Nota chica debajo del botón (HTML confiable). */
  note?: string;
  tone?: EmailTone;
  /** Por qué le llega este email (línea legal del footer). */
  reason?: string;
}

/** Botón pastilla con degradé, a prueba de Outlook (celda con bgcolor). */
export function ctaButton(href: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    `<td align="center" bgcolor="${COLORS.orange}" style="border-radius:999px;background:${COLORS.orange};background-image:linear-gradient(135deg,${COLORS.gradFrom},${COLORS.gradTo})">` +
    `<a href="${href}" target="_blank" style="display:inline-block;padding:16px 36px;font-family:${FONT_STACK};font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px">${label}</a>` +
    `</td></tr></table>`
  );
}

/** Tarjeta de datos clave: fondo suave, filas etiqueta / valor. */
export function infoRows(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value], i) =>
        `<tr>` +
        `<td style="padding:14px 20px;${i ? `border-top:1px solid ${COLORS.hair};` : ""}font-size:14px;line-height:20px;color:${COLORS.muted}">${label}</td>` +
        `<td align="right" style="padding:14px 20px;${i ? `border-top:1px solid ${COLORS.hair};` : ""}font-size:15px;line-height:20px;font-weight:700;color:${COLORS.ink}">${value}</td>` +
        `</tr>`,
    )
    .join("");
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.soft}" style="background:${COLORS.soft};border-radius:16px">` +
    body +
    `</table>`
  );
}

function header(): string {
  return (
    `<tr><td align="center" bgcolor="${COLORS.ink}" style="background:${COLORS.ink};background-image:radial-gradient(120% 90% at 50% 0%,#3a1708 0%,${COLORS.ink} 60%);border-radius:20px 20px 0 0;padding:40px 40px 36px;text-align:center">` +
    `<a href="${APP_URL}" target="_blank" style="text-decoration:none">` +
    `<img src="${FLAME_ISOTIPO}" alt="" width="40" height="52" style="display:block;margin:0 auto 16px;width:40px;height:52px;border:0" />` +
    `<img src="${LOGO_POS_ON_DARK}" alt="NinjaPOS" height="34" style="display:block;margin:0 auto;height:34px;border:0" />` +
    `</a>` +
    `</td></tr>`
  );
}

function footer(reason: string): string {
  const link = (href: string, label: string) =>
    `<a href="${href}" target="_blank" style="color:${COLORS.ink};text-decoration:none;font-weight:600">${label}</a>`;
  return (
    `<tr><td style="padding:16px 0 0">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border-radius:20px"><tr><td align="center" style="padding:32px 32px 28px;text-align:center">` +
    `<img src="${LOGO_POS_ON_LIGHT}" alt="NinjaPOS" height="26" style="display:block;margin:0 auto 10px;height:26px;border:0" />` +
    `<p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:${COLORS.muted}">Vendé, cobrá y controlá tu negocio desde una sola pantalla.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
    `<td style="padding:0 8px 0 0;font-size:12px;line-height:18px;color:${COLORS.faint}">Un producto de</td>` +
    `<td><a href="https://soft.ninja" target="_blank" style="text-decoration:none"><img src="${LOGO_SOFT_ON_LIGHT}" alt="Ninja Soft" height="18" style="display:block;height:18px;border:0" /></a></td>` +
    `</tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 0 18px"><div style="height:1px;line-height:1px;font-size:1px;background:#f0eff5">&nbsp;</div></td></tr></table>` +
    `<p style="margin:0 0 14px;font-size:13px;line-height:1.6">` +
    link(`${APP_URL}/login`, "pos.soft.ninja") +
    ` &nbsp;&middot;&nbsp; ` +
    link("https://soft.ninja", "soft.ninja") +
    ` &nbsp;&middot;&nbsp; ` +
    link("https://www.instagram.com/ninjasoft.latam/", "Instagram") +
    `</p>` +
    `<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${COLORS.faint}">Urquiza 3164 &middot; Rosario, Santa Fe, Argentina</p>` +
    `<p style="margin:0;font-size:11px;line-height:1.6;color:#b0b3ba">${reason}</p>` +
    `</td></tr></table>` +
    `</td></tr>`
  );
}

/**
 * Documento completo de un email del sistema. Devuelve HTML listo para mandar
 * (con doctype, preheader y meta de esquema claro).
 */
export function emailLayout(o: EmailLayoutOpts): string {
  const tone = TONES[o.tone ?? "brand"];
  const reason =
    o.reason ?? "Recibiste este email porque tenés una cuenta en NinjaPos.";
  const hasRows = !!o.rows?.length;

  const hero =
    `<tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:40px 40px 0;text-align:center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px"><tr>` +
    `<td width="72" height="72" align="center" valign="middle" bgcolor="${tone.circle}" style="width:72px;height:72px;border-radius:50%;background:${tone.circle};font-size:32px;line-height:72px;text-align:center">${o.icon}</td>` +
    `</tr></table>` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${tone.eyebrow}">${o.eyebrow}</p>` +
    `<h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.4px;color:${COLORS.ink}">${o.title}</h1>` +
    `<p style="margin:0 auto;max-width:420px;font-size:16px;line-height:1.6;color:${COLORS.muted}">${o.intro}</p>` +
    `</td></tr>`;

  const rows = hasRows
    ? `<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 40px 0">${infoRows(o.rows!)}</td></tr>`
    : "";

  const closing =
    `<tr><td align="center" bgcolor="#ffffff" style="background:#ffffff;padding:${o.cta || o.note ? "32px" : "4px"} 40px 44px;text-align:center;border-radius:0 0 20px 20px">` +
    (o.cta ? ctaButton(o.cta.href, o.cta.label) : "") +
    (o.note
      ? `<p style="margin:${o.cta ? "16px" : "0"} auto 0;max-width:400px;font-size:13px;line-height:1.5;color:${COLORS.faint}">${o.note}</p>`
      : "") +
    `</td></tr>`;

  return (
    `<!doctype html>` +
    `<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>NinjaPos</title></head>` +
    `<body style="margin:0;padding:0;background:${COLORS.page};-webkit-font-smoothing:antialiased">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${o.preheader}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background:${COLORS.page}"><tr><td align="center" style="padding:28px 12px 40px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;font-family:${FONT_STACK}">` +
    header() +
    hero +
    rows +
    closing +
    footer(reason) +
    `</table></td></tr></table></body></html>`
  );
}

// Marcadores del layout genérico (eyebrow + título + texto) que usan los avisos
// armados fuera del catálogo: _dunning_email_html (SQL) y el fallback de
// mp_billing_webhook. scripts/gen-email-templates-sql.ts los reemplaza por
// expresiones SQL o copia el template al webhook; acá no se escapan.
export const FALLBACK_TOKENS = {
  eyebrow: "@@EYEBROW@@",
  title: "@@TITLE@@",
  body: "@@BODY@@",
} as const;

/** Layout genérico con marcadores, para los avisos sin plantilla propia. */
export function fallbackLayoutTemplate(): string {
  return emailLayout({
    preheader: FALLBACK_TOKENS.body,
    icon: "🔔",
    eyebrow: FALLBACK_TOKENS.eyebrow,
    title: FALLBACK_TOKENS.title,
    intro: FALLBACK_TOKENS.body,
    cta: { href: `${APP_URL}/login`, label: "Ir a NinjaPos" },
  });
}
