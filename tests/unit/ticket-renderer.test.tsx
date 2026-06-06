import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketRenderer } from "@/components/tickets/TicketRenderer";
import { defaultSaleBlocks } from "@/lib/tickets/blocks";
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

describe("TicketRenderer", () => {
  it("renderiza bloques default con datos de muestra", () => {
    render(
      <TicketRenderer
        blocks={defaultSaleBlocks()}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(screen.getByText("Mi Kiosco SRL")).toBeDefined();
    expect(screen.getByText(/Remera básica/)).toBeDefined();
    expect(screen.getByText("TOTAL")).toBeDefined();
    expect(screen.getByText(/Comprobante #0001042/)).toBeDefined();
  });

  it("omite bloques hidden", () => {
    const blocks = defaultSaleBlocks().map((b) =>
      b.type === "totals" ? { ...b, hidden: true } : b,
    );
    render(
      <TicketRenderer
        blocks={blocks}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(screen.queryByText("TOTAL")).toBeNull();
  });

  it("muestra footer NinjaSoft cuando showNinjaLogo", () => {
    render(
      <TicketRenderer
        blocks={[]}
        data={sampleTicketData(brand)}
        paper="58"
        showNinjaLogo
      />,
    );
    expect(screen.getByAltText("NinjaSoft")).toBeDefined();
  });

  it("bloque texto respeta contenido", () => {
    render(
      <TicketRenderer
        blocks={[{ id: "x", type: "text", text: "2x1 los miércoles" }]}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(screen.getByText("2x1 los miércoles")).toBeDefined();
  });
});
