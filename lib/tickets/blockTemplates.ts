// H9b PR4/PR5 — Modelos precargados para el modo "blocks" del ticket.
// Cada entrada arma su lista de bloques con newBlock(type) + overrides, y le
// imprime una identidad visual propia (tipografía + color + separadores) para
// que al elegirla en el picker "se entienda" qué pinta tiene. PR5-2.
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
    // Térmico tradicional de kiosco: mono, sobrio, separadores dashed (como hoy).
    key: "clasico",
    name: "Clásico",
    description: "Térmico clásico de kiosco: mono, sobrio, separadores punteados.",
    paper: "80",
    kind: "sale",
    blocks: defaultSaleBlocks(),
  },
  {
    // Limpio y moderno: sans, título bold grande, separadores solid finos grises,
    // totales destacados.
    key: "moderno",
    name: "Moderno",
    description: "Limpio y moderno: tipografía sans, título grande, líneas finas.",
    paper: "80",
    kind: "sale",
    blocks: [
      mk("logo"),
      mk("title", { text: "TICKET", size: "lg", bold: true, font: "sans", color: "#111827" }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: true, showPhone: true }),
      mk("separator", { style: "solid", color: "#6b7280" }),
      mk("saleInfo"),
      mk("separator", { style: "solid", color: "#6b7280" }),
      mk("items", { showUnitPrice: true }),
      mk("separator", { style: "solid", color: "#6b7280" }),
      mk("totals"),
      mk("payments"),
      mk("separator", { style: "solid", color: "#6b7280" }),
      mk("footer", { text: "¡Gracias por tu compra!", font: "sans", color: "#111827" }),
    ],
  },
  {
    // Elegante A4: serif, encabezado con título grande gris oscuro, separadores
    // double, footer serif chico (aire de itálica).
    key: "elegante",
    name: "Elegante",
    description: "Comprobante A4 serif con encabezado grande y filetes dobles.",
    paper: "a4",
    kind: "sale",
    blocks: [
      mk("logo"),
      mk("title", { text: "Comprobante", size: "lg", bold: true, font: "serif", color: "#1f2937" }),
      mk("business", { showLegalName: true, showCuit: true, showAddress: true, showPhone: true }),
      mk("separator", { style: "double", color: "#1f2937" }),
      mk("saleInfo"),
      mk("customer"),
      mk("separator", { style: "double", color: "#1f2937" }),
      mk("items", { showUnitPrice: true }),
      mk("separator", { style: "double", color: "#1f2937" }),
      mk("totals"),
      mk("payments"),
      mk("qr"),
      mk("separator", { style: "double", color: "#1f2937" }),
      mk("footer", { text: "Gracias por su preferencia", font: "serif", color: "#1f2937" }),
    ],
  },
  {
    // Volante promo vibrante: título XL rojo, bloque de texto destacado en amarillo,
    // imagen y pie bold.
    key: "promo",
    name: "Volante promo",
    description: "Flyer vibrante: título rojo gigante y bloque destacado en amarillo.",
    paper: "80",
    kind: "promo",
    blocks: [
      mk("title", { text: "¡PROMO!", size: "lg", bold: true, font: "sans", color: "#dc2626" }),
      mk("text", {
        text: "2x1 todos los miércoles",
        size: "md",
        bold: true,
        font: "sans",
        bg: "#fef3c7",
        color: "#92400e",
      }),
      mk("image", { url: "", widthPct: 100 }),
      mk("separator", { style: "solid", color: "#dc2626" }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: true }),
      mk("footer", { text: "¡Te esperamos!", font: "sans", color: "#dc2626" }),
    ],
  },
  {
    // Gift card oscura: bloques de texto fondo negro + texto claro, título dorado,
    // líneas Para/De, separador double dorado.
    key: "gift",
    name: "Gift card",
    description: "Vale de regalo oscuro con título dorado y datos para completar.",
    paper: "80",
    kind: "gift",
    blocks: [
      mk("title", {
        text: "VALE DE REGALO",
        size: "lg",
        bold: true,
        font: "serif",
        color: "#d4af37",
        bg: "#111827",
      }),
      mk("text", {
        text: "Monto: $ ________",
        size: "md",
        bold: true,
        bg: "#111827",
        color: "#f9fafb",
      }),
      mk("separator", { style: "double", color: "#d4af37" }),
      mk("text", {
        text: "Para: ____________\nDe: ____________",
        size: "md",
        align: "left",
        bg: "#111827",
        color: "#f9fafb",
      }),
      mk("separator", { style: "double", color: "#d4af37" }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: false }),
      mk("footer", { text: "Válido presentando este vale", font: "serif", color: "#d4af37" }),
    ],
  },
];
