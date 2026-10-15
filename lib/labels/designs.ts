// Diseños de etiqueta (ADR-148 · H24 etiquetas PRO). Lógica pura, sin React.
//
// Un diseño = un modelo (layout) + qué datos se muestran + estilo
// (tipografía, tamaños, alineación, borde y color de las bandas). Los
// modelos de fábrica se pueden usar tal cual; personalizarlos, guardarlos
// como plantillas del negocio y sumar el QR a la ficha pública es PRO
// (feature `etiquetas_pro`).

export type LayoutKey =
  | "gondola"
  | "precio_grande"
  | "oferta"
  | "minimal"
  | "logo"
  | "foto"
  | "solo_codigo"
  | "colgante";

export type FieldKey =
  | "name"
  | "variant"
  | "brand"
  | "price"
  | "prevPrice"
  | "unitPrice"
  | "plu"
  | "sku"
  | "barcode"
  | "qr"
  | "date"
  | "logo"
  | "image";

export type FontKey = "sans" | "condensed" | "rounded" | "serif" | "mono";
export type BorderKey = "none" | "thin" | "thick" | "rounded" | "dashed";
export type AlignKey = "left" | "center" | "right";
export type Symbology = "auto" | "ean13" | "code128" | "code39";
export type DecimalsMode = "auto" | "always" | "never";

export interface LabelDesign {
  layout: LayoutKey;
  show: Record<FieldKey, boolean>;
  font: FontKey;
  /** Multiplicadores de tamaño (0,6 a 1,6). */
  nameScale: number;
  priceScale: number;
  align: AlignKey;
  border: BorderKey;
  /** Color de las bandas planas del impreso (oferta, encabezado). */
  accent: string;
  /** Nombre en mayúsculas. */
  uppercase: boolean;
  /** Centavos del precio: auto (sólo si hay), siempre o nunca. */
  decimals: DecimalsMode;
  symbology: Symbology;
  /** Texto de la banda de oferta. */
  offerText: string;
  /** Leyenda chica al pie (ej. "Precio final con IVA"). Vacío = sin leyenda. */
  footer: string;
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: "Nombre",
  variant: "Variante",
  brand: "Marca",
  price: "Precio",
  prevPrice: "Precio anterior",
  unitPrice: "Precio por kg / l",
  plu: "PLU",
  sku: "SKU",
  barcode: "Código de barras",
  qr: "QR a la ficha",
  date: "Fecha",
  logo: "Logo del negocio",
  image: "Foto del producto",
};

export const FONT_OPTIONS: { key: FontKey; label: string; stack: string }[] = [
  { key: "sans", label: "Moderna", stack: "Inter, 'Helvetica Neue', Arial, sans-serif" },
  { key: "condensed", label: "Condensada", stack: "'Roboto Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif" },
  { key: "rounded", label: "Redondeada", stack: "Nunito, 'Arial Rounded MT Bold', Arial, sans-serif" },
  { key: "serif", label: "Clásica", stack: "'Playfair Display', Georgia, 'Times New Roman', serif" },
  { key: "mono", label: "Técnica", stack: "'JetBrains Mono', 'Courier New', monospace" },
];

export const BORDER_OPTIONS: { key: BorderKey; label: string }[] = [
  { key: "none", label: "Sin borde" },
  { key: "thin", label: "Fino" },
  { key: "thick", label: "Grueso" },
  { key: "rounded", label: "Redondeado" },
  { key: "dashed", label: "Punteado" },
];

export const ACCENT_SWATCHES = ["#111111", "#E11D2E", "#FF4B22", "#F5B800", "#16A34A", "#2563EB", "#3B237A", "#DB2777"];

const ALL_OFF: Record<FieldKey, boolean> = {
  name: false,
  variant: false,
  brand: false,
  price: false,
  prevPrice: false,
  unitPrice: false,
  plu: false,
  sku: false,
  barcode: false,
  qr: false,
  date: false,
  logo: false,
  image: false,
};

const on = (...keys: FieldKey[]): Record<FieldKey, boolean> => {
  const s = { ...ALL_OFF };
  for (const k of keys) s[k] = true;
  return s;
};

const BASE: Omit<LabelDesign, "layout" | "show"> = {
  font: "sans",
  nameScale: 1,
  priceScale: 1,
  align: "center",
  border: "thin",
  accent: "#111111",
  uppercase: true,
  decimals: "auto",
  symbology: "auto",
  offerText: "OFERTA",
  footer: "",
};

export interface DesignPreset {
  key: string;
  label: string;
  hint: string;
  /** Modelo de fábrica que se puede usar sin el plan PRO. */
  basic: boolean;
  design: LabelDesign;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    key: "gondola",
    label: "Góndola clásico",
    hint: "Nombre, precio, PLU y código de barras",
    basic: true,
    design: { ...BASE, layout: "gondola", show: on("name", "variant", "price", "unitPrice", "plu", "barcode") },
  },
  {
    key: "precio_grande",
    label: "Precio grande",
    hint: "El precio se lee a dos metros",
    basic: false,
    design: { ...BASE, layout: "precio_grande", priceScale: 1.15, show: on("name", "variant", "price", "unitPrice", "plu") },
  },
  {
    key: "oferta",
    label: "Oferta",
    hint: "Banda de color y precio anterior tachado",
    basic: false,
    design: { ...BASE, layout: "oferta", accent: "#E11D2E", show: on("name", "variant", "price", "prevPrice", "unitPrice", "barcode") },
  },
  {
    key: "minimal",
    label: "Minimal",
    hint: "Limpio, alineado a la izquierda",
    basic: true,
    design: { ...BASE, layout: "minimal", align: "left", border: "none", uppercase: false, show: on("name", "variant", "brand", "price") },
  },
  {
    key: "logo",
    label: "Con logo",
    hint: "Tu marca arriba, ideal para boutique",
    basic: false,
    design: { ...BASE, layout: "logo", font: "rounded", accent: "#3B237A", show: on("logo", "name", "variant", "price", "barcode") },
  },
  {
    key: "foto",
    label: "Con foto",
    hint: "Foto del producto al costado",
    basic: false,
    design: { ...BASE, layout: "foto", align: "left", uppercase: false, show: on("image", "name", "variant", "brand", "price", "barcode") },
  },
  {
    key: "solo_codigo",
    label: "Sólo código",
    hint: "Para identificar mercadería en depósito",
    basic: true,
    design: { ...BASE, layout: "solo_codigo", border: "none", show: on("name", "variant", "barcode", "sku") },
  },
  {
    key: "colgante",
    label: "Colgante / joyería",
    hint: "Con agujero para el hilo, ropa y regalería",
    basic: false,
    design: { ...BASE, layout: "colgante", font: "serif", border: "rounded", uppercase: false, show: on("brand", "name", "variant", "price", "barcode") },
  },
];

export const DEFAULT_DESIGN: LabelDesign = DESIGN_PRESETS[0]!.design;

export function presetByKey(key: string): DesignPreset | undefined {
  return DESIGN_PRESETS.find((p) => p.key === key);
}

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 1);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Completa y acota un diseño que viene de una plantilla guardada (jsonb). */
export function normalizeDesign(raw: unknown): LabelDesign {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LabelDesign>;
  const preset = presetByKey(String(r.layout ?? "")) ?? DESIGN_PRESETS[0]!;
  const base = preset.design;
  const show = { ...base.show };
  if (r.show && typeof r.show === "object") {
    for (const k of Object.keys(ALL_OFF) as FieldKey[]) {
      const v = (r.show as Record<string, unknown>)[k];
      if (typeof v === "boolean") show[k] = v;
    }
  }
  const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
  return {
    layout: preset.design.layout,
    show,
    font: pick(r.font, ["sans", "condensed", "rounded", "serif", "mono"] as const, base.font),
    nameScale: clamp(Number(r.nameScale ?? base.nameScale), 0.6, 1.6),
    priceScale: clamp(Number(r.priceScale ?? base.priceScale), 0.6, 1.6),
    align: pick(r.align, ["left", "center", "right"] as const, base.align),
    border: pick(r.border, ["none", "thin", "thick", "rounded", "dashed"] as const, base.border),
    accent: typeof r.accent === "string" && HEX.test(r.accent) ? r.accent : base.accent,
    uppercase: typeof r.uppercase === "boolean" ? r.uppercase : base.uppercase,
    decimals: pick(r.decimals, ["auto", "always", "never"] as const, base.decimals),
    symbology: pick(r.symbology, ["auto", "ean13", "code128", "code39"] as const, base.symbology),
    offerText: typeof r.offerText === "string" ? r.offerText.slice(0, 20) : base.offerText,
    footer: typeof r.footer === "string" ? r.footer.slice(0, 60) : base.footer,
  };
}

/**
 * ¿El diseño necesita el plan PRO? Los modelos básicos de fábrica, sin tocar
 * y sin QR, son de todos los planes. Cualquier personalización, un modelo
 * PRO o el QR a la ficha pública piden `etiquetas_pro`.
 */
export function designNeedsPro(d: LabelDesign): boolean {
  if (d.show.qr) return true;
  const preset = DESIGN_PRESETS.find((p) => p.design.layout === d.layout);
  if (!preset || !preset.basic) return true;
  return JSON.stringify(normalizeDesign(d)) !== JSON.stringify(normalizeDesign(preset.design));
}

/** Color de texto legible sobre la banda (blanco o negro según luminancia). */
export function inkOn(hex: string): string {
  if (!HEX.test(hex)) return "#fff";
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#000" : "#fff";
}
