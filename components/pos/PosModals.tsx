"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";

// Apertura y cierre de caja del POS. El cobro vive en la hoja única
// (components/pos/checkout/CheckoutSheet.tsx), que reemplazó a PaymentModal.

export function OpenShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
  locationLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (opening: number) => void;
  loading: boolean;
  // "Centro · Caja 1": dónde se abre el turno (F17 · H90).
  locationLabel?: string;
}) {
  const [amount, setAmount] = useState("0");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Abrir caja" description={locationLabel || undefined}>
      <div className="space-y-4">
        <Input
          label="Monto inicial"
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button loading={loading} onClick={() => onConfirm(Number(amount) || 0)}>
            Abrir
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export interface ClosePendingSummary {
  waiting: number;
  paid: number;
  amount: number;
}

export function CloseShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
  locationLabel,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (closing: number, notes: string, pendingAction: "cancel" | "carry" | null) => void;
  loading: boolean;
  locationLabel?: string;
  // Cobros en espera abiertos en este turno (ADR-048): obligan a decidir.
  pending?: ClosePendingSummary | null;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<"cancel" | "carry" | null>(null);
  const needsDecision = Boolean(pending && pending.waiting + pending.paid > 0);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cerrar caja (arqueo)"
      description={locationLabel || undefined}
    >
      <div className="space-y-4">
        <Input
          label="Efectivo contado"
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {needsDecision && pending && (
          <fieldset className="space-y-2 rounded-xl bg-fg-4 p-3">
            <legend className="sr-only">Cobros en espera</legend>
            <p className="text-sm font-semibold">
              Tenés {pending.waiting + pending.paid} cobro{pending.waiting + pending.paid === 1 ? "" : "s"} en espera
              {" "}por {formatCurrency(pending.amount)}
            </p>
            <p className="text-xs text-muted-foreground">
              No entran en este arqueo (todavía no se cobraron). Elegí qué hacer con ellos.
            </p>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-fg-6">
              <input
                type="radio"
                name="pending-action"
                className="mt-1"
                checked={pendingAction === "carry"}
                onChange={() => setPendingAction("carry")}
              />
              <span className="text-sm">
                <span className="font-medium">Pasarlos a la próxima apertura</span>
                <span className="block text-xs text-muted-foreground">
                  Siguen esperando el pago. Si el cliente paga, la venta entra en la caja abierta en ese momento (o en la próxima que se abra).
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-fg-6">
              <input
                type="radio"
                name="pending-action"
                className="mt-1"
                checked={pendingAction === "cancel"}
                onChange={() => setPendingAction("cancel")}
              />
              <span className="text-sm">
                <span className="font-medium">Cancelar todos los cobros en espera</span>
                <span className="block text-xs text-muted-foreground">
                  Los links dejan de servir.
                  {pending.paid > 0
                    ? ` Los ${pending.paid} que ya se pagaron no se cancelan: pasan a la próxima apertura.`
                    : ""}
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            disabled={needsDecision && pendingAction === null}
            onClick={() => onConfirm(Number(amount) || 0, notes, needsDecision ? pendingAction : null)}
          >
            Cerrar caja
          </Button>
        </div>
      </div>
    </Modal>
  );
}
