"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

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

export function CloseShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
  locationLabel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (closing: number, notes: string) => void;
  loading: boolean;
  locationLabel?: string;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
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
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            onClick={() => onConfirm(Number(amount) || 0, notes)}
          >
            Cerrar caja
          </Button>
        </div>
      </div>
    </Modal>
  );
}
