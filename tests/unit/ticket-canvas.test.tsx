import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CanvasTicketRenderer } from "@/components/tickets/CanvasTicketRenderer";
import type { CanvasContent } from "@/lib/tickets/blocks";
import { sampleTicketData } from "@/lib/tickets/sample";

const brand = {
  logo_url: null,
  legal_name: "Mi Kiosco SRL",
  cuit: "30-11111111-1",
  phone: "11 5555-5555",
  address: "Av. Siempre Viva 123",
  ticket_footer: "¡Gracias!",
  ticket_width: "80",
  ticket_title: "Comprobante no fiscal",
  ticket_legend: null,
  ticket_show_qr: false,
  ticket_show_logo: true,
};

const canvas = (els: CanvasContent["canvas"]["elements"], height = 300): CanvasContent["canvas"] => ({
  elements: els,
  height,
});

describe("CanvasTicketRenderer", () => {
  it("renderiza el contenido de un elemento de texto en la zona superior", () => {
    render(
      <CanvasTicketRenderer
        content={canvas([{ id: "t1", type: "text", x: 5, y: 20, w: 90, text: "Bienvenidos" }])}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(screen.getByText("Bienvenidos")).toBeDefined();
  });

  it("flujo de ítems: un texto con y por debajo del items aparece después de la lista en el DOM", () => {
    const { container } = render(
      <CanvasTicketRenderer
        content={canvas([
          { id: "head", type: "text", x: 5, y: 10, w: 90, text: "ENCABEZADO" },
          { id: "it", type: "items", x: 0, y: 100, w: 100 },
          { id: "foot", type: "text", x: 5, y: 150, w: 90, text: "PIE DE PAGINA" },
        ])}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    const head = screen.getByText("ENCABEZADO");
    const items = screen.getByText(/Remera básica/);
    const foot = screen.getByText("PIE DE PAGINA");
    // Orden de aparición en el documento: encabezado → items → pie.
    expect(head.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(items.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(container).getByText("TOTAL")).toBeDefined();
  });

  it("sin elemento items igualmente renderiza los textos", () => {
    render(
      <CanvasTicketRenderer
        content={canvas([
          { id: "a", type: "text", x: 5, y: 20, w: 90, text: "Solo texto" },
        ])}
        data={sampleTicketData(brand)}
        paper="58"
        showNinjaLogo={false}
      />,
    );
    expect(screen.getByText("Solo texto")).toBeDefined();
  });

  it("venta anulada muestra ANULADA", () => {
    const data = sampleTicketData(brand);
    data.sale.status = "voided";
    render(
      <CanvasTicketRenderer
        content={canvas([{ id: "t", type: "text", x: 5, y: 20, w: 90, text: "Hola" }])}
        data={data}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(screen.getByText(/ANULADA/)).toBeDefined();
  });

  it("muestra wordmark NinjaSoft cuando showNinjaLogo", () => {
    render(
      <CanvasTicketRenderer
        content={canvas([])}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo
      />,
    );
    expect(screen.getByAltText("NinjaSoft")).toBeDefined();
  });
});
