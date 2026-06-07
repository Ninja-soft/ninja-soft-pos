// H9b PR6 — Starter "Mi marca": se sintetiza en tiempo de elección a partir del
// branding del negocio (logo + color de acento) para que SIEMPRE haya un modelo
// adaptado a la marca del cliente, primero en el picker. Feedback de usuario:
// "Siempre debe haber uno adaptado a mi marca, en colores y logo".
//
// El acento se toma de branding.accent (hex #rrggbb válido); si falta o es
// inválido, cae al flame de NinjaSoft. El logo y el QR siempre están presentes
// (es un modelo de venta).

import {
  newBlock,
  newCanvasElement,
  type BlockType,
  type CanvasContent,
  type TicketBlock,
} from "@/lib/tickets/blocks";
import type { SampleBrand } from "@/lib/tickets/sample";

// Flame de NinjaSoft (ver tailwind.config.ts → ninja.flame). Fallback del acento.
export const NINJA_FLAME = "#FF4B22";

const HEX = /^#[0-9a-fA-F]{6}$/;

// Acento válido del branding o flame de NinjaSoft.
export function brandAccent(brand: SampleBrand | null | undefined): string {
  const a = brand?.accent;
  return typeof a === "string" && HEX.test(a) ? a : NINJA_FLAME;
}

function mk<T extends BlockType>(
  type: T,
  overrides: Partial<Extract<TicketBlock, { type: T }>> = {},
): TicketBlock {
  return { ...(newBlock(type) as Extract<TicketBlock, { type: T }>), ...overrides };
}

// Modelo de venta en modo bloques adaptado a la marca. El acento pinta el título
// y los separadores; el logo y el QR siempre están.
export function buildMyBrandBlocks(brand: SampleBrand | null | undefined): TicketBlock[] {
  const accent = brandAccent(brand);
  return [
    mk("logo"),
    mk("business", { showLegalName: true, showCuit: true, showAddress: true, showPhone: true }),
    mk("title", { text: "", size: "lg", bold: true, font: "sans", color: accent }),
    mk("separator", { style: "solid", color: accent }),
    mk("saleInfo"),
    mk("items", { showUnitPrice: true }),
    mk("separator", { style: "solid", color: accent }),
    mk("totals"),
    mk("payments"),
    mk("separator", { style: "solid", color: accent }),
    mk("qr"),
    mk("footer", { text: "", font: "sans", color: accent }),
  ];
}

// Modelo de venta en modo canvas adaptado a la marca. Logo arriba, QR al pie,
// ambos movibles. Acento en encabezado y filete.
export function buildMyBrandCanvas(
  brand: SampleBrand | null | undefined,
): CanvasContent["canvas"] {
  const accent = brandAccent(brand);
  return {
    height: 360,
    elements: [
      { ...newCanvasElement("logo"), x: 90, y: 12, w: 120, h: 50 },
      {
        ...newCanvasElement("text"),
        x: 10,
        y: 72,
        w: 280,
        text: "Mi negocio",
        bold: true,
        align: "center",
        font: "sans",
        color: accent,
        fontSize: 18,
      },
      { ...newCanvasElement("separator"), x: 20, y: 104, w: 260, h: 8, color: accent },
      { ...newCanvasElement("items"), x: 0, y: 130, w: 300 },
      { ...newCanvasElement("separator"), x: 20, y: 250, w: 260, h: 8, color: accent },
      { ...newCanvasElement("qr"), x: 90, y: 268, w: 120, h: 120 },
      {
        ...newCanvasElement("text"),
        x: 10,
        y: 330,
        w: 280,
        text: "¡Gracias por tu compra!",
        align: "center",
        font: "sans",
        color: accent,
      },
    ],
  };
}
