"use client";

// Comprobante de una devolución con el motor ADR-112 (ADR-119). Si la venta
// tenía factura autorizada, la devolución pide a ARCA su nota de crédito
// (origin "return"): se espera el CAE y se imprime la NC con el comprobante
// asociado. Sin factura, sale un "Comprobante de devolución" no fiscal. El
// vale (código y código de barras) y el reintegro de Mercado Pago van debajo.
// PRESENTACIONAL salvo el formato elegido: los datos los arma ReturnResult.
import type { ReactNode } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";
import { Callout } from "@/components/ui/Callout";
import { AlertTriangle } from "lucide-react";
import { InvoicePreview } from "@/components/invoices/InvoicePreview";
import type { InvoiceDoc } from "@/lib/invoices/types";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";
import type { PrintFormat } from "@/components/sales/ticket/TicketSheet";
import { invoiceFromTicket, docOptions } from "@/lib/invoices/fromTicket";
import { ticketFiscal } from "@/lib/arca/ticket";
import type { SampleTicketData } from "@/lib/tickets/sample";

export type ReturnFiscalState = "none" | "authorizing" | "approved" | "failed";

export interface ReturnDocInput {
  number: number;
  numberLabel: string;
  createdAt: string;
  total: number;
  items: {
    name: string;
    qty: number;
    subtotal: number;
    product_id?: string | null;
  }[];
  payments: { id: string; method: string; amount: number }[];
  customer: SampleTicketData["customer"];
  brand: SampleTicketData["brand"];
  /** Nota de crédito de ARCA de esta devolución (fiscal_documents, origin return). */
  ncDoc?: Parameters<typeof ticketFiscal>[0] | null;
  /** Factura de la venta (comprobante asociado de la NC). */
  saleInvoice?: Parameters<typeof ticketFiscal>[0] | null;
  isVoucher: boolean;
}

/** Estado fiscal de la NC de la devolución. */
export function returnFiscalState(
  nc: ReturnDocInput["ncDoc"],
): ReturnFiscalState {
  if (!nc || nc.status === "cancelado") return "none";
  if (nc.status === "aprobado" && nc.cae) return "approved";
  if (nc.status === "rechazado" || nc.status === "requiere_accion")
    return "failed";
  return "authorizing";
}

/** InvoiceDoc de la devolución: NC con CAE o comprobante de devolución no fiscal. */
export function returnInvoiceDoc(
  r: ReturnDocInput,
  style: ResolvedInvoiceStyle,
): InvoiceDoc {
  const nc =
    returnFiscalState(r.ncDoc) === "approved" ? ticketFiscal(r.ncDoc) : null;
  const inv = ticketFiscal(r.saleInvoice ?? null);
  const data: SampleTicketData = {
    sale: {
      number: r.number,
      numberLabel: r.numberLabel,
      created_at: r.createdAt,
      subtotal: r.total,
      discount_total: 0,
      total: r.total,
      status: "completed",
      fiscal: nc,
    },
    items: r.items.map((it, i) => ({
      id: String(i),
      product_id: it.product_id ?? null,
      product_name: it.name,
      quantity: it.qty,
      unit_price: it.qty > 0 ? it.subtotal / it.qty : it.subtotal,
      subtotal: it.subtotal,
    })),
    payments: r.payments,
    customer: r.customer,
    brand: r.brand,
  };
  return invoiceFromTicket(
    data,
    docOptions(style, {
      nonFiscalLabel: r.isVoucher
        ? "Vale por devolución"
        : "Comprobante de devolución",
      associated:
        nc && inv?.numero
          ? [
              {
                label: inv.cbteLabel,
                number: inv.numero,
                date: inv.cbteFch ?? null,
              },
            ]
          : [],
      showInternalRef: true,
    }),
  );
}

export function ReturnReceipt({
  doc,
  style,
  rollStyle,
  rollPaper,
  format,
  onFormat,
  fiscal,
  extras,
  showProvisional,
}: {
  doc: InvoiceDoc;
  style: ResolvedInvoiceStyle;
  rollStyle: ResolvedInvoiceStyle;
  rollPaper: "80" | "58";
  format: PrintFormat;
  onFormat: (f: PrintFormat) => void;
  fiscal: ReturnFiscalState;
  /** Vale y reintegro de Mercado Pago (debajo del comprobante). */
  extras?: ReactNode;
  /** Se pidió ver el comprobante sin esperar el CAE. */
  showProvisional?: boolean;
}) {
  const waiting = fiscal === "authorizing" && !showProvisional;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {fiscal === "none" ? "Comprobante de devolución" : "Nota de crédito"}
        </span>
        <Segmented
          value={format}
          options={[
            { value: "ticket", label: "Ticket" },
            { value: "a4", label: "A4" },
          ]}
          onChange={onFormat}
          aria-label="Formato de la vista previa"
          size="sm"
        />
      </div>
      {fiscal === "failed" && (
        <Callout
          tone="danger"
          icon={AlertTriangle}
          title="ARCA no autorizó la nota de crédito"
        >
          El dueño o el encargado la pueden revisar y reprocesar desde el
          detalle de la venta. Mientras tanto sale un comprobante de devolución
          no fiscal.
        </Callout>
      )}
      {waiting ? (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-sm"
        >
          <Spinner size={18} label="Autorizando la nota de crédito" />
          <span className="text-muted-foreground">
            Pidiendo el CAE de la nota de crédito a ARCA. El comprobante aparece
            apenas se autorice.
          </span>
        </div>
      ) : (
        <div className="bg-fg-4 rounded-xl p-3">
          <InvoicePreview
            doc={doc}
            style={format === "a4" ? style : rollStyle}
            format={format === "a4" ? "a4" : rollPaper}
            maxA4={460}
          />
          {extras}
        </div>
      )}
    </div>
  );
}
