"use client";

// Orden de pago a proveedor (F18 · ADR-059): paga uno o varios comprobantes
// (imputación manual o automática por vencimiento), admite pago parcial y deja
// a cuenta lo no imputado. Medios: efectivo de la caja propia abierta,
// transferencia (desde una cuenta bancaria de tesorería o sólo con la
// referencia), cheque o e-cheq propio, cheque de terceros en cartera,
// depósito, tarjeta u otro. Retenciones de IVA, Ganancias e IIBB con n° de
// certificado (placeholder hasta H106). Lo valida el servidor
// (supplier_payment_order_create).

import { useEffect, useMemo, useState } from "react";
import { Info as InfoIcon, Plus, Trash2, Wand2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { WITHHOLDING_LABEL, type WithholdingKind } from "@/lib/purchases/invoices";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import {
  PAYMENT_LINE_METHODS,
  PAYMENT_LINE_METHOD_LABEL,
  TREASURY_METHODS,
  autoAllocate,
  paymentOrderTotals,
  validatePaymentOrder,
  type PaymentLineDraft,
  type PaymentLineMethod,
} from "@/lib/purchases/paymentOrders";
import {
  useInvoiceOpen,
  usePurchaseV2Mutations,
  useSuppliers,
  useTreasuryEnabled,
} from "@/modules/purchases/hooks";
import { useCheques, useMyOpenShift, useTreasuryAccounts } from "@/modules/treasury/hooks";
import { ErrorList, FormField, SectionTitle, fmtDate, inputCls, parseNum, selectCls, textareaCls, today } from "./shared";

interface LineRow {
  key: number;
  method: PaymentLineMethod;
  amount: string;
  accountId: string;
  chequeId: string;
  chequeNumber: string;
  chequeDate: string;
  chequeBank: string;
  reference: string;
}

interface WhRow {
  key: number;
  kind: WithholdingKind;
  certificate: string;
  amount: string;
}

const WH_KINDS: WithholdingKind[] = ["iva", "ganancias", "iibb", "suss", "otro"];

let seq = 1;
const newLine = (method: PaymentLineMethod = "transferencia"): LineRow => ({
  key: seq++,
  method,
  amount: "",
  accountId: "",
  chequeId: "",
  chequeNumber: "",
  chequeDate: today(),
  chequeBank: "",
  reference: "",
});

const fmtInput = (n: number) => (n ? String(Math.round(n * 100) / 100).replace(".", ",") : "");

export function PaymentOrderModal({
  open,
  onOpenChange,
  supplierId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplierId: string | null;
  onCreated?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = usePurchaseV2Mutations();
  const treasury = useTreasuryEnabled();
  const { data: suppliers = [] } = useSuppliers({}, open);
  const { data: accounts = [] } = useTreasuryAccounts({}, open && treasury);
  const { data: wallet = [] } = useCheques({ kind: "third_party", statuses: ["en_cartera"] }, open && treasury);
  const { data: shift } = useMyOpenShift(open);

  const [supplier, setSupplier] = useState("");
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineRow[]>([newLine()]);
  const [wh, setWh] = useState<WhRow[]>([]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setSupplier(supplierId ?? "");
    setDate(today());
    setNotes("");
    setLines([newLine()]);
    setWh([]);
    setAlloc({});
  }, [open, supplierId]);

  const { data: openDocs = [], isLoading: docsLoading } = useInvoiceOpen(open && supplier ? supplier : null);
  const docs = useMemo(() => openDocs.filter((d) => d.open_ars > 0.004), [openDocs]);

  const bankAccounts = accounts.filter((a) => a.is_active && a.kind === "bank");
  const activeAccounts = accounts.filter((a) => a.is_active);

  const draftLines: PaymentLineDraft[] = lines.map((l) => ({
    method: l.method,
    amount: parseNum(l.amount),
    reference: l.reference.trim() || null,
    treasury_account_id:
      l.method === "efectivo" || l.method === "cheque_tercero" || l.method === "tarjeta" || l.method === "otro"
        ? null
        : l.accountId || null,
    cheque_id: l.method === "cheque_tercero" ? l.chequeId || null : null,
    cheque:
      l.method === "cheque_propio" || l.method === "echeq"
        ? { number: l.chequeNumber.trim(), payment_date: l.chequeDate, bank_name: l.chequeBank.trim() || null }
        : null,
  }));
  const withholdings = wh
    .filter((w) => parseNum(w.amount) > 0)
    .map((w) => ({
      kind: w.kind,
      description: WITHHOLDING_LABEL[w.kind],
      certificate: w.certificate.trim() || null,
      amount: parseNum(w.amount),
    }));
  const allocations = Object.entries(alloc)
    .map(([invoice_id, v]) => ({ invoice_id, amount: parseNum(v) }))
    .filter((a) => a.amount > 0);
  const totals = paymentOrderTotals(draftLines, withholdings, allocations);
  const chequesInWallet = useMemo(() => new Map(wallet.map((c) => [c.id, c.amount])), [wallet]);

  const errors = [
    ...(!supplier ? ["Elegí el proveedor."] : []),
    ...validatePaymentOrder(
      { lines: draftLines, withholdings, allocations },
      { openDocs: docs, hasTreasury: treasury, hasOpenShift: Boolean(shift), chequesInWallet },
    ),
  ];

  const setLine = (key: number, patch: Partial<LineRow>) =>
    setLines((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  function autoImpute() {
    const next: Record<string, string> = {};
    for (const a of autoAllocate(totals.total, docs)) next[a.invoice_id] = fmtInput(a.amount);
    setAlloc(next);
  }

  function payAll() {
    const debt = docs.reduce((t, d) => t + d.open_ars, 0);
    const whTotal = withholdings.reduce((t, w) => t + w.amount, 0);
    const target = Math.max(Math.round((debt - whTotal) * 100) / 100, 0);
    setLines((p) => (p.length === 1 ? [{ ...p[0]!, amount: fmtInput(target) }] : p));
    const next: Record<string, string> = {};
    for (const d of docs) next[d.invoice_id] = fmtInput(d.open_ars);
    setAlloc(next);
  }

  async function save() {
    if (errors.length > 0) return;
    try {
      const id = await m.createPaymentOrder.mutateAsync({
        supplier_id: supplier,
        paid_date: date,
        notes: notes.trim() || null,
        lines: draftLines,
        withholdings,
        allocations,
      });
      toast({ title: "Orden de pago registrada", variant: "success" });
      onOpenChange(false);
      onCreated?.(id);
    } catch (e) {
      toast({ title: "No se pudo registrar la orden de pago", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const methods = PAYMENT_LINE_METHODS.filter((k) => treasury || !TREASURY_METHODS.includes(k));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Orden de pago"
      description="Pagá uno o varios comprobantes del proveedor; lo que no imputes queda a cuenta."
      className="sm:max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
            <span>
              Total <b>{formatCurrency(totals.total)}</b>
            </span>
            <span className="text-muted-foreground">Imputado {formatCurrency(totals.allocated)}</span>
            {totals.onAccount > 0.004 && (
              <span className="text-muted-foreground">A cuenta {formatCurrency(totals.onAccount)}</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => void save()}
              loading={m.createPaymentOrder.isPending}
              disabled={errors.length > 0}
            >
              Registrar orden
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <FormField label="Proveedor" className="sm:col-span-2">
            <select
              className={selectCls}
              value={supplier}
              onChange={(e) => {
                setSupplier(e.target.value);
                setAlloc({});
              }}
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
          </FormField>
          <FormField label="Fecha">
            <input type="date" className={cn(inputCls, "h-11")} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </section>

        {supplier && (
          <section className="space-y-2">
            <SectionTitle
              action={
                docs.length > 0 ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={payAll}>
                      Pagar todo
                    </Button>
                    <Button size="sm" variant="secondary" onClick={autoImpute} disabled={!(totals.total > 0)}>
                      <Wand2 size={14} /> Imputar por vencimiento
                    </Button>
                  </div>
                ) : undefined
              }
            >
              Comprobantes a pagar
            </SectionTitle>
            {docsLoading ? (
              <p className="py-3 text-sm text-muted-foreground">Cargando comprobantes...</p>
            ) : docs.length === 0 ? (
              <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
                No hay comprobantes con saldo. Lo que pagues queda a cuenta (anticipo).
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Comprobante</th>
                      <th className="px-3 py-2 text-left">Vence</th>
                      <th className="px-3 py-2 text-right">Saldo</th>
                      <th className="w-36 px-3 py-2 text-right">Imputar</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {docs.map((d) => {
                      const v = parseNum(alloc[d.invoice_id]);
                      const over = v > d.open_ars + 0.005;
                      const overdue = d.due_date < today();
                      return (
                        <tr key={d.invoice_id}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{d.label}</div>
                            <div className="text-xs text-muted-foreground">{fmtDate(d.issue_date)}</div>
                          </td>
                          <td className={cn("px-3 py-2", overdue && "font-semibold text-danger")}>
                            {fmtDate(d.due_date)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(d.open_ars)}</td>
                          <td className="px-3 py-2">
                            <input
                              aria-label={`Imputar a ${d.label}`}
                              inputMode="decimal"
                              className={cn(inputCls, "h-9 text-right", over && "border-danger")}
                              value={alloc[d.invoice_id] ?? ""}
                              onChange={(e) => setAlloc((p) => ({ ...p, [d.invoice_id]: e.target.value }))}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        <section className="space-y-2">
          <SectionTitle
            action={
              <Button size="sm" variant="secondary" onClick={() => setLines((p) => [...p, newLine("efectivo")])}>
                <Plus size={14} /> Agregar medio
              </Button>
            }
          >
            Medios de pago
          </SectionTitle>
          {!treasury && (
            <Callout tone="neutral" icon={InfoIcon}>
              Con Tesorería en tu plan podés pagar desde una cuenta bancaria y con cheques o e-cheqs.
            </Callout>
          )}
          {lines.map((l) => {
            const isCash = l.method === "efectivo";
            const isOwnCheque = l.method === "cheque_propio" || l.method === "echeq";
            const isThirdCheque = l.method === "cheque_tercero";
            const showAccount = treasury && (l.method === "transferencia" || l.method === "deposito" || isOwnCheque);
            return (
              <div key={l.key} className="space-y-2 rounded-md bg-muted/50 p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
                  <select
                    aria-label="Medio"
                    className={cn(selectCls, "h-10")}
                    value={l.method}
                    onChange={(e) => setLine(l.key, { method: e.target.value as PaymentLineMethod, chequeId: "" })}
                  >
                    {methods.map((k) => (
                      <option key={k} value={k} className="bg-popover text-popover-foreground">
                        {PAYMENT_LINE_METHOD_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Importe"
                    inputMode="decimal"
                    placeholder="Importe"
                    className={cn(inputCls, "text-right font-semibold")}
                    value={l.amount}
                    disabled={isThirdCheque && Boolean(l.chequeId)}
                    onChange={(e) => setLine(l.key, { amount: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Quitar medio"
                    className="h-10"
                    disabled={lines.length === 1}
                    onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                {isCash && (
                  <p className={cn("text-xs", shift ? "text-muted-foreground" : "text-danger")}>
                    {shift
                      ? "Sale de tu caja abierta como retiro (con el PIN de supervisor si tu negocio lo pide)."
                      : "Abrí tu caja para pagar en efectivo: sólo podés sacar plata de tu propio turno."}
                  </p>
                )}
                {showAccount && (
                  <select
                    aria-label="Cuenta"
                    className={cn(selectCls, "h-10")}
                    value={l.accountId}
                    onChange={(e) => setLine(l.key, { accountId: e.target.value })}
                  >
                    <option value="" className="bg-popover text-popover-foreground">
                      {isOwnCheque ? "Cuenta bancaria del cheque" : "Sin cuenta (sólo la referencia)"}
                    </option>
                    {(isOwnCheque ? bankAccounts : activeAccounts).map((a) => (
                      <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {isOwnCheque && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      aria-label="Número de cheque"
                      placeholder="N° de cheque"
                      className={inputCls}
                      maxLength={30}
                      value={l.chequeNumber}
                      onChange={(e) => setLine(l.key, { chequeNumber: e.target.value })}
                    />
                    <input
                      aria-label="Fecha de pago"
                      type="date"
                      className={inputCls}
                      value={l.chequeDate}
                      onChange={(e) => setLine(l.key, { chequeDate: e.target.value })}
                    />
                    <input
                      aria-label="Banco"
                      placeholder="Banco (opcional)"
                      className={inputCls}
                      maxLength={80}
                      value={l.chequeBank}
                      onChange={(e) => setLine(l.key, { chequeBank: e.target.value })}
                    />
                  </div>
                )}
                {isThirdCheque && (
                  <select
                    aria-label="Cheque en cartera"
                    className={cn(selectCls, "h-10")}
                    value={l.chequeId}
                    onChange={(e) => {
                      const c = wallet.find((x) => x.id === e.target.value);
                      setLine(l.key, { chequeId: e.target.value, amount: c ? fmtInput(c.amount) : l.amount });
                    }}
                  >
                    <option value="" className="bg-popover text-popover-foreground">
                      {wallet.length ? "Elegí un cheque en cartera" : "No hay cheques en cartera"}
                    </option>
                    {wallet
                      .filter((c) => c.id === l.chequeId || !lines.some((x) => x.chequeId === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id} className="bg-popover text-popover-foreground">
                          N° {c.number} · {c.bank_name ?? "Banco"} · {formatCurrency(c.amount)} · paga {fmtDate(c.payment_date)}
                        </option>
                      ))}
                  </select>
                )}
                {!isCash && !isOwnCheque && !isThirdCheque && (
                  <input
                    aria-label="Referencia"
                    placeholder="Referencia (n° de operación o comprobante)"
                    className={inputCls}
                    maxLength={120}
                    value={l.reference}
                    onChange={(e) => setLine(l.key, { reference: e.target.value })}
                  />
                )}
              </div>
            );
          })}
        </section>

        <section className="space-y-2">
          <SectionTitle
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setWh((p) => [...p, { key: seq++, kind: "iibb", certificate: "", amount: "" }])}
              >
                <Plus size={14} /> Agregar retención
              </Button>
            }
          >
            Retenciones practicadas
          </SectionTitle>
          {wh.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Si sos agente de retención, cargá IVA, Ganancias o IIBB con su n° de certificado. El cálculo automático
              llega con Retenciones (H106).
            </p>
          )}
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
                {WH_KINDS.map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {WITHHOLDING_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                aria-label="Certificado"
                placeholder="Certificado n°"
                maxLength={40}
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
        </section>

        <FormField label="Notas (opcional)">
          <textarea className={textareaCls} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {(supplier || totals.total > 0) && <ErrorList errors={errors} />}
      </div>
    </Modal>
  );
}
