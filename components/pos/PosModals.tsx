"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import type { SalePaymentInput } from "@/modules/pos/api";
import { usePaymentPlans } from "@/modules/pos/hooks";

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
  storeCreditBalance = 0,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  total: number;
  onConfirm: (
    payments: SalePaymentInput[],
    surcharge?: { label: string; amount: number },
  ) => void;
  loading: boolean;
  storeCreditBalance?: number;
}) {
  const { data: plans } = usePaymentPlans(true);
  const [method, setMethod] = useState<SalePaymentInput["method"]>("cash");
  const [planId, setPlanId] = useState("");
  const [received, setReceived] = useState(String(total));

  const plan = (plans ?? []).find((p) => p.id === planId) ?? null;
  const surchargePct = plan ? Number(plan.surcharge_pct) : 0;
  const surcharge = Math.round(((total * surchargePct) / 100) * 100) / 100;
  const payTotal = total + surcharge;
  const receivedNum = Number(received) || 0;
  const change = method === "cash" ? Math.max(0, receivedNum - payTotal) : 0;

  // El vale solo aparece si el saldo del cliente cubre el total a cobrar.
  const canVale = storeCreditBalance >= payTotal && payTotal > 0;
  const methods = canVale
    ? [
        ...METHODS,
        {
          value: "store_credit" as const,
          label: `Vale (saldo ${formatCurrency(storeCreditBalance)})`,
        },
      ]
    : METHODS;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cobrar"
      description={`Total: ${formatCurrency(payTotal)}`}
    >
      <div className="space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Medio de pago
          </label>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as SalePaymentInput["method"])}
            className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
          >
            {methods.map((m) => (
              <option key={m.value} value={m.value} className="bg-ninja-deepViolet">
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {(plans ?? []).length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan / recargo
            </label>
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin recargo</option>
              {(plans ?? []).map((p) => (
                <option key={p.id} value={p.id} className="bg-ninja-deepViolet">
                  {p.label}
                  {Number(p.surcharge_pct) ? ` (+${p.surcharge_pct}%)` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {surcharge > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Recargo {plan?.label}</span>
              <span>+{formatCurrency(surcharge)}</span>
            </div>
            <div className="mt-1 flex justify-between font-semibold">
              <span>Total a cobrar</span>
              <span>{formatCurrency(payTotal)}</span>
            </div>
          </div>
        )}

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
              onConfirm(
                [
                  {
                    method,
                    amount: method === "cash" ? Math.max(receivedNum, payTotal) : payTotal,
                  },
                ],
                surcharge > 0 && plan
                  ? { label: plan.label, amount: surcharge }
                  : undefined,
              )
            }
          >
            Confirmar venta
          </Button>
        </div>
      </div>
    </Modal>
  );
}
