"use client";

import { Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useSaleDetail } from "@/modules/sales/hooks";
import { formatCurrency, formatQty } from "@/lib/utils/format";

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
}

export function TicketModal({ open, onOpenChange, saleId }: Props) {
  const { data, isLoading } = useSaleDetail(saleId, open);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Ticket" className="max-w-sm">
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <div className="ticket-print rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground">
            <div className="text-center">
              <div className="font-display text-base font-bold">NinjaSoft POS</div>
              <div className="text-xs text-muted-foreground">Ticket no fiscal</div>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Venta #{data.sale.number}</span>
              <span>{new Date(data.sale.created_at).toLocaleString("es-AR")}</span>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            <ul className="space-y-1">
              {data.items.map((it) => (
                <li key={it.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {formatQty(it.quantity)}× {it.product_name}
                  </span>
                  <span>{formatCurrency(it.subtotal)}</span>
                </li>
              ))}
            </ul>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="flex justify-between text-xs">
              <span>Subtotal</span>
              <span>{formatCurrency(data.sale.subtotal)}</span>
            </div>
            {data.sale.discount_total > 0 && (
              <div className="flex justify-between text-xs">
                <span>Descuento</span>
                <span>-{formatCurrency(data.sale.discount_total)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between text-base font-bold">
              <span>TOTAL</span>
              <span>{formatCurrency(data.sale.total)}</span>
            </div>
            <div className="my-3 border-t border-dashed border-border" />
            {data.payments.map((p) => (
              <div key={p.id} className="flex justify-between text-xs">
                <span>{METHOD_LABELS[p.method] ?? p.method}</span>
                <span>{formatCurrency(p.amount)}</span>
              </div>
            ))}
            {data.sale.status === "voided" && (
              <div className="mt-3 text-center text-xs font-bold text-red-500">
                ** ANULADA **
              </div>
            )}
            <div className="mt-4 text-center text-xs text-muted-foreground">
              ¡Gracias por su compra!
            </div>
          </div>

          <div className="no-print mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button onClick={() => window.print()}>
              <Printer size={16} /> Imprimir
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
