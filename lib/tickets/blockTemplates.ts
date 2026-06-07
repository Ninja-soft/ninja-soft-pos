// H9b PR4/PR5/PR6 — Modelos precargados para el modo "blocks" del ticket.
// Cada entrada arma su lista de bloques con newBlock(type) + overrides y le
// imprime la IDENTIDAD VISUAL DE NINJAPOS (paleta ninja: void/violet oscuros,
// flame naranja, dorado), para que reflejen la marca y no se vean "feas".
// Feedback de usuario (PR6): los diseños precargados deben tener la esencia
// NinjaPos; toda venta debe mostrar logo + QR.
// Espeja la forma de HTML_STARTER_TEMPLATES (ver lib/tickets/htmlTemplates.ts).

import {
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

// Paleta NinjaPos (ver tailwind.config.ts → colors.ninja).
const NINJA = {
  flame: "#FF4B22",
  flameSoft: "#FF6A1A",
  gold: "#FFD21F",
  void: "#09051C",
  deepViolet: "#140D35",
  midViolet: "#2B1A67",
  softWhite: "#F7F7FF",
  lavender: "#B8AEDC",
} as const;

// newBlock(type) + overrides, preservando el tipo de cada variante del bloque.
function mk<T extends BlockType>(
  type: T,
  overrides: Partial<Extract<TicketBlock, { type: T }>> = {},
): TicketBlock {
  return { ...(newBlock(type) as Extract<TicketBlock, { type: T }>), ...overrides };
}

export const BLOCK_STARTER_TEMPLATES: BlockStarterTemplate[] = [
  {
    // Térmico NinjaPos: mono prolijo, título flame, separadores flame.
    // Venta → logo + QR siempre presentes.
    key: "clasico",
    name: "Clásico Ninja",
    description: "Térmico prolijo con título flame y QR. La base de NinjaPos.",
    paper: "80",
    kind: "sale",
    blocks: [
      mk("logo"),
      mk("business", { showLegalName: true, showCuit: true, showAddress: true, showPhone: true }),
      mk("title", { text: "", size: "lg", bold: true, font: "mono", color: NINJA.flame }),
      mk("separator", { style: "dashed", color: NINJA.flame }),
      mk("saleInfo"),
      mk("separator", { style: "dashed", color: NINJA.flame }),
      mk("items", { showUnitPrice: true }),
      mk("separator", { style: "dashed", color: NINJA.flame }),
      mk("totals"),
      mk("payments"),
      mk("separator", { style: "dashed", color: NINJA.flame }),
      mk("qr"),
      mk("footer", { text: "¡Gracias por tu compra!", font: "mono", color: NINJA.flame }),
    ],
  },
  {
    // Moderno oscuro: encabezado void con título flame, separadores dorados.
    // Venta → logo + QR.
    key: "moderno",
    name: "Moderno oscuro",
    description: "Encabezado oscuro NinjaPos, título flame y detalles dorados.",
    paper: "80",
    kind: "sale",
    blocks: [
      mk("logo"),
      mk("title", {
        text: "TICKET",
        size: "lg",
        bold: true,
        font: "sans",
        bg: NINJA.void,
        color: NINJA.flameSoft,
      }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: true, showPhone: true }),
      mk("separator", { style: "solid", color: NINJA.gold }),
      mk("saleInfo"),
      mk("separator", { style: "solid", color: NINJA.gold }),
      mk("items", { showUnitPrice: true }),
      mk("separator", { style: "solid", color: NINJA.gold }),
      mk("totals"),
      mk("payments"),
      mk("separator", { style: "solid", color: NINJA.gold }),
      mk("qr"),
      mk("footer", {
        text: "¡Gracias por tu compra!",
        font: "sans",
        bg: NINJA.void,
        color: NINJA.flameSoft,
      }),
    ],
  },
  {
    // Elegante A4: serif, encabezado violeta profundo, filetes dorados dobles.
    // Venta → logo + QR.
    key: "elegante",
    name: "Elegante A4",
    description: "Comprobante A4 serif violeta profundo con filetes dorados.",
    paper: "a4",
    kind: "sale",
    blocks: [
      mk("logo"),
      mk("title", {
        text: "Comprobante",
        size: "lg",
        bold: true,
        font: "serif",
        bg: NINJA.deepViolet,
        color: NINJA.gold,
      }),
      mk("business", { showLegalName: true, showCuit: true, showAddress: true, showPhone: true }),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("saleInfo"),
      mk("customer"),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("items", { showUnitPrice: true }),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("totals"),
      mk("payments"),
      mk("qr"),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("footer", { text: "Gracias por su preferencia", font: "serif", color: NINJA.midViolet }),
    ],
  },
  {
    // Volante promo NinjaPos: título flame gigante, bloque destacado dorado.
    key: "promo",
    name: "Volante Ninja",
    description: "Flyer vibrante: título flame gigante y bloque destacado dorado.",
    paper: "80",
    kind: "promo",
    blocks: [
      mk("title", { text: "¡PROMO!", size: "lg", bold: true, font: "sans", color: NINJA.flame }),
      mk("text", {
        text: "2x1 todos los miércoles",
        size: "md",
        bold: true,
        font: "sans",
        bg: NINJA.gold,
        color: NINJA.void,
      }),
      mk("image", { url: "", widthPct: 100 }),
      mk("separator", { style: "solid", color: NINJA.flame }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: true }),
      mk("footer", { text: "¡Te esperamos!", font: "sans", color: NINJA.flame }),
    ],
  },
  {
    // Gift card NinjaPos: panel void, título dorado serif, líneas Para/De.
    key: "gift",
    name: "Gift card Ninja",
    description: "Vale oscuro NinjaPos con título dorado y datos para completar.",
    paper: "80",
    kind: "gift",
    blocks: [
      mk("title", {
        text: "VALE DE REGALO",
        size: "lg",
        bold: true,
        font: "serif",
        color: NINJA.gold,
        bg: NINJA.void,
      }),
      mk("text", {
        text: "Monto: $ ________",
        size: "md",
        bold: true,
        bg: NINJA.void,
        color: NINJA.softWhite,
      }),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("text", {
        text: "Para: ____________\nDe: ____________",
        size: "md",
        align: "left",
        bg: NINJA.void,
        color: NINJA.softWhite,
      }),
      mk("separator", { style: "double", color: NINJA.gold }),
      mk("business", { showLegalName: true, showCuit: false, showAddress: false, showPhone: false }),
      mk("footer", { text: "Válido presentando este vale", font: "serif", color: NINJA.gold }),
    ],
  },
];
