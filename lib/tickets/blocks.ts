// H9b — Modelo de bloques del ticket. El content JSONB de ticket_templates
// (mode: blocks) es { blocks: TicketBlock[] }. Ver spec 2026-06-06-h9b.
import type { CSSProperties } from "react";

export type Align = "left" | "center" | "right";
export type TextSize = "sm" | "md" | "lg";
export type FontFamily = "mono" | "sans" | "serif";

interface Base {
  id: string;
  hidden?: boolean;
}
// Estilo visual opcional para bloques de texto (title/text/footer). Todo
// opcional → cero cambio visual cuando no se setea. color/bg son hex (#rrggbb).
export interface TextStyle {
  color?: string;
  bg?: string;
  font?: FontFamily;
}
export type TicketBlock =
  | (Base & { type: "logo" })
  | (Base & { type: "business"; showLegalName?: boolean; showCuit?: boolean; showAddress?: boolean; showPhone?: boolean })
  | (Base & TextStyle & { type: "title"; text?: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "saleInfo"; showNumber?: boolean; showDate?: boolean })
  | (Base & { type: "customer" })
  | (Base & { type: "items"; showUnitPrice?: boolean })
  | (Base & { type: "totals" })
  | (Base & { type: "payments" })
  | (Base & { type: "qr" })
  | (Base & { type: "barcode" })
  | (Base & TextStyle & { type: "text"; text: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "image"; url: string; widthPct?: number; align?: Align })
  | (Base & { type: "separator"; style?: "dashed" | "solid" | "double"; color?: string })
  | (Base & TextStyle & { type: "footer"; text?: string });

export type BlockType = TicketBlock["type"];

// --- Helpers de estilo visual (compartidos por los renderers) ---
const HEX = /^#[0-9a-fA-F]{6}$/;
export const FONT_STACK: Record<FontFamily, string> = {
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "system-ui, -apple-system, Segoe UI, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

// Construye el style inline para color/bg/font/fontSize, ignorando hex inválidos.
export function styleProps(s: {
  color?: string;
  bg?: string;
  font?: FontFamily;
  fontSize?: number;
}): CSSProperties {
  const out: CSSProperties = {};
  if (s.color && HEX.test(s.color)) out.color = s.color;
  if (s.bg && HEX.test(s.bg)) out.backgroundColor = s.bg;
  if (s.font) out.fontFamily = FONT_STACK[s.font];
  if (typeof s.fontSize === "number" && s.fontSize > 0) out.fontSize = `${s.fontSize}px`;
  return out;
}

export interface BlocksContent {
  blocks: TicketBlock[];
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  logo: "Logo del negocio",
  business: "Datos del negocio",
  title: "Título",
  saleInfo: "Datos de la venta",
  customer: "Cliente",
  items: "Ítems",
  totals: "Totales",
  payments: "Medios de pago",
  qr: "QR del comprobante",
  barcode: "Código de barras",
  text: "Texto libre",
  image: "Imagen",
  separator: "Separador",
  footer: "Pie",
};

// IDs cortos para bloques dentro de una plantilla (no son claves de DB).
const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export function newBlock(type: BlockType): TicketBlock {
  const id = uid();
  switch (type) {
    case "text":
      return { id, type, text: "Texto", align: "center", size: "md" };
    case "image":
      return { id, type, url: "", widthPct: 100, align: "center" };
    case "title":
      return { id, type, align: "center", size: "md" };
    case "items":
      return { id, type, showUnitPrice: false };
    case "saleInfo":
      return { id, type, showNumber: true, showDate: true };
    case "business":
      return { id, type, showLegalName: true, showCuit: true, showAddress: true, showPhone: true };
    default:
      return { id, type } as TicketBlock;
  }
}

// --- Modo canvas (elementos con posición libre; ver spec H9b) ---
export type CanvasElementType =
  | "text" | "image" | "logo" | "qr" | "barcode" | "separator" | "items";

// v2: lienzo de ancho fijo en px por tipo de papel. El editor (react-rnd) y el
// renderer trabajan sobre estas dimensiones; el print stylesheet imprime el nodo
// tal cual (px son válidos para impresión).
export const CANVAS_WIDTH: Record<"58" | "80" | "a4", number> = {
  "58": 220,
  "80": 300,
  a4: 794,
};

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  x: number; // px desde la izquierda
  y: number; // px desde arriba (para "items" marca el punto de flujo)
  w: number; // px de ancho
  h?: number; // px de alto — opcional: texto/separator/items pueden ser auto (undefined)
  text?: string;       // type text
  url?: string;        // type image
  size?: TextSize;     // text
  bold?: boolean;      // text
  align?: Align;       // text/image dentro de su caja
  // Estilo visual opcional (cero cambio cuando ausente). color/bg hex (#rrggbb).
  color?: string;
  bg?: string;
  font?: FontFamily;
  fontSize?: number;   // px — pisa `size` cuando está presente
}

export interface CanvasContent {
  canvas: {
    elements: CanvasElement[];
    height: number; // alto total en px del lienzo (sin contar el alto variable de items)
  };
}

// --- Modo HTML (plantilla con {{variables}}) ---
export interface HtmlContent {
  html: string;
}

export type TemplateContent = BlocksContent | CanvasContent | HtmlContent;

export function newCanvasElement(type: CanvasElementType): CanvasElement {
  const id = uid();
  switch (type) {
    case "text":
      return { id, type, x: 10, y: 20, w: 280, text: "Texto", size: "md", align: "center" };
    case "image":
      return { id, type, x: 20, y: 20, w: 260, h: 160, url: "" };
    case "items":
      return { id, type, x: 0, y: 120, w: 300 };
    case "qr":
      return { id, type, x: 20, y: 20, w: 120, h: 120 };
    case "logo":
      return { id, type, x: 20, y: 20, w: 160, h: 60 };
    case "barcode":
      return { id, type, x: 20, y: 20, w: 260, h: 48 };
    case "separator":
      return { id, type, x: 10, y: 20, w: 280, h: 8 };
    default:
      return { id, type, x: 20, y: 20, w: 260 };
  }
}

// Replica del ticket hard-coded actual (TicketModal) como plantilla inicial.
export function defaultSaleBlocks(): TicketBlock[] {
  return [
    newBlock("logo"),
    newBlock("business"),
    newBlock("title"),
    newBlock("separator"),
    newBlock("saleInfo"),
    newBlock("separator"),
    newBlock("items"),
    newBlock("separator"),
    newBlock("totals"),
    newBlock("separator"),
    newBlock("payments"),
    newBlock("qr"),
    newBlock("footer"),
  ];
}
