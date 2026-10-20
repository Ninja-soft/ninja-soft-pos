"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { allocatePayment, type OpenItem } from "@/lib/account/allocation";
import {
  RECEIPT_METHOD_LABEL,
  fillReceiptAmounts,
  needsMultiReceipt,
  receiptLineError,
  receiptTotals,
  type ReceiptLine,
} from "@/lib/account/receipt";
import {
  accountErrorMessage,
  newIdempotencyKey,
  type CollectMethod,
  type CollectResult,
  type OpenItemRow,
} from "@/modules/customers/account";
import { useAccountMutations, useAccountStatement, useReceiptTolerance } from "@/modules/customers/hooks";
import { useTransferAccounts } from "@/modules/payments/transfer";
import { useFeature } from "@/modules/saas/gating";
import { KIND_LABEL, METHOD_LABEL, fmtDate } from "./shared";
import { ReceiptLinesEditor, newDraftLine, type DraftLine } from "./ReceiptLinesEditor";

function itemLabel(it: Pick<OpenItemRow, "kind" | "reason" | "installment_no" | "installments">): string {
  if (it.kind === "interest") return "Punitorio";
  if (it.kind === "adjust_debit") return it.reason || KIND_LABEL.adjust_debit;
  return it.reason || KIND_LABEL.charge;
}

// Cobro de deuda de cuenta corriente: monto, medios (H160: varios, con
// cheques, e-cheqs y retenciones, más el ajuste por redondeo), imputación
// (FIFO por defecto o elegida) y nota. Impacta en la caja abierta (efectivo al
// arqueo, otros medios al Z) y genera un recibo correlativo. Idempotente.
export function CollectModal({
  open,
  onOpenChange,
  customerId,
  customerName,
  presetAmount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customerId: string | null;
  customerName: string;
  presetAmount?: number;
}) {
  const { toast } = useToast();
  const { data: st, isLoading } = useAccountStatement(open ? customerId : null);
  const { collect, collectMulti } = useAccountMutations();
  const [amount, setAmount] = useState("");
  const [drafts, setDrafts] = useState<DraftLine[]>(() => [newDraftLine()]);
  const allowCheques = useFeature("tesoreria") === true;
  const allowRetentions = useFeature("percepciones_retenciones") === true;
  const { data: tolerance = 10 } = useReceiptTolerance(open);
  const [note, setNote] = useState("");
  const [choose, setChoose] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [key, setKey] = useState(newIdempotencyKey);
  const [result, setResult] = useState<CollectResult | null>(null);
  // ADR-162: a qué cuenta te transfirieron (si está vinculada a un banco de
  // Tesorería, el cobro suma ahí y en su cuenta contable).
  const { data: transferAccounts = [] } = useTransferAccounts();
  const activeTransfers = transferAccounts.filter((t) => t.is_active && !t.deleted_at);

  useEffect(() => {
    if (open) {
      setAmount(presetAmount && presetAmount > 0 ? String(presetAmount) : "");
      setDrafts([newDraftLine()]);
      setNote("");
      setChoose(false);
      setChosen({});
      setKey(newIdempotencyKey());
      setResult(null);
    }
  }, [open, presetAmount]);

  const items = useMemo(() => st?.open_items ?? [], [st]);
  const amt = Math.round((Number(amount) || 0) * 100) / 100;

  const preview = useMemo(() => {
    if (!(amt > 0)) return { error: null as string | null, allocations: [], unapplied: 0 };
    const list: OpenItem[] = items.map((i) => ({
      id: i.id,
      kind: i.kind === "interest" ? "interest" : "charge",
      due_date: i.due_date,
      created_at: i.created_at,
      open: Number(i.open),
    }));
    const picks = choose
      ? Object.entries(chosen)
          .map(([id, v]) => ({ id, amount: Number(v) || 0 }))
          .filter((x) => x.amount > 0)
      : null;
    try {
      const r = allocatePayment(list, amt, picks);
      return { error: null, ...r };
    } catch (e) {
      return { error: accountErrorMessage(e), allocations: [], unapplied: 0 };
    }
  }, [amt, items, choose, chosen]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // Medios del recibo: la primera línea sin monto toma lo que falta.
  const lineAmounts = useMemo(
    () => fillReceiptAmounts(drafts.map((d) => (d.amount.trim() === "" ? null : Number(d.amount) || 0)), amt),
    [drafts, amt],
  );
  const receiptLines: ReceiptLine[] = useMemo(
    () =>
      drafts.map((d, i): ReceiptLine =>
        d.kind === "retention"
          ? {
              kind: "retention",
              tax: d.tax,
              amount: lineAmounts[i] ?? 0,
              jurisdiction: d.jurisdiction || null,
              certificate: d.certificate || null,
            }
          : {
              kind: "payment",
              method: d.method,
              amount: lineAmounts[i] ?? 0,
              transfer_account_id: d.method === "transfer" ? d.transferAccount || null : null,
              cheque:
                d.method === "cheque" || d.method === "echeq"
                  ? {
                      number: d.chequeNumber,
                      bank_name: d.chequeBank || null,
                      payment_date: d.chequePaymentDate,
                      drawer_name: d.chequeDrawer || null,
                      drawer_cuit: d.chequeCuit || null,
                    }
                  : null,
            },
      ),
    [drafts, lineAmounts],
  );
  const usedLines = receiptLines.filter((l) => l.amount > 0);
  const totals = receiptTotals(usedLines, amt, tolerance);
  const lineError = usedLines.map(receiptLineError).find(Boolean) ?? null;

  async function submit() {
    try {
      const picks = choose
        ? Object.entries(chosen)
            .map(([id, v]) => ({ id, amount: Math.round((Number(v) || 0) * 100) / 100 }))
            .filter((x) => x.amount > 0)
        : null;
      const single = usedLines[0];
      const r =
        !needsMultiReceipt(usedLines, totals) && single && single.kind === "payment"
          ? await collect.mutateAsync({
              customerId: customerId!,
              amount: amt,
              method: single.method as CollectMethod,
              allocations: picks,
              idempotencyKey: key,
              note,
              transferAccountId: single.method === "transfer" ? single.transfer_account_id || null : null,
            })
          : await collectMulti.mutateAsync({
              customerId: customerId!,
              lines: usedLines,
              total: amt,
              allocations: picks,
              idempotencyKey: key,
              note,
            });
      setResult(r);
      toast({ title: `Cobro registrado · recibo #${r.receipt_no}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo registrar el cobro", description: accountErrorMessage(e), variant: "error" });
    }
  }

  const total = Number(st?.balance ?? 0);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Cobrar · ${customerName}`} className="max-w-lg">
      {result ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-emerald-400/10 p-4">
            <CheckCircle2 className="mt-0.5 shrink-0 text-success" size={20} />
            <div className="text-sm">
              <p className="font-semibold text-foreground">
                Recibo #{result.receipt_no} · {formatCurrency(Number(result.amount))}
              </p>
              <p className="text-muted-foreground">
                {result.lines && result.lines.length > 1
                  ? `${result.lines.filter((l) => l.kind === "payment").length} medios`
                  : (METHOD_LABEL[result.method] ?? RECEIPT_METHOD_LABEL[result.method as "cash"] ?? result.method)}{" "}
                · saldo actual{" "}
                <span className="font-semibold text-foreground">{formatCurrency(Number(result.balance))}</span>
              </p>
            </div>
          </div>
          {result.lines && result.lines.length > 1 && (
            <ul className="space-y-1 text-sm">
              {result.lines.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5">
                  <span className="truncate">
                    {RECEIPT_METHOD_LABEL[(l.method ?? "other") as "cash"] ?? l.method}
                    {l.cheque_id ? " · en cartera" : ""}
                    {l.suffered_id ? " · en retenciones sufridas" : ""}
                  </span>
                  <span className="tabular-nums">{formatCurrency(Number(l.amount))}</span>
                </li>
              ))}
            </ul>
          )}
          {result.allocations.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Imputado a</p>
              <ul className="space-y-1 text-sm">
                {result.allocations.map((a, i) => (
                  <li key={`${a.charge_id}-${i}`} className="flex justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5">
                    <span className="truncate">
                      {a.kind === "interest" ? "Punitorio" : a.reason ?? "Cargo"}
                      {a.due_date ? ` · vence ${fmtDate(a.due_date)}` : ""}
                    </span>
                    <span className="tabular-nums">{formatCurrency(Number(a.amount))}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Number(result.unapplied) > 0 && (
            <p className="text-sm text-muted-foreground">
              Quedan {formatCurrency(Number(result.unapplied))} a favor del cliente.
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={() => onOpenChange(false)}>Listo</Button>
          </div>
        </div>
      ) : isLoading || !st ? (
        <SpinnerBlock />
      ) : (
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <Input
              label="Monto a cobrar"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={formatCurrency(total)}
              className="flex-1"
            />
            {total > 0 && (
              <Button variant="secondary" type="button" onClick={() => setAmount(String(total))}>
                Todo
              </Button>
            )}
          </div>

          <ReceiptLinesEditor
            lines={drafts}
            amounts={lineAmounts}
            onChange={setDrafts}
            allowCheques={allowCheques}
            allowRetentions={allowRetentions}
            transferAccounts={activeTransfers}
          />

          {amt > 0 && usedLines.length > 0 && (
            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Medios</span>
                <span className="tabular-nums">{formatCurrency(totals.linesTotal)}</span>
              </div>
              {totals.diff !== 0 &&
                (totals.balanced ? (
                  <p className="mt-1 text-muted-foreground">
                    {totals.diff > 0 ? "Faltan" : "Sobran"} {formatCurrency(Math.abs(totals.diff))}: se registra como
                    redondeo.
                  </p>
                ) : (
                  <p className="mt-1 text-danger">
                    {totals.diff > 0 ? "Faltan" : "Sobran"} {formatCurrency(Math.abs(totals.diff))} para llegar a{" "}
                    {formatCurrency(amt)} (el redondeo admite hasta {formatCurrency(tolerance)}).
                  </p>
                ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-2">
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Elegir qué cancelar</span>
                <Switch checked={choose} onCheckedChange={setChoose} label="Elegir qué cancelar" />
              </label>
              {!choose && (
                <p className="text-xs text-muted-foreground">
                  Por defecto se cancelan primero los punitorios y después los cargos que vencen antes.
                </p>
              )}
              {choose && (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {items.map((it) => {
                    const picked = chosen[it.id] !== undefined;
                    return (
                      <li
                        key={it.id}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                          picked ? "bg-ninja-flame/10" : "bg-muted/30",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={(e) =>
                            setChosen((p) => {
                              const n = { ...p };
                              if (e.target.checked) n[it.id] = String(it.open);
                              else delete n[it.id];
                              return n;
                            })
                          }
                          className="h-4 w-4 accent-ninja-flame"
                          aria-label={`Cancelar ${itemLabel(it)}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{itemLabel(it)}</span>
                          <span className={cn("block text-xs", it.days_overdue > 0 ? "text-danger" : "text-muted-foreground")}>
                            {it.due_date ? `Vence ${fmtDate(it.due_date)}` : ""}
                            {it.days_overdue > 0 ? ` · ${it.days_overdue} días vencido` : ""}
                          </span>
                        </span>
                        {picked ? (
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max={it.open}
                            value={chosen[it.id]}
                            onChange={(e) => setChosen((p) => ({ ...p, [it.id]: e.target.value }))}
                            className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm outline-none focus:border-ninja-flameSoft"
                            aria-label="Monto a imputar"
                          />
                        ) : (
                          <span className="tabular-nums text-muted-foreground">{formatCurrency(Number(it.open))}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <Input label="Nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />

          {amt > 0 && (
            <div className="rounded-lg bg-muted/40 p-3 text-sm">
              {preview.error ? (
                <p className="text-danger">{preview.error}</p>
              ) : (
                <>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Se imputa a</p>
                  <ul className="space-y-0.5">
                    {preview.allocations.map((a) => {
                      const it = byId.get(a.id);
                      return (
                        <li key={a.id} className="flex justify-between gap-2">
                          <span className="truncate">
                            {it ? itemLabel(it) : "Cargo"}
                            {it?.due_date ? ` · ${fmtDate(it.due_date)}` : ""}
                          </span>
                          <span className="tabular-nums">{formatCurrency(a.amount)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {preview.unapplied > 0 && (
                    <p className="mt-1 text-muted-foreground">
                      Quedan {formatCurrency(preview.unapplied)} a favor del cliente.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              loading={collect.isPending || collectMulti.isPending}
              disabled={!(amt > 0) || Boolean(preview.error) || !totals.balanced || Boolean(lineError)}
              onClick={submit}
            >
              Registrar cobro
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
