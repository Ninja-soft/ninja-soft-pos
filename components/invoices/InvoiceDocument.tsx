// Punto único de render del motor de comprobantes (ADR-112, ADR-119): elige el
// modelo A4 o ticket, arma las copias (Original / Duplicado) y, en A4, parte
// el detalle en hojas cuando no entra en una. Lo usan la vista previa de
// Configuración, la ventana del ticket (impresión, PDF, email), la
// devolución, el ticket provisorio offline, la prueba de impresora y, más
// adelante, la factura de la plataforma. Sin hooks: también se puede
// renderizar en el servidor.
import type { ComponentType } from "react";
import type { InvoiceDoc, InvoiceCopy } from "@/lib/invoices/types";
import type { A4Model, TicketModel } from "@/lib/invoices/models";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { invoiceView } from "@/lib/invoices/view";
import { paginateLines } from "@/lib/invoices/paginate";
import {
  A4Bloques,
  A4Catalogo,
  A4Clasico,
  A4Compacto,
  A4Corporativo,
  A4Ejecutivo,
  A4Elegante,
  A4Minimal,
  A4Moderno,
  CATALOG_PHOTO,
  PHOTO_THUMB,
} from "./a4Models";
import {
  TicketClasico,
  TicketCompacto,
  TicketDestacado,
  TicketMinimal,
  TicketModerno,
  type TicketModelProps,
} from "./ticketModels";
import type { ModelProps } from "./parts";

export const A4_COMPONENTS: Record<A4Model, ComponentType<ModelProps>> = {
  clasico: A4Clasico,
  moderno: A4Moderno,
  minimal: A4Minimal,
  corporativo: A4Corporativo,
  ejecutivo: A4Ejecutivo,
  elegante: A4Elegante,
  bloques: A4Bloques,
  compacto: A4Compacto,
  catalogo: A4Catalogo,
};

export const TICKET_COMPONENTS: Record<
  TicketModel,
  ComponentType<TicketModelProps>
> = {
  clasico: TicketClasico,
  compacto: TicketCompacto,
  destacado: TicketDestacado,
  moderno: TicketModerno,
  minimal: TicketMinimal,
};

export type InvoiceFormat = "a4" | "80" | "58";

interface Props {
  doc: InvoiceDoc;
  style: ResolvedInvoiceStyle;
  format: InvoiceFormat;
  /** Pisa el modelo de la configuración (vista previa de cada modelo). */
  model?: A4Model | TicketModel;
  /** Agrega las reglas de impresión A4 (@page). Sólo en el nodo que se imprime. */
  printable?: boolean;
  className?: string;
}

/** Copias de la hoja A4: Original (y Duplicado si se eligió) en comprobantes fiscales. */
export function a4Copies(
  doc: InvoiceDoc,
  copies: 1 | 2,
): (InvoiceCopy | null)[] {
  if (!doc.fiscal) return [doc.copy ?? null];
  if (copies === 2) return ["ORIGINAL", "DUPLICADO"];
  return [doc.copy ?? "ORIGINAL"];
}

/** Hojas de un comprobante A4 (cortes de renglones) con el estilo y el modelo dados. */
export function a4Pages(
  doc: InvoiceDoc,
  style: ResolvedInvoiceStyle,
  model: A4Model,
): [number, number][] {
  const photo =
    model === "catalogo" ? CATALOG_PHOTO : style.showPhotos ? PHOTO_THUMB : 0;
  return paginateLines(doc.lines, {
    fontScale: style.fontScale,
    density: style.density,
    photo,
    dense: model === "compacto",
  });
}

export function InvoiceDocument({
  doc,
  style,
  format,
  model,
  printable,
  className,
}: Props) {
  if (format === "a4") {
    const key: A4Model =
      model && model in A4_COMPONENTS ? (model as A4Model) : style.a4Model;
    const Model = A4_COMPONENTS[key];
    const pages = a4Pages(doc, style, key);
    return (
      <div
        data-invoice-a4
        data-model={key}
        className={className}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          alignItems: "center",
        }}
      >
        {printable && (
          <style>{`@media print{@page{size:A4;margin:0}[data-invoice-page]{break-after:page;page-break-after:always}[data-invoice-page]:last-child{break-after:auto;page-break-after:auto}[data-invoice-a4]{gap:0!important}}`}</style>
        )}
        {a4Copies(doc, style.a4Copies).flatMap((copy, c) => {
          const d = { ...doc, copy };
          const view = invoiceView(d);
          return pages.map(([from, to], p) => (
            <Model
              key={`${c}-${p}`}
              doc={
                pages.length > 1
                  ? { ...d, lines: doc.lines.slice(from, to) }
                  : d
              }
              view={view}
              style={style}
              page={
                pages.length > 1 ? { index: p, count: pages.length } : undefined
              }
            />
          ));
        })}
      </div>
    );
  }
  const tk: TicketModel =
    model && model in TICKET_COMPONENTS
      ? (model as TicketModel)
      : style.ticketModel;
  const Model = TICKET_COMPONENTS[tk];
  return (
    <div data-model={tk} className={className}>
      <Model doc={doc} view={invoiceView(doc)} style={style} paper={format} />
    </div>
  );
}
