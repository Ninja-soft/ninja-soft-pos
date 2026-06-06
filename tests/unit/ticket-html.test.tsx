import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderTemplate } from "@/lib/email/templates";
import { buildHtmlVars, HTML_TEMPLATE_VARS } from "@/lib/tickets/htmlVars";
import { HTML_STARTER_TEMPLATES } from "@/lib/tickets/htmlTemplates";
import { HtmlTicketRenderer } from "@/components/tickets/HtmlTicketRenderer";
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

describe("buildHtmlVars", () => {
  it("escapa < > en el nombre del producto", () => {
    const data = sampleTicketData(brand);
    data.items = [{ id: "x", product_name: "<script>alert(1)</script>", quantity: 1, unit_price: 100, subtotal: 100 }];
    const vars = buildHtmlVars(data);
    expect(vars.items_html).not.toContain("<script>");
    expect(vars.items_html).toContain("&lt;script&gt;");
  });

  it("descuento vacío cuando es 0", () => {
    const data = sampleTicketData(brand);
    data.sale.discount_total = 0;
    expect(buildHtmlVars(data).descuento).toBe("");
  });

  it("anulada seteada cuando la venta está voided", () => {
    const data = sampleTicketData(brand);
    data.sale.status = "voided";
    expect(buildHtmlVars(data).anulada).toBe("ANULADA");
    data.sale.status = "completed";
    expect(buildHtmlVars(data).anulada).toBe("");
  });
});

describe("renderTemplate (integración HTML)", () => {
  it("reemplaza {{negocio}} por el nombre del negocio", () => {
    const out = renderTemplate("<b>{{negocio}}</b>", buildHtmlVars(sampleTicketData(brand)));
    expect(out).toContain("Mi Kiosco SRL");
  });
});

describe("HtmlTicketRenderer", () => {
  it("renderiza la plantilla clasico-80 con el nombre del negocio", () => {
    const tpl = HTML_STARTER_TEMPLATES.find((t) => t.key === "clasico-80")!;
    const { container } = render(
      <HtmlTicketRenderer
        html={tpl.html}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(container.innerHTML).toContain("Mi Kiosco SRL");
  });

  it("neutraliza scripts y handlers en plantillas maliciosas", () => {
    const evil = `<div>{{negocio}}</div><script>window.x=1</script><img src="x" onerror="alert(1)" />`;
    const { container } = render(
      <HtmlTicketRenderer
        html={evil}
        data={sampleTicketData(brand)}
        paper="80"
        showNinjaLogo={false}
      />,
    );
    expect(container.innerHTML).toContain("Mi Kiosco SRL");
    expect(container.innerHTML).not.toContain("<script>");
    expect(container.innerHTML).not.toContain("onerror");
  });
});

describe("HTML_STARTER_TEMPLATES", () => {
  it("tiene 5 entradas con claves únicas", () => {
    expect(HTML_STARTER_TEMPLATES).toHaveLength(5);
    const keys = HTML_STARTER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(5);
  });

  it("todas las {{var}} usadas existen en HTML_TEMPLATE_VARS", () => {
    const known = new Set(HTML_TEMPLATE_VARS.map((v) => v.key));
    for (const tpl of HTML_STARTER_TEMPLATES) {
      const used = [...tpl.html.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      for (const v of used) {
        expect(known.has(v!), `${tpl.key} usa {{${v}}} inexistente`).toBe(true);
      }
    }
  });
});
