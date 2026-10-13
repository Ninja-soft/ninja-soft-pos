"use client";

import { Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import type { OfflineQueueEntry } from "@/lib/pos/offline/queue";

const METHOD: Record<string, string> = {
  cash: "Efectivo",
  transfer: "Transferencia",
  debit: "Débito",
  credit: "Crédito",
};

// Ticket provisorio de una venta offline (ADR-077). No es comprobante fiscal:
// la factura se pide a ARCA cuando la venta se sincroniza.
export function OfflineTicketModal({
  entry,
  onOpenChange,
}: {
  entry: OfflineQueueEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = entry !== null;
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
          <Button onClick={() => window.print()}>
            <Printer size={16} aria-hidden />
            Imprimir
          </Button>
        </div>
      }
    >
      {entry && (
        <div data-testid="offline-ticket" className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-base font-semibold">{entry.provisional}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(entry.sold_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
            </span>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {entry.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{l.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {l.quantity} × {formatCurrency(l.unitPrice)}
                    {l.discount > 0 ? ` · desc. ${formatCurrency(l.discount)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatCurrency(l.quantity * l.unitPrice - l.discount)}
                </span>
              </li>
            ))}
          </ul>
          <div className="space-y-1">
            <div className="flex justify-between font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{formatCurrency(entry.total)}</span>
            </div>
            {entry.paymentsSummary.map((p, i) => (
              <div key={i} className="flex justify-between text-muted-foreground">
                <span>{METHOD[p.method] ?? p.method}</span>
                <span className="tabular-nums">{formatCurrency(p.amount)}</span>
              </div>
            ))}
            {entry.change > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Vuelto</span>
                <span className="tabular-nums">{formatCurrency(entry.change)}</span>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Comprobante provisorio. Se registra y se factura cuando vuelve la conexión. Los precios son los de la
            última actualización del catálogo.
          </p>
        </div>
      )}
    </Modal>
  );
}
