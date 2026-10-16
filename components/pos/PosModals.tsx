"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/Callout";
import { useShiftMovements } from "@/modules/cash/hooks";
import { summarize } from "@/modules/cash/api";
import { MIN_REASON, validReason, zeroCloseNeedsConfirm } from "@/lib/cash/closeControls";
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
          <Button loading={loading} onClick={() => onConfirm(Number(amount) || 0)} data-tour="caja-abrir-confirmar">
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
  shiftId,
  opening,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (
    closing: number,
    notes: string,
    pendingAction: "cancel" | "carry" | null,
    zeroCloseReason?: string | null,
  ) => void;
  loading: boolean;
  locationLabel?: string;
  // Cobros en espera abiertos en este turno (ADR-048): obligan a decidir.
  pending?: ClosePendingSummary | null;
  // H156 (ADR-158): turno y apertura para calcular el efectivo esperado.
  shiftId?: string | null;
  opening?: number;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<"cancel" | "carry" | null>(null);
  const [zeroReason, setZeroReason] = useState("");
  const needsDecision = Boolean(pending && pending.waiting + pending.paid > 0);
  // El esperado sale de los movimientos del turno (se piden sólo con el modal abierto).
  const { data: movements } = useShiftMovements(open && shiftId ? shiftId : null);
  const expected = movements ? summarize(opening ?? 0, movements).cashExpected : null;
  const counted = Number(amount) || 0;
  const needsZeroConfirm = zeroCloseNeedsConfirm(counted, expected);
  const zeroOk = !needsZeroConfirm || validReason(zeroReason);
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
        {expected !== null && (
          <p className="-mt-2 text-xs text-muted-foreground">
            El sistema espera {formatCurrency(expected)} en efectivo.
          </p>
        )}
        {needsZeroConfirm && expected !== null && (
          <Callout tone="warning" icon={AlertTriangle} title="Vas a cerrar con $0 contados">
            <p>
              El sistema espera {formatCurrency(expected)}. Si es así, contá de nuevo o escribí por qué. La diferencia
              queda como faltante de caja.
            </p>
            <div className="mt-2">
              <Input
                label="¿Por qué cerrás con $0?"
                value={zeroReason}
                maxLength={300}
                placeholder={`Mínimo ${MIN_REASON} letras`}
                onChange={(e) => setZeroReason(e.target.value)}
              />
            </div>
          </Callout>
        )}
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
            disabled={(needsDecision && pendingAction === null) || !zeroOk}
            onClick={() =>
              onConfirm(
                counted,
                notes,
                needsDecision ? pendingAction : null,
                needsZeroConfirm ? zeroReason.trim() : null,
              )
            }
          >
            Cerrar caja
          </Button>
        </div>
      </div>
    </Modal>
  );
}
