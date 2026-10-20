"use client";

// F24 · H159 (ADR-172): ticket de cambio. Lleva los productos y las
// cantidades sin precios, el n° de venta y hasta cuándo se puede cambiar. No
// es comprobante fiscal. Los días se recuerdan en este equipo.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { printTicketIsolated } from "@/lib/print/webPrint";
import { exchangeDeadline, exchangeItems, type ExchangeItemInput } from "@/lib/sales/exchangeTicket";
import { formatQty } from "@/lib/utils/format";

const DAYS_KEY = "ninjapos.exchange-days";

function readDays(): number {
  try {
    const n = Number(window.localStorage.getItem(DAYS_KEY));
    return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
  } catch {
    return 30;
  }
}

export function ExchangeTicketModal({
  open,
  onOpenChange,
  businessName,
  saleLabel,
  saleDate,
  items,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  businessName: string;
  saleLabel: string;
  saleDate: string;
  items: ExchangeItemInput[];
}) {
  const { toast } = useToast();
  const printRef = useRef<HTMLDivElement>(null);
  const [days, setDays] = useState("30");
  useEffect(() => {
    if (open) setDays(String(readDays()));
  }, [open]);
  const n = Math.min(365, Math.max(1, Math.floor(Number(days)) || 30));
  const until = exchangeDeadline(saleDate, n);
  const rows = exchangeItems(items);
  const portal = typeof document !== "undefined" ? document.body : null;

  function print() {
    try {
      window.localStorage.setItem(DAYS_KEY, String(n));
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
    if (!printTicketIsolated(printRef.current)) toast({ title: "No se pudo imprimir", variant: "error" });
  }

  const ticket = (
    <div className="ticket-print mx-auto w-[72mm] space-y-2 bg-white p-3 font-mono text-[12px] leading-snug text-black">
      <p className="text-center text-sm font-bold uppercase">{businessName}</p>
      <p className="text-center font-bold">TICKET DE CAMBIO</p>
      <p className="text-center">
        Venta {saleLabel} · {new Date(saleDate).toLocaleDateString("es-AR")}
      </p>
      <hr className="border-dashed border-black" />
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between gap-2">
          <span className="min-w-0 break-words">{r.name}</span>
          <span className="shrink-0">x {formatQty(r.quantity)}</span>
        </div>
      ))}
      <hr className="border-dashed border-black" />
      <p className="text-center">Válido para cambio hasta el {until}.</p>
      <p className="text-center">Presentá este ticket con el producto sin uso y en su empaque.</p>
      <p className="text-center text-[10px]">No válido como factura</p>
    </div>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Ticket de cambio" description="Sin precios, para regalo o cambio.">
      <div className="space-y-4">
        <Input
          label="Días para cambiar"
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 3))}
        />
        <div className="max-h-80 overflow-auto rounded-xl bg-white p-2">{ticket}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button onClick={print} disabled={rows.length === 0}>
            <Printer size={16} aria-hidden /> Imprimir
          </Button>
        </div>
        {portal &&
          createPortal(
            <div ref={printRef} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
              {ticket}
            </div>,
            portal,
          )}
      </div>
    </Modal>
  );
}

