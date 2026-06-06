// H9b — Modelo de bloques del ticket. El content JSONB de ticket_templates
// (mode: blocks) es { blocks: TicketBlock[] }. Ver spec 2026-06-06-h9b.
export type Align = "left" | "center" | "right";
export type TextSize = "sm" | "md" | "lg";

interface Base {
  id: string;
  hidden?: boolean;
}
export type TicketBlock =
  | (Base & { type: "logo" })
  | (Base & { type: "business"; showLegalName?: boolean; showCuit?: boolean; showAddress?: boolean; showPhone?: boolean })
  | (Base & { type: "title"; text?: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "saleInfo"; showNumber?: boolean; showDate?: boolean })
  | (Base & { type: "customer" })
  | (Base & { type: "items"; showUnitPrice?: boolean })
  | (Base & { type: "totals" })
  | (Base & { type: "payments" })
  | (Base & { type: "qr" })
  | (Base & { type: "barcode" })
  | (Base & { type: "text"; text: string; align?: Align; size?: TextSize; bold?: boolean })
  | (Base & { type: "image"; url: string; widthPct?: number; align?: Align })
  | (Base & { type: "separator" })
  | (Base & { type: "footer"; text?: string });

export type BlockType = TicketBlock["type"];

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

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  x: number; // % del ancho del papel (0-100)
  y: number; // px desde arriba (zona superior) — para "items" marca el punto de flujo
  w: number; // % del ancho (10-100)
  text?: string;       // type text
  url?: string;        // type image
  size?: TextSize;     // text
  bold?: boolean;      // text
  align?: Align;       // text/image dentro de su caja
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
      return { id, type, x: 5, y: 20, w: 90, text: "Texto", size: "md", align: "center" };
    case "image":
      return { id, type, x: 10, y: 20, w: 80, url: "" };
    case "items":
      return { id, type, x: 0, y: 120, w: 100 };
    default:
      return { id, type, x: 10, y: 20, w: 80 };
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
