"use client";

import { useEffect, useState } from "react";
import { Ban, Minus, Plus, Printer } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useTableOrderMutations } from "@/modules/dining/hooks";
import { useDeliveryMutations } from "@/modules/delivery/hooks";
import { KDS_STATION_LABELS } from "@/modules/dining/api";
import { VOID_REASONS, diningErrorMessage, validateVoid } from "@/lib/gastro/tableOps";
import { webPrintCopies } from "@/lib/print/webPrint";
import { usePrintTarget } from "@/modules/tickets/hooks";
import { formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface VoidDone {
  voidId: string;
  name: string;
  qty: number;
  station: string | null;
  reason: string;
  at: string;
}

// Lo mínimo de una línea para anularla (mesa o delivery).
export interface VoidableItem {
  id: string;
  name: string;
  qty: number;
  station: string | null;
}

// Anulación de un ítem ya enviado a cocina (F13 · H45; delivery en ADR-097).
// Pide cantidad y motivo (obligatorio, queda en audit_logs y en
// table_order_voids / delivery_order_voids). Después ofrece imprimir el ticket
// de ANULACIÓN para la estación (sin precios), con el mismo aislamiento de
// impresión que la comanda.
export function VoidItemModal({
  item,
  tableLabel = null,
  source = "mesa",
  orderLabel = null,
  onClose,
}: {
  item: VoidableItem | null;
  tableLabel?: string | null;
  source?: "mesa" | "delivery";
  // Cabecera del ticket de anulación para delivery ("TAKEAWAY #AB12").
  orderLabel?: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const tableMut = useTableOrderMutations();
  const deliveryMut = useDeliveryMutations();
  const voidItem = source === "delivery" ? deliveryMut.voidItem : tableMut.voidItem;
  const { markVoidsPrinted } = tableMut;
  const kitchenTarget = usePrintTarget("kitchen", item !== null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<VoidDone | null>(null);

  useEffect(() => {
    if (item) {
      setQty(item.qty);
      setReason("");
      setDone(null);
    }
  }, [item]);

  const check = item ? validateVoid(item.qty, qty, reason) : null;

  async function confirm() {
    if (!item || !check?.ok) return;
    try {
      const r = await voidItem.mutateAsync({
        itemId: item.id,
        qty: qty >= item.qty ? null : qty,
        reason: reason.trim(),
      });
      setDone({
        voidId: r.void_id,
        name: item.name,
        qty: r.voided_qty,
        station: item.station,
        reason: reason.trim(),
        at: new Date().toLocaleString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
      toast({ title: "Ítem anulado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo anular", description: diningErrorMessage(e), variant: "error" });
    }
  }

  function printSlip() {
    if (!done) return;
    webPrintCopies(kitchenTarget?.profile.copies ?? 1);
    markVoidsPrinted.mutate([done.voidId]);
  }

  const stationName = done?.station
    ? KDS_STATION_LABELS[done.station as keyof typeof KDS_STATION_LABELS] ?? done.station
    : "Cocina";

  return (
    <Modal
      open={item !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={done ? "Anulación registrada" : "Anular ítem enviado"}
      description={
        done
          ? "Avisale a cocina: imprimí la anulación o la ven en el KDS."
          : "El ítem ya está en cocina. La anulación queda registrada con tu usuario y el motivo."
      }
    >
      {item && !done && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                className="grid h-11 w-11 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                aria-label="Menos"
              >
                <Minus size={16} />
              </button>
              <span className="w-12 text-center text-base font-semibold tabular-nums">
                {formatQty(qty)}
              </span>
              <button
                type="button"
                onClick={() => setQty((q) => Math.min(item.qty, q + 1))}
                className="grid h-11 w-11 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                aria-label="Más"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Cargado: {formatQty(item.qty)}. Si anulás menos, el resto sigue en el pedido.
          </p>

          <div className="flex flex-wrap gap-2">
            {VOID_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cn(
                  "min-h-9 rounded-md border px-3 text-sm transition",
                  reason === r ? "border-foreground bg-muted font-medium" : "border-border hover:bg-muted/50",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Input
            label="Motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Contá qué pasó"
            maxLength={200}
            error={reason.length > 0 && check && !check.ok ? check.error : undefined}
          />

          <Button
            variant="destructive"
            onClick={confirm}
            disabled={!check?.ok || voidItem.isPending}
            loading={voidItem.isPending}
            className="w-full"
          >
            <Ban size={16} /> Anular {formatQty(qty)}
          </Button>
        </div>
      )}

      {done && (
        <div className="space-y-4">
          <div className="comanda-print mx-auto flex max-w-full flex-col items-center">
            <div className="comanda-page w-[80mm] max-w-full rounded-md border border-neutral-300 bg-white p-3 font-mono text-sm text-black">
              <div className="border-y-2 border-black py-1 text-center text-lg font-extrabold uppercase">
                Anulación · {stationName}
              </div>
              <div className="mt-2 flex items-baseline justify-between text-[13px]">
                <span className="text-base font-bold">
                  {source === "delivery" ? (orderLabel ?? "Pedido") : `Mesa ${tableLabel ?? "s/d"}`}
                </span>
                <span>{done.at}</span>
              </div>
              <div className="my-2 border-t border-dashed border-neutral-400" />
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-extrabold tabular-nums">{formatQty(done.qty)}×</span>
                <span className="text-base font-bold line-through">{done.name}</span>
              </div>
              <div className="mt-1 text-[13px] font-semibold">Motivo: {done.reason}</div>
              <div className="mt-2 border-2 border-black px-1.5 py-0.5 text-center text-[13px] font-extrabold uppercase">
                No preparar
              </div>
            </div>
          </div>
          <div className="no-print flex gap-2">
            <Button variant="ghost" onClick={onClose} className="flex-1">
              Listo
            </Button>
            <Button onClick={printSlip} className="flex-1">
              <Printer size={16} /> Imprimir anulación
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
