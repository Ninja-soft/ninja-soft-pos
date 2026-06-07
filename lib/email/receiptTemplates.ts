// =============================================================================
// Builders canónicos del HTML del email de comprobante (H9b PR5 + PR8).
// Funciones de string PURAS, sin imports de Deno: las usa el PREVIEW del cliente
// (TenantEmailCard). La Edge Function send_receipt_email mantiene su PROPIA copia
// de estas plantillas (los deploys single-file de Deno no pueden importar lib/).
//
// ⚠️ MANTENER EN ESPEJO con supabase/functions/send_receipt_email/index.ts
//    (constante EMAIL_BODY_TEMPLATES + footer). Cualquier cambio de markup/estilo
//    acá debe replicarse allá y viceversa.
// =============================================================================

export type BodyTemplateKey = "brand" | "clean" | "dark" | "warm" | "minimal";

// Wordmark dark-mode de NinjaPos (texto "pos" en blanco → necesita fondo oscuro).
// Usado SOLO en el footer contrastado (fondo oscuro).
export const NINJA_LOGO_DARK_URL =
  "https://ninja-soft-pos.vercel.app/brand/ninjapos-logo-dark-mode.webp";
// Wordmark estándar de NinjaSoft para el fallback del header (puede caer sobre
// fondo claro u oscuro según el diseño; usamos el asset multipropósito).
export const NINJA_LOGO_URL =
  "https://ninja-soft-pos.vercel.app/brand/ninjasoft-wordmark.webp";
export const FOOTER_TEXT = "Enviado con NinjaPos";
export const ATTACH_NOTE = "Tu comprobante va adjunto a este email.";

// Footer contrastado: fondo oscuro (#09051C ninja void) con el wordmark
// dark-mode de NinjaPos + texto tenue. `bg` se sobreescribe en el diseño dark
// (tarjeta ya oscura) para que el footer se separe del cuerpo.
export function footerHtml(bg = "#09051C"): string {
  return `<div style="background:${bg};padding:18px 12px;text-align:center">
    <img src="${NINJA_LOGO_DARK_URL}" alt="NinjaPos" style="max-height:20px;display:inline-block" />
    <div style="color:#9ca3af;font-size:11px;margin-top:8px">${FOOTER_TEXT}</div>
  </div>`;
}

export interface BuildReceiptOpts {
  accent: string;
  // HTML del logo ya armado (img tag). El caller decide tenant-logo vs fallback.
  logoHtml: string;
  // Nombre del negocio, ya escapado.
  safeName: string;
  // Texto del cuerpo, ya escapado.
  safeBodyText: string;
}

const TEMPLATES: Record<BodyTemplateKey, (c: BuildReceiptOpts) => string> = {
  // 1) brand — header con el accent del tenant + logo/nombre.
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

  // 3) dark — tarjeta oscura (#111827), texto claro, divisor accent. Footer con
  // un fondo levemente distinto (#1f2937) para separarse del cuerpo oscuro.
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

/** Escapa datos provistos por el usuario antes de interpolarlos en HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BuildReceiptEmailInput {
  accent: string;
  // URL del logo del tenant ("" → se usa el wordmark dark-mode de NinjaPos).
  logoUrl: string;
  // Nombre del negocio (sin escapar).
  name: string;
  // Texto del cuerpo (sin escapar).
  bodyText: string;
}

/**
 * Construye el HTML completo del email del comprobante para un diseño dado.
 * Strings estáticos confiables + inputs escapados. Usado por el PREVIEW del
 * cliente (dangerouslySetInnerHTML). Espejo de la Edge Function.
 */
export function buildReceiptEmailHtml(
  design: BodyTemplateKey,
  { accent, logoUrl, name, bodyText }: BuildReceiptEmailInput,
): string {
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#111827";
  const safeName = escapeHtml(name || "NinjaSoft POS");
  const safeBodyText = escapeHtml(
    bodyText || "¡Gracias por tu compra! Te enviamos tu comprobante.",
  );
  const safeLogo = escapeHtml(logoUrl.trim());
  // Logo del tenant si tiene; si no, el wordmark estándar de NinjaSoft.
  const logoHtml = safeLogo
    ? `<img src="${safeLogo}" alt="${safeName}" style="max-height:48px;display:inline-block" />`
    : `<img src="${NINJA_LOGO_URL}" alt="NinjaSoft" style="max-height:32px;display:inline-block" />`;
  const build = TEMPLATES[design] ?? TEMPLATES.brand;
  return build({ accent: safeAccent, logoHtml, safeName, safeBodyText });
}
