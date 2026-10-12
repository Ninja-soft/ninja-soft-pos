"use client";

// Pago a proveedor (F18 · H101, ADR-050): medio, referencia, moneda y tipo de
// cambio, neto pagado y retenciones practicadas. Cancela deuda por el neto más
// las retenciones (supplier_payment_create).

import { useEffect, useState } from "react";
import { Info as InfoIcon, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  PAYMENT_METHOD_LABEL,
  WITHHOLDING_LABEL,
  paymentApplied,
  type PaymentMethod,
  type WithholdingKind,
} from "@/lib/purchases/invoices";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES } from "@/lib/purchases/suppliers";
import {
  usePurchaseMutations,
  usePurchasesAccess,
  useSupplierBalances,
  useSuppliers,
} from "@/modules/purchases/hooks";
import { inputCls, parseNum, selectCls, textareaCls, today } from "./shared";

interface WhRow {
  key: number;
  kind: WithholdingKind;
  certificate: string;
  amount: string;
}

let seq = 1;

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function PaymentFormModal({
  open,
  onOpenChange,
  supplierId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplierId?: string | null;
}) {
  const { toast } = useToast();
  const access = usePurchasesAccess();
  const m = usePurchaseMutations();
  const { data: suppliers = [] } = useSuppliers({}, open);
  const { data: balances = [] } = useSupplierBalances(open);

  const [supplier, setSupplier] = useState("");
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>("transferencia");
  const [reference, setReference] = useState("");
  const [currency, setCurrency] = useState("ARS");
  const [fx, setFx] = useState("1");
  const [net, setNet] = useState("");
  const [wh, setWh] = useState<WhRow[]>([]);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setSupplier(supplierId ?? "");
    setDate(today());
    setMethod("transferencia");
    setReference("");
    setCurrency("ARS");
    setFx("1");
    setNet("");
    setWh([]);
    setNotes("");
  }, [open, supplierId]);

  const sup = suppliers.find((x) => x.id === supplier) ?? null;
  useEffect(() => {
    if (open && sup && access.pro) setCurrency(sup.currency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sup?.id, open]);

  const balance = balances.find((b) => b.supplier_id === supplier);
  const foreign = currency !== "ARS";
  const withholdings = wh
    .filter((w) => parseNum(w.amount) > 0)
    .map((w) => ({
      kind: w.kind,
      certificate: w.certificate.trim() || null,
      description: WITHHOLDING_LABEL[w.kind],
      amount: parseNum(w.amount),
    }));
  const applied = paymentApplied(parseNum(net), withholdings);
  const errors = [
    ...(!supplier ? ["Elegí el proveedor."] : []),
    ...(!(applied > 0) ? ["Cargá el importe pagado."] : []),
    ...(parseNum(net) < 0 ? ["El neto no puede ser negativo."] : []),
    ...(foreign && !(parseNum(fx) > 0) ? ["Cargá el tipo de cambio."] : []),
  ];

  function payBalance() {
    if (!balance) return;
    const target = foreign && balance.currency === currency ? balance.balance_currency : balance.balance_ars;
    const whTotal = withholdings.reduce((t, w) => t + w.amount, 0);
    setNet(String(Math.max(Math.round((target - whTotal) * 100) / 100, 0)).replace(".", ","));
  }

  async function save() {
    if (errors.length > 0) return;
    try {
      await m.createPayment.mutateAsync({
        supplier_id: supplier,
        paid_date: date,
        method,
        reference: reference.trim() || null,
        currency,
        fx_rate: foreign ? parseNum(fx) : 1,
        net_paid: parseNum(net),
        withholdings,
        notes: notes.trim() || null,
      });
      toast({ title: "Pago registrado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar el pago", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Registrar pago a proveedor"
      className="sm:max-w-2xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            Cancela: <b className="tabular-nums">{formatCurrency(applied)}</b>
            {foreign && <span className="text-muted-foreground"> {currency}</span>}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} loading={m.createPayment.isPending} disabled={errors.length > 0}>
              Registrar pago
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Proveedor" className="sm:col-span-2">
            <select
              className={selectCls}
              value={supplier}
              disabled={Boolean(supplierId)}
              onChange={(e) => setSupplier(e.target.value)}
            >
              <option value="" className="bg-popover text-popover-foreground">
                Elegí un proveedor
              </option>
              {suppliers.map((x) => (
                <option key={x.id} value={x.id} className="bg-popover text-popover-foreground">
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          {balance && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm sm:col-span-2">
              <span>
                Saldo actual:{" "}
                <b className={cn("tabular-nums", balance.balance_ars > 0 ? "text-warning" : "text-success")}>
                  {formatCurrency(balance.balance_ars)}
                </b>
                {balance.balance_ars < 0 && <span className="text-muted-foreground"> (a favor)</span>}
              </span>
              {balance.balance_ars > 0 && (
                <Button size="sm" variant="secondary" onClick={payBalance}>
                  Pagar saldo
                </Button>
              )}
            </div>
          )}
          <Field label="Fecha">
            <input type="date" className={cn(inputCls, "h-11")} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Medio">
            <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((k) => (
                <option key={k} value={k} className="bg-popover text-popover-foreground">
                  {PAYMENT_METHOD_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Referencia (n° de transferencia, cheque o comprobante)" className="sm:col-span-2">
            <input
              className={cn(inputCls, "h-11")}
              maxLength={120}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          {(access.pro || foreign) && (
            <>
              <Field label="Moneda">
                <select className={selectCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-popover text-popover-foreground">
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              {foreign ? (
                <Field label="Tipo de cambio del pago">
                  <input inputMode="decimal" className={cn(inputCls, "h-11")} value={fx} onChange={(e) => setFx(e.target.value)} />
                </Field>
              ) : (
                <span />
              )}
            </>
          )}
          <Field label="Neto pagado">
            <input
              inputMode="decimal"
              className={cn(inputCls, "h-11 text-right font-semibold")}
              value={net}
              onChange={(e) => setNet(e.target.value)}
            />
          </Field>
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Retenciones practicadas
          </h4>
          <Callout tone="info" icon={InfoIcon}>
            Por ahora las retenciones se cargan a mano y sólo cancelan deuda. El cálculo como agente de retención,
            los certificados y los regímenes de información llegan con Retenciones (H106).
          </Callout>
          {wh.map((w) => (
            <div key={w.key} className="grid grid-cols-[1fr_9rem_8rem_auto] gap-2">
              <select
                aria-label="Retención"
                className={cn(selectCls, "h-10 px-2")}
                value={w.kind}
                onChange={(e) =>
                  setWh((p) => p.map((x) => (x.key === w.key ? { ...x, kind: e.target.value as WithholdingKind } : x)))
                }
              >
                {(Object.keys(WITHHOLDING_LABEL) as WithholdingKind[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {WITHHOLDING_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                aria-label="Certificado"
                placeholder="Certificado n°"
                className={inputCls}
                value={w.certificate}
                onChange={(e) =>
                  setWh((p) => p.map((x) => (x.key === w.key ? { ...x, certificate: e.target.value } : x)))
                }
              />
              <input
                aria-label="Monto"
                inputMode="decimal"
                className={cn(inputCls, "text-right")}
                value={w.amount}
                onChange={(e) => setWh((p) => p.map((x) => (x.key === w.key ? { ...x, amount: e.target.value } : x)))}
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Quitar retención"
                onClick={() => setWh((p) => p.filter((x) => x.key !== w.key))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setWh((p) => [...p, { key: seq++, kind: "ganancias", certificate: "", amount: "" }])}
          >
            <Plus size={14} /> Agregar retención
          </Button>
        </section>

        <Field label="Notas (opcional)">
          <textarea className={textareaCls} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {errors.length > 0 && (applied > 0 || supplier) && (
          <ul className="list-disc pl-4 text-xs text-danger">
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
