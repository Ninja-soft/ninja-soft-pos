// Personalización de comprobantes (ADR-112). PURO.
//
// `tenant_branding.invoice_style` (jsonb) guarda la elección del negocio; acá
// se normaliza (defaults para todo lo que falte) y se RESUELVE contra la marca
// y el plan:
//   · Color de resalte: el de la marca de la tienda (tenant_branding.accent)
//     o, si no tiene, el de Ninja POS. Con `accent_mode: custom`, uno propio.
//   · Logo: el de la tienda o, si no tiene, el de Ninja POS. Con
//     `logo_mode: custom`, uno subido sólo para comprobantes; `none`, sin logo.
//   · Sello "Un software de Ninja Soft" con su logo: visible por defecto;
//     ocultarlo pide `comprobantes_sin_sello`.
//   · Modelos no clásicos, color y logo propios y leyendas propias piden
//     `tickets_pro`.
// Si el plan ya no incluye algo, el render vuelve al default (la base también
// lo bloquea al guardar: trg_assert_invoice_style_feature).

import { isA4Model, isTicketModel, a4ModelIsPro, ticketModelIsPro, type A4Model, type TicketModel } from "./models";

export const NINJA_POS_ACCENT = "#FF4B22";
/** Logos oficiales (public/brand/oficial): *-dark para papel blanco, *-light sobre color. */
export const NINJA_POS_LOGO = { onLight: "/brand/oficial/ninja-pos-dark.webp", onDark: "/brand/oficial/ninja-pos-light.webp" };
export const NINJA_SOFT_LOGO = { onLight: "/brand/oficial/ninja-soft-dark.webp", onDark: "/brand/oficial/ninja-soft-light.webp" };
export const NINJA_SEAL_TEXT = "Un software de Ninja Soft";

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface InvoiceStyleSettings {
  a4_model: A4Model;
  ticket_model: TicketModel;
  accent_mode: "brand" | "custom";
  accent_custom: string | null;
  logo_mode: "brand" | "custom" | "none";
  logo_custom_url: string | null;
  /** Sello "Un software de Ninja Soft" (por defecto visible). */
  show_ninja_seal: boolean;
  /** Leyendas propias (una por línea). */
  legends: string;
  /** Nombre de fantasía sobre la razón social. */
  trade_name: string;
  show_payments: boolean;
  show_internal_ref: boolean;
  /** Copias de la hoja A4: 1 = Original; 2 = Original y Duplicado. */
  a4_copies: 1 | 2;
  /** Formato del PDF que se adjunta al email. */
  email_format: "ticket" | "a4";
}

export const DEFAULT_INVOICE_STYLE: InvoiceStyleSettings = {
  a4_model: "clasico",
  ticket_model: "clasico",
  accent_mode: "brand",
  accent_custom: null,
  logo_mode: "brand",
  logo_custom_url: null,
  show_ninja_seal: true,
  legends: "",
  trade_name: "",
  show_payments: true,
  show_internal_ref: true,
  a4_copies: 1,
  email_format: "ticket",
};

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Normaliza lo guardado (jsonb libre) a settings completos y válidos. */
export function normalizeInvoiceStyle(raw: unknown): InvoiceStyleSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_INVOICE_STYLE;
  const accent = typeof r.accent_custom === "string" && HEX.test(r.accent_custom) ? r.accent_custom : null;
  const logo = typeof r.logo_custom_url === "string" && r.logo_custom_url.trim() ? r.logo_custom_url.trim() : null;
  return {
    a4_model: isA4Model(r.a4_model) ? r.a4_model : d.a4_model,
    ticket_model: isTicketModel(r.ticket_model) ? r.ticket_model : d.ticket_model,
    accent_mode: r.accent_mode === "custom" && accent ? "custom" : "brand",
    accent_custom: accent,
    logo_mode: r.logo_mode === "none" ? "none" : r.logo_mode === "custom" && logo ? "custom" : "brand",
    logo_custom_url: logo,
    show_ninja_seal: bool(r.show_ninja_seal, true),
    legends: str(r.legends),
    trade_name: str(r.trade_name, 120),
    show_payments: bool(r.show_payments, d.show_payments),
    show_internal_ref: bool(r.show_internal_ref, d.show_internal_ref),
    a4_copies: r.a4_copies === 2 ? 2 : 1,
    email_format: r.email_format === "a4" ? "a4" : "ticket",
  };
}

/**
 * ¿La elección pide `tickets_pro`? Espejo EXACTO de la función SQL
 * invoice_style_needs_pro (trigger de tenant_branding).
 */
export function invoiceStyleNeedsPro(s: InvoiceStyleSettings): boolean {
  return (
    a4ModelIsPro(s.a4_model) ||
    ticketModelIsPro(s.ticket_model) ||
    s.accent_mode === "custom" ||
    s.logo_mode === "custom" ||
    s.legends.trim() !== ""
  );
}

/** ¿La elección pide `comprobantes_sin_sello`? */
export const invoiceStyleNeedsUnbranded = (s: InvoiceStyleSettings) => s.show_ninja_seal === false;

/** Vuelve al default lo que el plan no incluye. */
export function clampInvoiceStyle(s: InvoiceStyleSettings, ent: InvoiceEntitlements): InvoiceStyleSettings {
  const out = { ...s };
  if (!ent.pro) {
    if (a4ModelIsPro(out.a4_model)) out.a4_model = "clasico";
    if (ticketModelIsPro(out.ticket_model)) out.ticket_model = "clasico";
    if (out.accent_mode === "custom") out.accent_mode = "brand";
    if (out.logo_mode === "custom") out.logo_mode = "brand";
    out.legends = "";
  }
  if (!ent.unbranded) out.show_ninja_seal = true;
  return out;
}

export interface InvoiceEntitlements {
  /** `tickets_pro`. */
  pro: boolean;
  /** `comprobantes_sin_sello`. */
  unbranded: boolean;
}

/** Marca de base para resolver los defaults (tenant_branding o la plataforma). */
export interface InvoiceBrandInput {
  accent?: string | null;
  logo_url?: string | null;
}

/** Defaults cuando la tienda no tiene marca: Ninja POS (negocios) o Ninja Soft (plataforma). */
export interface InvoiceDefaults {
  accent: string;
  logo: { onLight: string; onDark: string };
}

export const BUSINESS_DEFAULTS: InvoiceDefaults = { accent: NINJA_POS_ACCENT, logo: NINJA_POS_LOGO };
export const PLATFORM_DEFAULTS: InvoiceDefaults = { accent: NINJA_POS_ACCENT, logo: NINJA_SOFT_LOGO };

export interface ResolvedInvoiceStyle {
  a4Model: A4Model;
  ticketModel: TicketModel;
  /** Color de resalte (#rrggbb). */
  accent: string;
  /** Texto sobre el color de resalte (blanco o casi negro). */
  accentInk: string;
  /** Color de resalte apto para texto sobre papel blanco (contraste >= 3:1). */
  accentText: string;
  /** Tinte muy suave del resalte (fondos de cajas y filas). */
  accentSoft: string;
  /** Logo sobre papel blanco; null = sin logo. */
  logoUrl: string | null;
  /** Logo para usar sobre la banda de color. */
  logoOnAccentUrl: string | null;
  /** El logo es el de Ninja POS (la tienda no tiene uno). */
  logoIsDefault: boolean;
  showSeal: boolean;
  legends: string[];
  tradeName: string | null;
  showPayments: boolean;
  showInternalRef: boolean;
  a4Copies: 1 | 2;
  emailFormat: "ticket" | "a4";
}

// --- Color ---------------------------------------------------------------
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}
/** Mezcla `hex` con `base` (0 = base, 1 = hex). */
export function mix(hex: string, base: string, t: number): string {
  const a = rgb(hex);
  const b = rgb(base);
  return toHex([0, 1, 2].map((i) => b[i]! + (a[i]! - b[i]!) * t) as [number, number, number]);
}

export function accentPalette(accent: string) {
  const a = HEX.test(accent) ? accent : NINJA_POS_ACCENT;
  const ink = contrast(a, "#ffffff") >= 2.6 ? "#ffffff" : "#141414";
  let text = a;
  for (let i = 0; i < 12 && contrast(text, "#ffffff") < 3; i++) text = mix(text, "#000000", 0.85);
  return { accent: a, accentInk: ink, accentText: text, accentSoft: mix(a, "#ffffff", 0.08) };
}

/** Resuelve la elección guardada contra la marca y el plan. */
export function resolveInvoiceStyle(
  raw: unknown,
  brand: InvoiceBrandInput | null | undefined,
  ent: InvoiceEntitlements,
  defaults: InvoiceDefaults = BUSINESS_DEFAULTS,
): ResolvedInvoiceStyle {
  const s = clampInvoiceStyle(normalizeInvoiceStyle(raw), ent);
  const brandAccent = brand?.accent && HEX.test(brand.accent) ? brand.accent : null;
  const accent = s.accent_mode === "custom" && s.accent_custom ? s.accent_custom : brandAccent ?? defaults.accent;
  const brandLogo = brand?.logo_url?.trim() || null;
  let logoUrl: string | null;
  let logoOnAccentUrl: string | null;
  let logoIsDefault = false;
  if (s.logo_mode === "none") {
    logoUrl = null;
    logoOnAccentUrl = null;
  } else if (s.logo_mode === "custom" && s.logo_custom_url) {
    logoUrl = s.logo_custom_url;
    logoOnAccentUrl = s.logo_custom_url;
  } else if (brandLogo) {
    logoUrl = brandLogo;
    logoOnAccentUrl = brandLogo;
  } else {
    logoUrl = defaults.logo.onLight;
    logoOnAccentUrl = defaults.logo.onDark;
    logoIsDefault = true;
  }
  return {
    a4Model: s.a4_model,
    ticketModel: s.ticket_model,
    ...accentPalette(accent),
    logoUrl,
    logoOnAccentUrl,
    logoIsDefault,
    showSeal: s.show_ninja_seal,
    legends: s.legends
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
    tradeName: s.trade_name.trim() || null,
    showPayments: s.show_payments,
    showInternalRef: s.show_internal_ref,
    a4Copies: s.a4_copies,
    emailFormat: s.email_format,
  };
}
