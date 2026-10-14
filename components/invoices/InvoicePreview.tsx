"use client";

// Vista previa en pantalla de un comprobante del motor (ADR-112, ADR-119): la
// hoja A4 achicada al ancho disponible o el rollo de ticket sobre un fondo
// neutro. Para imprimir o exportar se usa InvoiceDocument a tamaño real.
import type { InvoiceDoc } from "@/lib/invoices/types";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { InvoiceDocument, type InvoiceFormat } from "./InvoiceDocument";
import { InvoiceFit } from "./InvoiceFit";

export function InvoicePreview({
  doc,
  style,
  format,
  maxA4 = 560,
}: {
  doc: InvoiceDoc;
  style: ResolvedInvoiceStyle;
  format: InvoiceFormat;
  maxA4?: number;
}) {
  if (format === "a4") {
    return (
      <div className="mx-auto w-full" style={{ maxWidth: maxA4 }}>
        <InvoiceFit>
          <InvoiceDocument doc={doc} style={style} format="a4" />
        </InvoiceFit>
      </div>
    );
  }
  return (
    <div className="mx-auto w-fit max-w-full overflow-hidden rounded-md bg-white shadow-none ring-1 ring-black/10">
      <InvoiceDocument doc={doc} style={style} format={format} />
    </div>
  );
}

/** Ticket sin logo cuando el negocio apagó "Mostrar logo en el ticket" (ahorro en térmica). */
export function ticketStyle(
  style: ResolvedInvoiceStyle,
  showLogo: boolean | null | undefined,
): ResolvedInvoiceStyle {
  return showLogo === false
    ? { ...style, logoUrl: null, logoOnAccentUrl: null }
    : style;
}
