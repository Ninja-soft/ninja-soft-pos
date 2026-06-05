"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { formatCurrency } from "@/lib/utils/format";
import type { SalePaymentInput } from "@/modules/pos/api";
import { useWarrantyPlans } from "@/modules/products/hooks";
import { useEnabledPaymentMethods, usePaymentPlans } from "@/modules/pos/hooks";
import type { PaymentPlan } from "@/modules/pos/api";
import type { WarrantyPlan } from "@/modules/products/api";

// Medios de pago base del POS. Se filtran según config del tenant (H14).
const ALL_METHODS: { value: SalePaymentInput["method"]; label: string; providers: string[] }[] = [
  { value: "cash",     label: "Efectivo",       providers: ["cash"] },
  { value: "transfer", label: "Transferencia",   providers: ["transfer"] },
  { value: "debit",    label: "Débito",          providers: ["mercadopago_point", "payway", "getnet", "fiserv", "mobbex"] },
  { value: "credit",   label: "Crédito",         providers: ["mercadopago_point", "payway", "getnet", "fiserv", "mobbex"] },
  { value: "qr",       label: "QR / Terminal",   providers: ["mercadopago", "mobbex", "modo", "pagos360"] },
];

// Base del plan según el método seleccionado.
const METHOD_PLAN_BASE: Partial<Record<SalePaymentInput["method"], string>> = {
  debit: "debito",
  credit: "credito",
};

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
  const { data: allPlans } = usePaymentPlans();
  const { data: enabledProviders } = useEnabledPaymentMethods();

  const [method, setMethod] = useState<SalePaymentInput["method"]>("cash");
  const [warrantyId, setWarrantyId] = useState("");
  const [planId, setPlanId] = useState("");
  const [received, setReceived] = useState("");

  // Reset al abrir (el modal queda montado entre ventas).
  useEffect(() => {
    if (open) {
      setMethod("cash");
      setWarrantyId("");
      setPlanId("");
      setReceived("");
    }
  }, [open]);

  // Reset el plan cuando cambia el método.
  useEffect(() => { setPlanId(""); }, [method]);

  // Filtrar métodos por los proveedores habilitados del tenant (H14).
  const methods = useMemo(() => {
    const enabledKeys = new Set(
      (enabledProviders ?? []).map((p: { provider_key: string }) => p.provider_key),
    );
    // Si el tenant no configuró nada, mostramos todo (fallback).
    const noConfig = enabledKeys.size === 0;

    const filtered = ALL_METHODS.filter((m) => {
      if (noConfig) return true;
      return m.providers.some((p) => enabledKeys.has(p));
    });

    const applyRound = (x: number) =>
      rounding > 0 ? Math.round(x / rounding) * rounding : x;
    const payTotalBase = applyRound(base);
    const canVale = storeCreditBalance >= payTotalBase && payTotalBase > 0;

    return [
      ...filtered,
      ...(canVale
        ? [{ value: "store_credit" as const, label: `Vale (saldo ${formatCurrency(storeCreditBalance)})`, providers: [] }]
        : []),
      ...(hasCustomer
        ? [{ value: "account" as const, label: "Cuenta corriente (fiado)", providers: [] }]
        : []),
    ];
  }, [enabledProviders, storeCreditBalance, hasCustomer, base, rounding]);

  // Planes del método actual (débito → base "debito", crédito → "credito").
  const planBase = METHOD_PLAN_BASE[method];
  const methodPlans = useMemo((): PaymentPlan[] => {
    if (!planBase || !allPlans) return [];
    return allPlans.filter((p: PaymentPlan) => p.base === planBase);
  }, [planBase, allPlans]);

  const selectedPlan = (allPlans ?? []).find((p: PaymentPlan) => p.id === planId) ?? null;
  const planSurcharge = selectedPlan
    ? Math.round(((base * Number(selectedPlan.surcharge_pct)) / 100) * 100) / 100
    : 0;

  // Recargo global del medio (tenant_payment_methods.surcharge_pct), solo cuando
  // no hay plan seleccionado y el método tiene surcharge_pct > 0 (H14).
  const METHOD_PROVIDER: Partial<Record<SalePaymentInput["method"], string>> = {
    cash: "cash",
    transfer: "transfer",
  };
  const methodProviderKey = METHOD_PROVIDER[method];
  const methodSurchargePct = methodProviderKey
    ? Number(
        (enabledProviders ?? []).find(
          (p: { provider_key: string }) => p.provider_key === methodProviderKey,
        )?.surcharge_pct ?? 0,
      )
    : 0;
  const methodSurcharge =
    !selectedPlan && methodSurchargePct > 0
      ? Math.round(((base * methodSurchargePct) / 100) * 100) / 100
      : 0;

  const wplan = (wplans ?? []).find((p: WarrantyPlan) => p.id === warrantyId) ?? null;
  const warrantyPrima = wplan
    ? Number(wplan.price_pct) > 0
      ? Math.round(((base * Number(wplan.price_pct)) / 100) * 100) / 100
      : Number(wplan.price)
    : 0;

  const applyRound = (x: number) =>
    rounding > 0 ? Math.round(x / rounding) * rounding : x;
  const payTotal = applyRound(base + warrantyPrima + planSurcharge + methodSurcharge);
  const receivedNum = Number(received) || 0;
  const change = method === "cash" ? Math.max(0, receivedNum - payTotal) : 0;

  const extras: { name: string; amount: number }[] = [];
  if (warrantyPrima > 0 && wplan) extras.push({ name: `Garantía ${wplan.label}`, amount: warrantyPrima });
  if (planSurcharge > 0 && selectedPlan) extras.push({ name: `Recargo ${selectedPlan.label}`, amount: planSurcharge });
  if (methodSurcharge > 0) {
    const methodLabel = ALL_METHODS.find((m) => m.value === method)?.label ?? method;
    extras.push({ name: `Recargo ${methodLabel} (${methodSurchargePct}%)`, amount: methodSurcharge });
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cobrar"
      description={`Total: ${formatCurrency(payTotal)}`}
    >
      <div className="space-y-4">
        {/* Medio de pago */}
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

        {/* Plan de pago (débito / crédito) con recargo (H14 / H27) */}
        {methodPlans.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              Plan de pago
            </label>
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15"
            >
              <option value="">Sin plan / recargo</option>
              {methodPlans.map((p) => (
                <option key={p.id} value={p.id} className="bg-ninja-deepViolet">
                  {p.label}
                  {Number(p.surcharge_pct) > 0 ? ` (+${Number(p.surcharge_pct)}%)` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Garantía extendida */}
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
              {(wplans ?? []).map((p: WarrantyPlan) => (
                <option key={p.id} value={p.id} className="bg-ninja-deepViolet">
                  {p.label} ({p.months} meses · {formatCurrency(Number(p.price))})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Resumen de extras (garantía + recargo de plan) */}
        {extras.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm space-y-1">
            {extras.map((e) => (
              <div key={e.name} className="flex justify-between text-muted-foreground">
                <span>{e.name}</span>
                <span>+{formatCurrency(e.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between font-semibold border-t border-border pt-1 mt-1">
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
                [{ method, amount: payTotal }],
                extras.length > 0 ? extras : [],
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
