"use client";

import { useRef } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import { printTicketIsolated } from "@/lib/print/webPrint";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";
import type { SampleBrand, SampleTicketData } from "@/lib/tickets/sample";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import { docOptions, invoiceFromTicket } from "@/lib/invoices/fromTicket";
import {
  INVOICE_SETTINGS_KEY,
  type InvoiceSettingsRow,
} from "@/modules/invoices/hooks";
import { InvoiceDocument } from "@/components/invoices/InvoiceDocument";
import {
  InvoicePreview,
  ticketStyle,
} from "@/components/invoices/InvoicePreview";

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Datos del comprobante a partir de la venta guardada sin conexión. */
export function offlineTicketData(
  entry: OfflineQueueEntry,
  brand: SampleBrand | null,
): SampleTicketData {
  const gross = entry.lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  const discounts = entry.lines.reduce((a, l) => a + l.discount, 0);
  return {
    sale: {
      number: 0,
      numberLabel: entry.provisional,
      created_at: entry.sold_at,
      subtotal: r2(gross),
      discount_total: r2(Math.max(0, gross - entry.total, discounts)),
      total: entry.total,
      status: "completed",
    },
    items: entry.lines.map((l, i) => ({
      id: String(i),
      product_name: l.name,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      subtotal: r2(l.quantity * l.unitPrice),
    })),
    payments: entry.paymentsSummary.map((p, i) => ({
      id: String(i),
      method: p.method,
      amount: p.amount,
    })),
    customer: null,
    brand,
  };
}

// Ticket provisorio de una venta offline (ADR-077) con el motor de
// comprobantes (ADR-119): no es comprobante fiscal (la factura se pide a ARCA
// cuando la venta se sincroniza). Sin conexión no se consulta nada: usa la
// marca y el diseño de comprobantes que ya estaban en la caché del POS (si no
// hay, los de Ninja POS).
export function OfflineTicketModal({
  entry,
  onOpenChange,
}: {
  entry: OfflineQueueEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = entry !== null;
  const qc = useQueryClient();
  const printRef = useRef<HTMLDivElement>(null);
  const brand = (qc.getQueryData<SampleBrand | null>(["ticket-branding"]) ??
    null) as SampleBrand | null;
  const settings =
    qc.getQueryData<InvoiceSettingsRow | null>(INVOICE_SETTINGS_KEY) ?? null;
  // Lo guardado ya lo validó el servidor contra el plan al guardarlo.
  const style = resolveInvoiceStyle(settings?.invoice_style ?? {}, brand, {
    pro: true,
    unbranded: true,
  });
  const roll = ticketStyle(style, brand?.ticket_show_logo);
  const paper = brand?.ticket_width === "58" ? "58" : "80";
  const doc = entry
    ? invoiceFromTicket(
        offlineTicketData(entry, brand),
        docOptions(style, {
          nonFiscalLabel: "Ticket provisorio",
          showInternalRef: true,
        }),
      )
    : null;
  const portal = typeof document !== "undefined" ? document.body : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Ticket provisorio"
      description="Venta guardada sin conexión. No válido como factura."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Listo
          </Button>
          <Button onClick={() => printTicketIsolated(printRef.current, 1)}>
            <Printer size={16} aria-hidden />
            Imprimir
          </Button>
        </div>
      }
    >
      {entry && doc && (
        <div data-testid="offline-ticket" className="space-y-3 text-sm">
          <div className="bg-fg-4 rounded-xl p-3">
            <InvoicePreview doc={doc} style={roll} format={paper} />
          </div>
          {entry.change > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Vuelto</span>
              <span className="tabular-nums">
                {formatCurrency(entry.change)}
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Comprobante provisorio. Se registra y se factura cuando vuelve la
            conexión. Los precios son los de la última actualización del
            catálogo.
          </p>
          {portal &&
            createPortal(
              <div
                ref={printRef}
                aria-hidden
                className="pointer-events-none fixed -left-[9999px] top-0"
              >
                <div className="ticket-print">
                  <InvoiceDocument doc={doc} style={roll} format={paper} />
                </div>
              </div>,
              portal,
            )}
        </div>
      )}
    </Modal>
  );
}
