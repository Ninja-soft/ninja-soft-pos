import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TemplateRenderer } from "@/components/tickets/TemplateRenderer";
import { defaultSaleBlocks, newBlock } from "@/lib/tickets/blocks";
import { ensureQrBlocks, ensureQrCanvas, ensureQrHtml } from "@/lib/tickets/requiredQr";
import { sampleTicketData } from "@/lib/tickets/sample";
import type { TicketTemplate } from "@/modules/tickets/api";

// El QR del ticket es obligatorio: aunque el branding guardado tenga
// ticket_show_qr = false y la plantilla no traiga QR, el render lo imprime.
const brand = {
  logo_url: null,
  legal_name: "Mi Kiosco SRL",
  cuit: "30-11111111-1",
  phone: null,
  address: null,
  ticket_footer: "¡Gracias!",
  ticket_width: "80",
  ticket_title: null,
  ticket_legend: null,
  ticket_show_qr: false,
  ticket_show_logo: true,
};
const data = sampleTicketData(brand);

function tpl(mode: string, content: unknown): TicketTemplate {
  return { mode, paper: "80", show_ninjasoft_logo: false, content } as unknown as TicketTemplate;
}

function qrImgs(container: HTMLElement) {
  return Array.from(container.querySelectorAll("img")).filter((img) =>
    (img.getAttribute("src") ?? "").startsWith("data:image/svg+xml"),
  );
}

describe("QR obligatorio en el ticket", () => {
  it("ensureQrBlocks agrega el QR antes del pie y no lo duplica", () => {
    const sinQr = defaultSaleBlocks().filter((b) => b.type !== "qr");
    const out = ensureQrBlocks(sinQr);
    const types = out.map((b) => b.type);
    expect(types.filter((t) => t === "qr")).toHaveLength(1);
    expect(types.indexOf("qr")).toBe(types.indexOf("footer") - 1);
    const conQr = defaultSaleBlocks();
    expect(ensureQrBlocks(conQr)).toBe(conQr);
    expect(ensureQrBlocks([newBlock("business")]).at(-1)?.type).toBe("qr");
  });

  it("ensureQrCanvas agrega un QR centrado debajo del lienzo", () => {
    const out = ensureQrCanvas(
      { height: 200, elements: [{ id: "t", type: "text", x: 10, y: 20, w: 280, h: 24, text: "Hola" }] },
      "80",
    );
    const qr = out.elements.find((e) => e.type === "qr");
    expect(qr).toBeDefined();
    expect(qr!.y).toBeGreaterThanOrEqual(200);
    expect(out.height).toBeGreaterThan(qr!.y + (qr!.h ?? 0));
  });

  it("ensureQrHtml agrega {{qr_url}} sólo si falta", () => {
    expect(ensureQrHtml("<b>{{negocio}}</b>")).toContain("{{qr_url}}");
    const conQr = '<img src="{{qr_url}}" />';
    expect(ensureQrHtml(conQr)).toBe(conQr);
  });

  it("fallback sin QR y ticket_show_qr=false igual imprime el QR", () => {
    const { container } = render(
      <TemplateRenderer
        template={null}
        fallbackBlocks={defaultSaleBlocks().filter((b) => b.type !== "qr")}
        data={data}
      />,
    );
    expect(qrImgs(container)).toHaveLength(1);
  });

  it("plantilla de bloques sin QR imprime el QR", () => {
    const { container } = render(
      <TemplateRenderer
        template={tpl("blocks", { blocks: [newBlock("business"), newBlock("totals")] })}
        fallbackBlocks={[]}
        data={data}
      />,
    );
    expect(qrImgs(container)).toHaveLength(1);
  });

  it("plantilla de lienzo sin QR imprime el QR", () => {
    const { container } = render(
      <TemplateRenderer
        template={tpl("canvas", {
          canvas: { height: 200, elements: [{ id: "t1", type: "text", x: 5, y: 20, w: 90, text: "Hola" }] },
        })}
        fallbackBlocks={[]}
        data={data}
      />,
    );
    expect(qrImgs(container)).toHaveLength(1);
  });

  it("plantilla HTML sin QR imprime el QR", () => {
    const { container } = render(
      <TemplateRenderer template={tpl("html", { html: "<b>{{negocio}}</b>" })} fallbackBlocks={[]} data={data} />,
    );
    expect(qrImgs(container)).toHaveLength(1);
  });
});
