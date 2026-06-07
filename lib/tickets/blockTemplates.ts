// H9b PR4 — Modelos precargados para el modo "blocks" del ticket.
// Cada entrada arma su lista de bloques con newBlock(type) + overrides.
// Espeja la forma de HTML_STARTER_TEMPLATES (ver lib/tickets/htmlTemplates.ts).

import {
  defaultSaleBlocks,
  newBlock,
  type BlockType,
  type TicketBlock,
} from "@/lib/tickets/blocks";

export interface BlockStarterTemplate {
  key: string;
  name: string;
  description: string;
  paper: "58" | "80" | "a4";
  kind: "sale" | "promo" | "gift";
  blocks: TicketBlock[];
}

// newBlock(type) + overrides, preservando el tipo de cada variante del bloque.
function mk<T extends BlockType>(
  type: T,
  overrides: Partial<Extract<TicketBlock, { type: T }>> = {},
): TicketBlock {
  return { ...(newBlock(type) as Extract<TicketBlock, { type: T }>), ...overrides };
}

export const BLOCK_STARTER_TEMPLATES: BlockStarterTemplate[] = [
  {
    key: "clasico",
    name: "Clásico",
    description: "El ticket de venta estándar con logo, datos, ítems y totales.",
    paper: "80",
    kind: "sale",
    blocks: defaultSaleBlocks(),
  },
  {
    key: "compacto",
    name: "Compacto 58",
    description: "Versión reducida para impresoras de 58 mm. Solo lo esencial.",
    paper: "58",
    kind: "sale",
    blocks: [
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: false }),
      newBlock("saleInfo"),
      newBlock("separator"),
      newBlock("items"),
      newBlock("totals"),
      newBlock("footer"),
    ],
  },
  {
    key: "detallado",
    name: "Detallado A4",
    description: "Comprobante completo en A4 con cliente, pagos, QR y código de barras.",
    paper: "a4",
    kind: "sale",
    blocks: [
      newBlock("logo"),
      mk("business", { showLegalName: true, showCuit: true, showAddress: true, showPhone: true }),
      newBlock("title"),
      newBlock("separator"),
      newBlock("saleInfo"),
      newBlock("customer"),
      newBlock("separator"),
      mk("items", { showUnitPrice: true }),
      newBlock("separator"),
      newBlock("totals"),
      newBlock("payments"),
      newBlock("qr"),
      newBlock("barcode"),
      newBlock("footer"),
    ],
  },
  {
    key: "promo",
    name: "Volante promo",
    description: "Flyer promocional con título destacado, imagen y descripción de la oferta.",
    paper: "80",
    kind: "promo",
    blocks: [
      mk("title", { text: "¡PROMO!", size: "lg", bold: true }),
      mk("image", { url: "", widthPct: 100 }),
      mk("text", { text: "Descripción de la oferta…", size: "md" }),
      newBlock("separator"),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: true }),
      mk("footer", { text: "Te esperamos" }),
    ],
  },
  {
    key: "gift",
    name: "Gift card",
    description: "Vale de regalo con monto y datos del destinatario para completar a mano.",
    paper: "80",
    kind: "gift",
    blocks: [
      mk("title", { text: "VALE DE REGALO", size: "lg", bold: true }),
      newBlock("separator"),
      mk("text", { text: "Monto: $ ________", size: "md" }),
      mk("text", { text: "Para: ____________\nDe: ____________", size: "md", align: "left" }),
      newBlock("separator"),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: false }),
      mk("footer", { text: "Válido presentando este vale" }),
    ],
  },
];
