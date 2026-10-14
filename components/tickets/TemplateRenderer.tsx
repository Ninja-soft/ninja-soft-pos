"use client";

// H9b PR2 — Despacho por modo de plantilla. Punto único de render para
// TicketModal, preview del editor, A4 y export a PNG/email.
import { TicketRenderer, type TicketData } from "@/components/tickets/TicketRenderer";
import { CanvasTicketRenderer } from "@/components/tickets/CanvasTicketRenderer";
import { HtmlTicketRenderer } from "@/components/tickets/HtmlTicketRenderer";
import type { TemplateContent, TicketBlock } from "@/lib/tickets/blocks";
import type { TicketTemplate } from "@/modules/tickets/api";
import { ensureQrBlocks, ensureQrCanvas, ensureQrHtml } from "@/lib/tickets/requiredQr";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import { InvoiceFit } from "@/components/invoices/InvoiceFit";
import { invoiceFromTicket } from "@/lib/invoices/fromTicket";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";

type Paper = "58" | "80" | "a4";

interface Props {
  template: TicketTemplate | null;
  fallbackBlocks: TicketBlock[];
  data: TicketData;
  paperOverride?: Paper;
  className?: string;
  /**
   * ADR-112: estilo de comprobante del negocio. Sin plantilla propia activa,
   * el comprobante sale con el modelo elegido (factura A4 o ticket) en vez de
   * los bloques clásicos; con el modelo de ticket "simple", igual que antes.
   */
  invoice?: { style: ResolvedInvoiceStyle } | null;
}

export function TemplateRenderer({
  template,
  fallbackBlocks,
  data,
  paperOverride,
  className,
  invoice,
}: Props) {
  const paper: Paper = paperOverride ?? (template?.paper as Paper | undefined) ?? "80";
  const showNinja = Boolean(template?.show_ninjasoft_logo);
  // El QR es obligatorio en todo comprobante: cada modo lo garantiza abajo.

  const fallback = (
    <TicketRenderer
      blocks={ensureQrBlocks(fallbackBlocks)}
      data={data}
      paper={paper}
      showNinjaLogo={showNinja}
      className={className}
    />
  );

  if (!template) {
    if (invoice && (paper === "a4" || invoice.style.ticketModel !== "simple")) {
      // "Mostrar logo en el ticket" apagado (ahorro de tinta en térmica) también
      // vale para los modelos de ticket; la hoja A4 sigue la opción de logo propia.
      const style =
        paper !== "a4" && data.brand?.ticket_show_logo === false
          ? { ...invoice.style, logoUrl: null, logoOnAccentUrl: null }
          : invoice.style;
      const doc = invoiceFromTicket(data, {
        tradeName: style.tradeName,
        legends: style.legends,
        showPayments: style.showPayments,
        showInternalRef: style.showInternalRef,
      });
      if (paper === "a4") {
        return (
          <div className={className}>
            <InvoiceFit>
              <InvoiceDocument doc={doc} style={style} format="a4" printable />
            </InvoiceFit>
          </div>
        );
      }
      return (
        <div
          className={`mx-auto overflow-hidden rounded-lg border border-neutral-300 bg-white ${className ?? ""}`}
          style={{ width: paper === "58" ? "58mm" : "80mm", maxWidth: "100%" }}
        >
          <InvoiceDocument doc={doc} style={style} format={paper} />
        </div>
      );
    }
    return fallback;
  }

  const c = template.content as unknown as TemplateContent;
  const mode = template.mode;

  if (mode === "blocks" && c && "blocks" in c && Array.isArray(c.blocks) && c.blocks.length) {
    return (
      <TicketRenderer
        blocks={ensureQrBlocks(c.blocks)}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  if (
    mode === "canvas" &&
    c &&
    "canvas" in c &&
    c.canvas &&
    Array.isArray(c.canvas.elements) &&
    c.canvas.elements.length
  ) {
    return (
      <CanvasTicketRenderer
        content={ensureQrCanvas(c.canvas, paper)}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  if (mode === "html" && c && "html" in c && typeof c.html === "string" && c.html.length) {
    return (
      <HtmlTicketRenderer
        html={ensureQrHtml(c.html)}
        data={data}
        paper={paper}
        showNinjaLogo={showNinja}
        className={className}
      />
    );
  }

  // Modo no reconocido o content malformado → fallback de bloques.
  return fallback;
}
