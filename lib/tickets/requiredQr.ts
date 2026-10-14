// El QR del ticket es obligatorio: todo comprobante lo imprime (datos de la
// venta o, con factura autorizada, el QR fiscal de ARCA). Ya no existe el
// toggle "Mostrar QR" y el flag guardado `tenant_branding.ticket_show_qr` se
// ignora en el render. Si una plantilla (bloques, lienzo o HTML) no trae QR,
// se agrega uno al final. Punto único: TemplateRenderer.
import { CANVAS_WIDTH, newBlock, type CanvasContent, type TicketBlock } from "@/lib/tickets/blocks";
import { upgradeCanvas } from "@/lib/tickets/canvasCompat";

type Canvas = CanvasContent["canvas"];
type Paper = "58" | "80" | "a4";

/** Bloques con QR garantizado: si falta, va antes del pie (o al final). */
export function ensureQrBlocks(blocks: TicketBlock[]): TicketBlock[] {
  if (blocks.some((b) => b.type === "qr")) return blocks;
  const footerAt = blocks.findIndex((b) => b.type === "footer");
  // id fijo: el QR agregado no cambia de key entre renders.
  const qr: TicketBlock = { ...newBlock("qr"), id: "qr-obligatorio" };
  if (footerAt === -1) return [...blocks, qr];
  return [...blocks.slice(0, footerAt), qr, ...blocks.slice(footerAt)];
}

const CANVAS_QR = { size: 120, gap: 8 };

/**
 * Lienzo con QR garantizado: si falta, se agrega centrado debajo de todo.
 * Primero normaliza el lienzo (v1 en % → v2 en px) para que el QR agregado no
 * rompa la detección de formato viejo; upgradeCanvas es idempotente.
 */
export function ensureQrCanvas(canvas: Canvas, paper: Paper): Canvas {
  if (canvas.elements.some((e) => e.type === "qr")) return canvas;
  const up = upgradeCanvas(canvas, paper);
  const size = Math.min(CANVAS_QR.size, CANVAS_WIDTH[paper]);
  const y = up.height + CANVAS_QR.gap;
  return {
    ...up,
    height: y + size + CANVAS_QR.gap,
    elements: [
      ...up.elements,
      {
        id: "qr-obligatorio",
        type: "qr",
        x: Math.round((CANVAS_WIDTH[paper] - size) / 2),
        y,
        w: size,
        h: size,
      },
    ],
  };
}

/** HTML con QR garantizado: si no usa {{qr_url}}, se agrega al final. */
export function ensureQrHtml(html: string): string {
  if (/\{\{\s*qr_url\s*\}\}/.test(html)) return html;
  return `${html}\n<div style="text-align:center;margin-top:8px"><img src="{{qr_url}}" alt="QR del comprobante" style="width:100px;height:100px" /></div>`;
}
