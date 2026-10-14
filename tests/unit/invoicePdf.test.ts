// @vitest-environment node
// ADR-119: el PDF del comprobante (descarga, Compartir y adjunto del email)
// tiene que ser una A4 real por hoja o una página del ancho del rollo. Antes
// el adjunto salía siempre como una tira de 80 mm con el ticket de bloques y
// el QR recortado.
import { describe, expect, it } from "vitest";
import {
  a4Placement,
  buildInvoicePdf,
  ticketPage,
} from "@/lib/invoices/exportPdf";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PT_PER_MM = 72 / 25.4;

function mediaBoxes(doc: {
  output: (t: "arraybuffer") => ArrayBuffer;
}): number[][] {
  const text = new TextDecoder("latin1").decode(doc.output("arraybuffer"));
  return Array.from(text.matchAll(/\/MediaBox \[([\d.\s-]+)\]/g)).map((m) =>
    m[1]!.trim().split(/\s+/).map(Number),
  );
}

describe("PDF del comprobante", () => {
  it("A4: una página de 210 x 297 mm por hoja (Original, Duplicado, detalle largo)", async () => {
    // Hojas capturadas a 2,5x: 794 x 1123 px de la hoja A4.
    const sheet = { data: PNG, w: 1985, h: 2808 };
    const doc = await buildInvoicePdf([sheet, sheet, sheet], { a4: true });
    expect(doc.getNumberOfPages()).toBe(3);
    const boxes = mediaBoxes(doc);
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const [, , w, h] of boxes.slice(-3)) {
      expect(w! / PT_PER_MM).toBeCloseTo(210, 0);
      expect(h! / PT_PER_MM).toBeCloseTo(297, 0);
    }
  });

  it("A4: la hoja ocupa todo el ancho y, si se estiró, se achica entera (no se corta)", () => {
    expect(a4Placement(1985, 2808)).toMatchObject({ x: 0, y: 0, w: 210 });
    const tall = a4Placement(1985, 3400);
    expect(tall.h).toBe(297);
    expect(tall.w).toBeLessThan(210);
    expect(tall.x).toBeGreaterThan(0);
  });

  it("ticket: una página del ancho del rollo (80 o 58 mm) y el alto del comprobante", async () => {
    for (const paper of ["80", "58"] as const) {
      const doc = await buildInvoicePdf([{ data: PNG, w: 756, h: 2400 }], {
        paper,
      });
      expect(doc.getNumberOfPages()).toBe(1);
      const [, , w, h] = mediaBoxes(doc).at(-1)!;
      const size = ticketPage(paper, 756, 2400);
      expect(w! / PT_PER_MM).toBeCloseTo(Number(paper), 0);
      expect(h! / PT_PER_MM).toBeCloseTo(size.h, 0);
    }
  });
});
