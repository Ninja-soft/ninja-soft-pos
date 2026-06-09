"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChefHat,
  CreditCard,
  Minus,
  Plus,
  ReceiptText,
  Trash2,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  useTableOrderItems,
  useTableOrderMutations,
} from "@/modules/dining/hooks";
import { useTicketBranding } from "@/modules/tickets/hooks";
import type { DiningTable, TableStatus } from "@/modules/dining/api";
import { TABLE_STATUS_LABELS } from "@/modules/dining/api";
import { TableProductPicker } from "./TableProductPicker";
import { ComandaModal } from "./ComandaModal";
import { formatCurrency, formatQty } from "@/lib/utils/format";

// Cuenta de una mesa ocupada (H44): ver/editar ítems, agregar, marcar "cuenta
// pedida", cancelar y COBRAR. El cobro abre el POS con los ítems cargados
// (/pos?table=<order_id>) y reusa create_sale + PaymentModal; al confirmar, el POS
// llama close_dining_table (enlaza venta + libera la mesa).
export function TableAccountModal({
  table,
  onClose,
  onSetStatus,
}: {
  table: DiningTable | null;
  onClose: () => void;
  onSetStatus: (tableId: string, status: TableStatus) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const orderId = table?.current_order_id ?? null;
  const open = table !== null && orderId !== null;
  const { data: items } = useTableOrderItems(orderId);
  const { setItemQty, removeItem, cancel } = useTableOrderMutations();
  // Nombre del local para la cabecera (opcional) de la comanda de cocina (H45).
  const { data: brand } = useTicketBranding(open);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [comandaOpen, setComandaOpen] = useState(false);

  const total = useMemo(
    () => (items ?? []).reduce((acc, it) => acc + it.qty * it.unit_price, 0),
    [items],
  );

  async function changeQty(itemId: string, qty: number) {
    try {
      await setItemQty.mutateAsync({ itemId, qty: Math.max(0, qty) });
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function doCancel() {
    if (!orderId) return;
    try {
      await cancel.mutateAsync(orderId);
      toast({ title: "Pedido cancelado, mesa liberada", variant: "success" });
      setConfirmCancel(false);
      onClose();
    } catch (e) {
      toast({
        title: "No se pudo cancelar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // Cobrar: lleva al POS con el pedido cargado. El POS resuelve el resto (medios,
  // descuentos, cliente) y cierra la mesa al confirmar.
  function charge() {
    if (!orderId) return;
    if ((items ?? []).length === 0) {
      toast({ title: "La mesa no tiene ítems para cobrar", variant: "info" });
      return;
    }
    router.push(`/pos?table=${orderId}`);
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={table ? `Mesa ${table.label}` : "Mesa"}
      >
        <div className="space-y-4">
          {/* Estado + capacidad */}
          {table && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {TABLE_STATUS_LABELS[table.status]} · {table.capacity} personas
              </span>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Plus size={15} /> Agregar ítem
              </Button>
            </div>
          )}

          {/* Líneas del pedido */}
          <div className="max-h-[46vh] space-y-2 overflow-y-auto">
            {(items ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                Mesa abierta sin ítems. Tocá{" "}
                <span className="font-medium text-foreground">Agregar ítem</span>{" "}
                para cargar el pedido.
              </p>
            ) : (
              items!.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {it.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatCurrency(it.unit_price)} c/u
                      {it.notes ? ` · ${it.notes}` : ""}
                    </div>
                  </div>

                  {/* Controles de cantidad */}
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => changeQty(it.id, it.qty - 1)}
                      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      aria-label="Restar"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-8 text-center text-sm font-semibold tabular-nums">
                      {formatQty(it.qty)}
                    </span>
                    <button
                      type="button"
                      onClick={() => changeQty(it.id, it.qty + 1)}
                      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      aria-label="Sumar"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  <div className="w-20 shrink-0 text-right price-hl font-price text-sm font-bold tabular-nums">
                    {formatCurrency(it.qty * it.unit_price)}
                  </div>

                  <button
                    type="button"
                    onClick={() => removeItem.mutate(it.id)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-red-300"
                    aria-label="Quitar"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Total */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-medium text-muted-foreground">Total</span>
            <span className="price-hl font-price text-2xl font-bold tabular-nums">
              {formatCurrency(total)}
            </span>
          </div>

          {/* Comanda de cocina (H45): imprime la(s) comanda(s) por estación del
              pedido. Por defecto envía sólo lo nuevo a cocina/barra. */}
          <Button
            variant="secondary"
            onClick={() => setComandaOpen(true)}
            disabled={(items ?? []).length === 0}
            className="w-full"
          >
            <ChefHat size={16} /> Imprimir comanda
          </Button>

          {/* Acciones */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={charge} className="flex-1">
              <CreditCard size={16} /> Cobrar mesa
            </Button>
            {table?.status === "ocupada" ? (
              <Button
                variant="secondary"
                onClick={() => table && onSetStatus(table.id, "cuenta_pedida")}
              >
                <ReceiptText size={15} /> Cuenta pedida
              </Button>
            ) : (
              table?.status === "cuenta_pedida" && (
                <Button
                  variant="secondary"
                  onClick={() => table && onSetStatus(table.id, "ocupada")}
                >
                  Reabrir
                </Button>
              )
            )}
            <Button
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              className="text-destructive"
            >
              <X size={15} /> Cancelar pedido
            </Button>
          </div>
        </div>
      </Modal>

      {/* Picker de productos para agregar al pedido */}
      <TableProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        orderId={orderId}
      />

      {/* Comanda de cocina por estación (H45) */}
      <ComandaModal
        open={comandaOpen}
        onOpenChange={setComandaOpen}
        orderId={orderId}
        businessName={brand?.legal_name ?? null}
      />

      {/* Confirmación de cancelación (libera la mesa, anula el pedido) */}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancelar el pedido de la mesa"
        description="Se anula el pedido y la mesa queda libre. Esta acción no se puede deshacer."
        confirmLabel="Cancelar pedido"
        danger
        loading={cancel.isPending}
        onConfirm={doCancel}
      />
    </>
  );
}
