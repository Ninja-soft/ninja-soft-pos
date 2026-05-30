"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import type { SalePaymentInput } from "@/modules/pos/api";

const METHODS: { value: SalePaymentInput["method"]; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "transfer", label: "Transferencia" },
  { value: "qr", label: "QR" },
];

export function OpenShiftModal({
  open,
  onOpenChange,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (opening: number) => void;
  loading: boolean;
}) {
  const [amount, setAmount] = useState("0");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Abrir caja">
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
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (closing: number, notes: string) => void;
  loading: boolean;
}) {
  const [amount, setAmount] = useState("0");
  const [notes, setNotes] = useState("");
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Cerrar caja (arqueo)">
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

export function PaymentModal({
  open,
  onOpenChange,
  total,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  total: number;
  onConfirm: (payments: SalePaymentInput[]) => void;
  loading: boolean;
}) {
  const [method, setMethod] = useState<SalePaymentInput["method"]>("cash");
  const [received, setReceived] = useState(String(total));
  const receivedNum = Number(received) || 0;
  const change = method === "cash" ? Math.max(0, receivedNum - total) : 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cobrar"
      description={`Total: ${formatCurrency(total)}`}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Medio de pago
          </label>
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as SalePaymentInput["method"])
            }
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value} className="bg-ninja-deepViolet">
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {method === "cash" && (
          <>
            <Input
              label="Recibido"
              type="number"
              step="0.01"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
            />
            <p className="text-sm text-ninja-lavender">
              Vuelto:{" "}
              <span className="font-semibold text-foreground">
                {formatCurrency(change)}
              </span>
            </p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            loading={loading}
            onClick={() =>
              onConfirm([
                {
                  method,
                  amount: method === "cash" ? Math.max(receivedNum, total) : total,
                },
              ])
            }
          >
            Confirmar venta
          </Button>
        </div>
      </div>
    </Modal>
  );
}
