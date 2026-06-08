// =============================================================================
// lib/print/profiles.ts  (F10 / H22 — config de impresión por tipo de documento)
// Lógica PURA (sin React, sin fetch): tipos, defaults, papeles permitidos por
// tipo y normalización de lo que viene de pos_settings.print_profiles (jsonb).
//
// ALCANCE H22 (buildable, POR TENANT): el negocio configura, por tipo de
// documento, el formato/destino, las copias y si la impresión es automática o
// manual. El POS lee este perfil al imprimir (ticket de venta, cierre Z,
// devolución, etiqueta) para elegir formato/copias y respetar auto/manual.
//
// LÍMITE ACTUAL Y FUTURO (documentado también en la UI):
//   * La impresión es WEB (`window.print()`): sale por el diálogo del navegador
//     y depende de la impresora elegida por el SO. No hay corte de papel ni
//     apertura de cajón por software.
//   * ESC/POS por conector local (app/servicio para térmicas USB/LAN/Bluetooth),
//     y la COLA DE IMPRESIÓN con reintentos (pendiente/impreso/fallido/reimprimir)
//     quedan para una etapa futura (F4). No se simulan acá.
//   * Perfiles POR SUCURSAL / CAJA quedan para F4 (multi-caja). Hoy el perfil es
//     único por tenant.
// =============================================================================

// Tipos de documento configurables. Las claves coinciden con el jsonb de la DB.
export type PrintDocType =
  | "sale" // ticket de venta
  | "z_close" // cierre Z de caja
  | "cash_movement" // movimiento de caja (ingreso/egreso)
  | "product_label" // etiqueta de producto
  | "return"; // devolución / nota de crédito

export type PrintPaper = "58" | "80" | "a4";
export type PrintFont = "sm" | "md" | "lg";
export type PrintMargin = "none" | "narrow" | "normal";

export interface PrintProfile {
  paper: PrintPaper;
  copies: number;
  auto: boolean;
  font: PrintFont;
  margin: PrintMargin;
}

export type PrintProfiles = Record<PrintDocType, PrintProfile>;

// Orden canónico de los tipos (para iterar la UI de forma estable).
export const PRINT_DOC_TYPES: PrintDocType[] = [
  "sale",
  "z_close",
  "cash_movement",
  "product_label",
  "return",
];

// Metadata de presentación por tipo: etiqueta, descripción y papeles válidos.
// La etiqueta de producto sale en térmica/etiquetadora (58/80), no en A4; el
// resto admite los tres formatos.
export const PRINT_DOC_META: Record<
  PrintDocType,
  { label: string; description: string; papers: PrintPaper[] }
> = {
  sale: {
    label: "Ticket de venta",
    description: "Comprobante que se imprime al cobrar una venta.",
    papers: ["58", "80", "a4"],
  },
  z_close: {
    label: "Cierre Z",
    description: "Resumen del turno de caja (cierre Z) desde Caja.",
    papers: ["58", "80", "a4"],
  },
  cash_movement: {
    label: "Movimiento de caja",
    description: "Comprobante de un ingreso o egreso de caja.",
    papers: ["58", "80", "a4"],
  },
  product_label: {
    label: "Etiqueta de producto",
    description: "Etiqueta de góndola con nombre, precio y código.",
    papers: ["58", "80"],
  },
  return: {
    label: "Devolución / nota de crédito",
    description: "Comprobante de una devolución o el vale emitido.",
    papers: ["58", "80", "a4"],
  },
};

export const PAPER_LABELS: Record<PrintPaper, string> = {
  "58": "58 mm (térmica angosta)",
  "80": "80 mm (térmica)",
  a4: "A4 (hoja / PDF)",
};

export const FONT_LABELS: Record<PrintFont, string> = {
  sm: "Chica",
  md: "Normal",
  lg: "Grande",
};

export const MARGIN_LABELS: Record<PrintMargin, string> = {
  none: "Sin margen",
  narrow: "Angosto",
  normal: "Normal",
};

// Default por tipo. Coincide con el default de la migración para que la UI sin
// fila guardada muestre exactamente lo que el server asumiría.
export function defaultProfile(type: PrintDocType): PrintProfile {
  if (type === "product_label") {
    return { paper: "58", copies: 1, auto: false, font: "sm", margin: "narrow" };
  }
  return { paper: "80", copies: 1, auto: false, font: "md", margin: "normal" };
}

export function defaultPrintProfiles(): PrintProfiles {
  return {
    sale: defaultProfile("sale"),
    z_close: defaultProfile("z_close"),
    cash_movement: defaultProfile("cash_movement"),
    product_label: defaultProfile("product_label"),
    return: defaultProfile("return"),
  };
}

const PAPERS: PrintPaper[] = ["58", "80", "a4"];
const FONTS: PrintFont[] = ["sm", "md", "lg"];
const MARGINS: PrintMargin[] = ["none", "narrow", "normal"];

// Copias válidas (1..20). El POS imprime hasta este tope por documento.
export function clampPrintCopies(n: unknown): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(20, v));
}

// Papel válido para un tipo: si el guardado no aplica al tipo (ej. A4 en
// etiqueta), cae al papel por default del tipo; si ese tampoco fuera válido,
// al primero permitido.
export function coercePaper(type: PrintDocType, paper: unknown): PrintPaper {
  const allowed = PRINT_DOC_META[type].papers;
  if (allowed.includes(paper as PrintPaper)) return paper as PrintPaper;
  const fallback = defaultProfile(type).paper;
  return allowed.includes(fallback) ? fallback : allowed[0]!;
}

function coerceFont(font: unknown): PrintFont {
  return FONTS.includes(font as PrintFont) ? (font as PrintFont) : "md";
}

function coerceMargin(margin: unknown): PrintMargin {
  return MARGINS.includes(margin as PrintMargin)
    ? (margin as PrintMargin)
    : "normal";
}

// Normaliza un perfil suelto (lo que viene del jsonb) a uno válido para el tipo.
export function normalizeProfile(type: PrintDocType, raw: unknown): PrintProfile {
  const o = (raw ?? {}) as Partial<Record<keyof PrintProfile, unknown>>;
  const base = defaultProfile(type);
  return {
    paper: coercePaper(type, o.paper ?? base.paper),
    copies: o.copies == null ? base.copies : clampPrintCopies(o.copies),
    auto: typeof o.auto === "boolean" ? o.auto : base.auto,
    font: coerceFont(o.font ?? base.font),
    margin: coerceMargin(o.margin ?? base.margin),
  };
}

// Normaliza el objeto completo de pos_settings.print_profiles. Tolera null,
// claves faltantes o tipos basura: siempre devuelve los 5 perfiles válidos.
export function normalizePrintProfiles(raw: unknown): PrintProfiles {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    sale: normalizeProfile("sale", o.sale),
    z_close: normalizeProfile("z_close", o.z_close),
    cash_movement: normalizeProfile("cash_movement", o.cash_movement),
    product_label: normalizeProfile("product_label", o.product_label),
    return: normalizeProfile("return", o.return),
  };
}

// Sólo se exporta PAPERS/FONTS/MARGINS de forma indirecta vía las labels; estas
// listas se reusan en la UI para construir los selectores sin recalcularlas.
export const ALL_PAPERS = PAPERS;
export const ALL_FONTS = FONTS;
export const ALL_MARGINS = MARGINS;
