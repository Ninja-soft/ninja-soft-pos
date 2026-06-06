import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
import { defaultSaleBlocks, newBlock } from "@/lib/tickets/blocks";
import { sampleTicketData } from "@/lib/tickets/sample";
import type { TicketTemplate } from "@/modules/tickets/api";

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

const data = sampleTicketData(brand);
const fallback = defaultSaleBlocks();

// Plantilla mínima: solo los campos que mira TemplateRenderer.
function tpl(mode: string, content: unknown): TicketTemplate {
  return {
    mode,
    paper: "80",
    show_ninjasoft_logo: false,
    content,
  } as unknown as TicketTemplate;
}

describe("TemplateRenderer", () => {
  it("modo blocks renderiza el negocio de la plantilla", () => {
    render(
      <TemplateRenderer
        template={tpl("blocks", { blocks: [newBlock("business")] })}
        fallbackBlocks={fallback}
        data={data}
      />,
    );
    expect(screen.getByText("Mi Kiosco SRL")).toBeDefined();
  });

  it("modo canvas renderiza el texto del elemento", () => {
    render(
      <TemplateRenderer
        template={tpl("canvas", {
          canvas: { height: 300, elements: [{ id: "t1", type: "text", x: 5, y: 20, w: 90, text: "Bienvenidos" }] },
        })}
        fallbackBlocks={fallback}
        data={data}
      />,
    );
    expect(screen.getByText("Bienvenidos")).toBeDefined();
  });

  it("modo html renderiza variables {{negocio}}", () => {
    const { container } = render(
      <TemplateRenderer
        template={tpl("html", { html: "<b>{{negocio}}</b>" })}
        fallbackBlocks={fallback}
        data={data}
      />,
    );
    expect(container.innerHTML).toContain("Mi Kiosco SRL");
  });

  it("template null renderiza los bloques de fallback", () => {
    render(
      <TemplateRenderer
        template={null}
        fallbackBlocks={[newBlock("business")]}
        data={data}
      />,
    );
    expect(screen.getByText("Mi Kiosco SRL")).toBeDefined();
  });

  it("content malformado cae al fallback de bloques", () => {
    render(
      <TemplateRenderer
        template={tpl("blocks", {})}
        fallbackBlocks={[newBlock("business")]}
        data={data}
      />,
    );
    expect(screen.getByText("Mi Kiosco SRL")).toBeDefined();
  });
});
