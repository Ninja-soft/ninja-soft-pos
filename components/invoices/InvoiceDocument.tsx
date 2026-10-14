// Punto único de render del motor de comprobantes (ADR-112): elige el modelo
// A4 o ticket y arma las copias (Original / Duplicado). Lo usan la vista
// previa de Configuración, el detalle de la venta (impresión, PDF A4, email)
// y, más adelante, la factura de la plataforma. Sin hooks: también se puede
// renderizar en el servidor.
import type { ComponentType } from "react";
import type { InvoiceDoc, InvoiceCopy } from "@/lib/invoices/types";
import type { A4Model, TicketModel } from "@/lib/invoices/models";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import { invoiceView } from "@/lib/invoices/view";
import { A4Clasico, A4Corporativo, A4Ejecutivo, A4Minimal, A4Moderno } from "./a4Models";
import { TicketClasico, TicketCompacto, TicketDestacado, type TicketModelProps } from "./ticketModels";
import type { ModelProps } from "./parts";

export const A4_COMPONENTS: Record<A4Model, ComponentType<ModelProps>> = {
  clasico: A4Clasico,
  moderno: A4Moderno,
  minimal: A4Minimal,
  corporativo: A4Corporativo,
  ejecutivo: A4Ejecutivo,
};

export const TICKET_COMPONENTS: Record<Exclude<TicketModel, "simple">, ComponentType<TicketModelProps>> = {
  clasico: TicketClasico,
  compacto: TicketCompacto,
  destacado: TicketDestacado,
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
export function a4Copies(doc: InvoiceDoc, copies: 1 | 2): (InvoiceCopy | null)[] {
  if (!doc.fiscal) return [doc.copy ?? null];
  if (copies === 2) return ["ORIGINAL", "DUPLICADO"];
  return [doc.copy ?? "ORIGINAL"];
}

export function InvoiceDocument({ doc, style, format, model, printable, className }: Props) {
  if (format === "a4") {
    const key = (model as A4Model | undefined) && model! in A4_COMPONENTS ? (model as A4Model) : style.a4Model;
    const Model = A4_COMPONENTS[key];
    return (
      <div data-invoice-a4 data-model={key} className={className} style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        {printable && (
          <style>{`@media print{@page{size:A4;margin:0}[data-invoice-page]{break-after:page;page-break-after:always}[data-invoice-a4]{gap:0!important}}`}</style>
        )}
        {a4Copies(doc, style.a4Copies).map((copy, i) => {
          const d = { ...doc, copy };
          return <Model key={i} doc={d} view={invoiceView(d)} style={style} />;
        })}
      </div>
    );
  }
  const tk = (model && model !== "simple" && model in TICKET_COMPONENTS ? model : style.ticketModel) as TicketModel;
  const Model = TICKET_COMPONENTS[tk === "simple" ? "clasico" : tk];
  return (
    <div data-model={tk} className={className}>
      <Model doc={doc} view={invoiceView(doc)} style={style} paper={format} />
    </div>
  );
}
