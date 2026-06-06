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

const uid = () => Math.random().toString(36).slice(2, 10);

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
