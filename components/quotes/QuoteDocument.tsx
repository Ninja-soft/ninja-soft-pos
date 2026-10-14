// Modelo de presupuesto (ADR-122) con el motor de comprobantes tal como está
// (ADR-112, ADR-119): el mismo modelo A4 o de ticket que eligió el negocio,
// con sus opciones (tipografía, densidad, esquinas rectas o redondeadas,
// encabezado, fotos de los productos, sello) sobre un InvoiceDoc no fiscal:
// título "PRESUPUESTO", "Documento no válido como factura" y la validez, el
// período, las condiciones, las notas y la aceptación (o el espacio para la
// firma) como leyendas. No agrega modelos propios ni toca los del motor. Sin
// hooks: sirve para la vista previa, la impresión y el PDF.
import type { Quote, QuoteBrand, QuoteItem } from "@/lib/quotes/logic";
import { quoteToInvoiceDoc } from "@/lib/quotes/logic";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";

export type QuoteFormat = "a4" | "80" | "58";

interface Props {
  quote: Quote;
  items: QuoteItem[];
  brand: QuoteBrand | null;
  style: ResolvedInvoiceStyle;
  format: QuoteFormat;
  /** Fotos de los productos por id (opcional). */
  images?: Map<string, string> | null;
  /** Reglas de impresión A4 (@page). Sólo en el nodo que se imprime. */
  printable?: boolean;
  className?: string;
}

/** Estilo del negocio para un presupuesto: una sola copia y sin sus leyendas fiscales propias. */
export function quoteStyle(style: ResolvedInvoiceStyle): ResolvedInvoiceStyle {
  return { ...style, a4Copies: 1, showPayments: false, showSaleBarcode: false };
}

export function QuoteDocument({ quote, items, brand, style, format, images, printable, className }: Props) {
  const doc = quoteToInvoiceDoc(quote, items, brand, images);
  return <InvoiceDocument doc={doc} style={quoteStyle(style)} format={format} printable={printable} className={className} />;
}
