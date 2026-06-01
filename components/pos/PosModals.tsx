"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import type { SalePaymentInput } from "@/modules/pos/api";
import { useWarrantyPlans } from "@/modules/products/hooks";

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
  base,
  rounding = 0,
  onConfirm,
  loading,
  storeCreditBalance = 0,
  hasCustomer = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: number; // subtotal - descuento, SIN redondear
  rounding?: number;
  onConfirm: (
    payments: SalePaymentInput[],
    extras?: { name: string; amount: number }[],
  ) => void;
  loading: boolean;
  storeCreditBalance?: number;
  hasCustomer?: boolean;
}) {
  const { data: wplans } = useWarrantyPlans(true);
  const [method, setMethod] = useState<SalePaymentInput["method"]>("cash");
  const [warrantyId, setWarrantyId] = useState("");
  const [received, setReceived] = useState("");

  // Reset al abrir (el modal queda montado entre ventas).
  useEffect(() => {
    if (open) {
      setMethod("cash");
      setWarrantyId("");
      setReceived("");
    }
  }, [open]);

  const wplan = (wplans ?? []).find((p) => p.id === warrantyId) ?? null;
  // Prima: % del precio (sobre la base) si está cargado, si no la fija.
  const warrantyPrima = wplan
    ? Number(wplan.price_pct) > 0
      ? Math.round(((base * Number(wplan.price_pct)) / 100) * 100) / 100
      : Number(wplan.price)
    : 0;
  // payTotal con el MISMO orden de redondeo que create_sale. El recargo por
  // plan/cuota se aplica solo en el cobro con QR (Mercado Pago), no acá.
  const applyRound = (x: number) =>
    rounding > 0 ? Math.round(x / rounding) * rounding : x;
  const payTotal = applyRound(base + warrantyPrima);
  const receivedNum = Number(received) || 0;
  const change = method === "cash" ? Math.max(0, receivedNum - payTotal) : 0;

  // El vale solo aparece si el saldo del cliente cubre el total a cobrar.
  const canVale = storeCreditBalance >= payTotal && payTotal > 0;
  const methods = [
    ...METHODS,
    ...(canVale
      ? [
          {
            value: "store_credit" as const,
            label: `Vale (saldo ${formatCurrency(storeCreditBalance)})`,
          },
        ]
      : []),
    ...(hasCustomer
      ? [{ value: "account" as const, label: "Cuenta corriente (fiado)" }]
      : []),
  ];

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

        {(wplans ?? []).length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Garantía extendida
            </label>
            <select
              value={warrantyId}
              onChange={(e) => setWarrantyId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin garantía extendida</option>
              {(wplans ?? []).map((p) => (
                <option key={p.id} value={p.id} className="bg-ninja-deepViolet">
                  {p.label} ({p.months} meses · {formatCurrency(Number(p.price))})
                </option>
              ))}
            </select>
          </div>
        )}

        {warrantyPrima > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Garantía {wplan?.label}</span>
              <span>+{formatCurrency(warrantyPrima)}</span>
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
                    // El monto registrado es el de la venta (payTotal); el
                    // efectivo recibido y el vuelto son solo ayuda visual.
                    method,
                    amount: payTotal,
                  },
                ],
                warrantyPrima > 0 && wplan
                  ? [{ name: `Garantía ${wplan.label}`, amount: warrantyPrima }]
                  : [],
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
