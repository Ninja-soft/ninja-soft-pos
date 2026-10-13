"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { formatQty } from "@/lib/utils/format";
import {
  DIFFERENCE_REASON_LABEL,
  checkReceive,
  warehouseErrorMessage,
  type WarehouseDifferenceReason,
} from "@/lib/stock/warehouses";
import { useWarehouseMutations, type WarehouseMove } from "@/modules/stock/warehouses";
import { selectCls } from "@/components/stock/transfers/shared";

// Recepción de un movimiento interno (F11 · H33): parcial o total. Cerrar con
// diferencias (faltante = merma de la sucursal, sobrante = ajuste) lo hace el
// dueño o un encargado, con motivo por línea.
export function WarehouseReceiveModal({
  move,
  onOpenChange,
  canClose,
}: {
  move: WarehouseMove | null;
  onOpenChange: (o: boolean) => void;
  canClose: boolean;
}) {
  const { toast } = useToast();
  const m = useWarehouseMutations();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reasons, setReasons] = useState<Record<string, WarehouseDifferenceReason | "">>({});
  const [close, setClose] = useState(false);

  useEffect(() => {
    if (!move) return;
    // Por defecto: lo que falta recibir de cada línea.
    setQty(Object.fromEntries(move.items.map((i) => [i.id, Math.max(i.qty_sent - i.qty_received, 0)])));
    setReasons({});
    setClose(false);
  }, [move]);

  const inputs = useMemo(
    () =>
      (move?.items ?? []).map((i) => ({
        item_id: i.id,
        qty: Number(qty[i.id] ?? 0),
        reason: (reasons[i.id] || null) as WarehouseDifferenceReason | null,
      })),
    [move, qty, reasons],
  );
  const check = useMemo(
    () => (move ? checkReceive(move.items, inputs, close) : { errors: [], differences: [], completes: true }),
    [move, inputs, close],
  );

  async function submit() {
    if (!move) return;
    try {
      const status = await m.receive.mutateAsync({ moveId: move.id, items: inputs, close });
      toast({ title: status === "received" ? "Movimiento recibido" : "Recepción parcial registrada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo recibir", description: warehouseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(move)}
      onOpenChange={onOpenChange}
      title={move ? `Recibir movimiento #${move.number}` : "Recibir"}
      className="sm:max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={check.errors.length > 0} loading={m.receive.isPending}>
            {close || check.completes ? "Recibir y cerrar" : "Registrar recepción parcial"}
          </Button>
        </>
      }
    >
      {move && (
        <div className="space-y-4">
          <ul className="divide-y divide-border">
            {move.items.map((i) => {
              const diff = close ? check.differences.find((d) => d.item_id === i.id) : undefined;
              return (
                <li key={i.id} className="space-y-2 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {i.product_name}
                        {i.variant_label ? ` (${i.variant_label})` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Enviado {formatQty(i.qty_sent)} · ya recibido {formatQty(i.qty_received)}
                      </p>
                    </div>
                    <input
                      aria-label={`Recibo ahora de ${i.product_name}`}
                      inputMode="decimal"
                      className="h-11 w-20 rounded-lg border border-input bg-background text-center text-sm tabular-nums"
                      value={qty[i.id] ?? 0}
                      onChange={(e) =>
                        setQty((p) => ({ ...p, [i.id]: Number(e.target.value.replace(",", ".")) || 0 }))
                      }
                    />
                  </div>
                  {diff && (
                    <label className="block text-xs">
                      <span className="mb-1 block text-muted-foreground">
                        {diff.diff < 0 ? `Faltan ${formatQty(-diff.diff)}` : `Sobran ${formatQty(diff.diff)}`}: motivo
                      </span>
                      <select
                        className={selectCls}
                        value={reasons[i.id] ?? ""}
                        onChange={(e) =>
                          setReasons((p) => ({ ...p, [i.id]: e.target.value as WarehouseDifferenceReason }))
                        }
                      >
                        <option value="" className="bg-popover text-popover-foreground">
                          Elegí un motivo
                        </option>
                        {(Object.keys(DIFFERENCE_REASON_LABEL) as WarehouseDifferenceReason[])
                          .filter((r) => (diff.diff > 0 ? r === "sobrante" : r !== "sobrante"))
                          .map((r) => (
                            <option key={r} value={r} className="bg-popover text-popover-foreground">
                              {DIFFERENCE_REASON_LABEL[r]}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </li>
              );
            })}
          </ul>

          {canClose ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox checked={close} onCheckedChange={setClose} />
              <span>
                Cerrar con diferencias
                <span className="block text-xs text-muted-foreground">
                  Lo que falta sale de la sucursal como merma y lo que sobra entra como ajuste, con su motivo.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              Si llegó de menos o de más, registrá lo recibido y pedile a un encargado que cierre el movimiento.
            </p>
          )}

          {check.errors.length > 0 && (
            <Callout tone="warning" title="Revisá la recepción">
              {check.errors.join(" ")}
            </Callout>
          )}
        </div>
      )}
    </Modal>
  );
}
