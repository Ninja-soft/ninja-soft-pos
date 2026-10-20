"use client";

// Comprobante de proveedor (F18 · H101, ADR-050): factura, nota de débito o
// de crédito con neto por alícuota, IVA, exento, no gravado, percepciones y
// otros tributos, vinculado a las recepciones que factura. El servidor valida
// los mismos totales (supplier_invoice_save). H167 (ADR-178): CAE del
// proveedor, renglones de artículos (reciben stock) y de gasto (con cuenta) y
// precarga desde la lectura con IA de la bandeja (nunca graba sola).

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import {
  INVOICE_KIND_LABEL,
  INVOICE_LETTERS,
  OTHER_TAX_LABEL,
  VAT_RATES,
  defaultDueDate,
  invoiceTotals,
  letterDiscriminatesVat,
  allowedLetters,
  parseInvoiceNumber,
  suggestedLetter,
  validateInvoice,
  vatFor,
  type InvoiceKind,
  type InvoiceLetter,
  type OtherTaxKind,
} from "@/lib/purchases/invoices";
import { formatReceiptNumber, purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES, PROVINCES } from "@/lib/purchases/suppliers";
import type { InvoiceRow, InvoiceSaveInput } from "@/modules/purchases/api";
import {
  usePurchaseMutations,
  usePurchasesAccess,
  useReceipts,
  useSuppliers,
} from "@/modules/purchases/hooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { useCurrentStoreId } from "@/modules/stock/hooks";
import { normalizeCuit, formatCuit } from "@/lib/purchases/suppliers";
import { validateLines } from "@/lib/purchases/invoiceLines";
import { useInvoiceLines, usePurchasesProMutations } from "@/modules/purchases/pro";
import type { OcrInvoice } from "@/supabase/functions/_shared/purchaseInvoiceOcr";
import { InvoiceLinesSection, newExpenseLine, toDraft, type LineState } from "./InvoiceLinesSection";
import { SupplierFormModal } from "./SupplierFormModal";
import { fmtDate, inputCls, parseNum, selectCls, textareaCls, today } from "./shared";

interface VatRow {
  key: number;
  rate: number;
  net: string;
  vat: string;
  vatTouched: boolean;
}

interface TaxRow {
  key: number;
  kind: OtherTaxKind;
  jurisdiction: string;
  description: string;
  amount: string;
}

const s = (n: number | null | undefined) => (n == null || n === 0 ? "" : String(n).replace(".", ","));
let seq = 1;
const nextKey = () => seq++;

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function InvoiceFormModal({
  open,
  onOpenChange,
  invoice,
  supplierId,
  receiptIds,
  orderId,
  prefill,
  inboxId,
  onSaved,
  prefillWarnings,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice?: InvoiceRow | null;
  supplierId?: string | null;
  receiptIds?: string[];
  orderId?: string | null;
  /** H167: datos leídos con IA para precargar (se revisan antes de guardar). */
  prefill?: OcrInvoice | null;
  /** H167: archivo de la bandeja que se marca como procesado al guardar. */
  inboxId?: string | null;
  onSaved?: (id: string) => void;
  /** Avisos de la lectura con IA (lo que conviene revisar). */
  prefillWarnings?: string[];
}) {
  const { toast } = useToast();
  const access = usePurchasesAccess();
  const m = usePurchaseMutations();
  const pro = usePurchasesProMutations();
  const currentStoreId = useCurrentStoreId();
  const { data: suppliers = [] } = useSuppliers({ includeArchived: Boolean(invoice) }, open);
  // Condición de IVA del negocio: define qué letras puede recibir (el servidor lo exige).
  const buyerIva = useTaxSettings(open).data?.iva_condition ?? null;

  const [supplier, setSupplier] = useState("");
  const [kind, setKind] = useState<InvoiceKind>("invoice");
  const [letter, setLetter] = useState<InvoiceLetter>("A");
  const [pos, setPos] = useState("");
  const [number, setNumber] = useState("");
  const [issue, setIssue] = useState(today());
  const [due, setDue] = useState("");
  const [dueTouched, setDueTouched] = useState(false);
  const [currency, setCurrency] = useState("ARS");
  const [fx, setFx] = useState("1");
  const [vatRows, setVatRows] = useState<VatRow[]>([]);
  const [plainAmount, setPlainAmount] = useState("");
  const [exempt, setExempt] = useState("");
  const [nonTaxed, setNonTaxed] = useState("");
  const [taxes, setTaxes] = useState<TaxRow[]>([]);
  const [total, setTotal] = useState("");
  const [totalTouched, setTotalTouched] = useState(false);
  const [linked, setLinked] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [cae, setCae] = useState("");
  const [caeDue, setCaeDue] = useState("");
  const [lines, setLinesState] = useState<LineState[]>([]);
  const [linesTouched, setLinesTouched] = useState(false);
  const [storeId, setStoreId] = useState("");
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const setLines = (fn: (p: LineState[]) => LineState[]) => {
    setLinesTouched(true);
    setLinesState(fn);
  };
  const savedLinesQ = useInvoiceLines(open ? invoice?.id : null);
  const savedLines = savedLinesQ.data ?? [];

  const sup = suppliers.find((x) => x.id === supplier) ?? null;
  const editing = Boolean(invoice?.id);

  useEffect(() => {
    if (!open) return;
    if (invoice) {
      setSupplier(invoice.supplier_id);
      setKind(invoice.kind);
      setLetter(invoice.letter);
      setPos(String(invoice.point_of_sale));
      setNumber(String(invoice.number));
      setIssue(invoice.issue_date);
      setDue(invoice.due_date ?? "");
      setDueTouched(true);
      setCurrency(invoice.currency);
      setFx(String(invoice.fx_rate).replace(".", ","));
      const discriminates = letterDiscriminatesVat(invoice.letter);
      setVatRows(
        discriminates
          ? invoice.vat_lines.map((l) => ({
              key: nextKey(),
              rate: Number(l.rate),
              net: s(Number(l.net)),
              vat: s(Number(l.vat)),
              vatTouched: true,
            }))
          : [{ key: nextKey(), rate: 21, net: "", vat: "", vatTouched: false }],
      );
      setPlainAmount(
        discriminates ? "" : s(invoice.vat_lines.reduce((t, l) => t + Number(l.net), 0)),
      );
      setExempt(s(invoice.exempt_amount));
      setNonTaxed(s(invoice.non_taxed_amount));
      setTaxes(
        invoice.other_taxes.map((t) => ({
          key: nextKey(),
          kind: t.kind,
          jurisdiction: t.jurisdiction ?? "",
          description: t.description ?? "",
          amount: s(Number(t.amount)),
        })),
      );
      setTotal(String(invoice.total).replace(".", ","));
      setTotalTouched(true);
      setNotes(invoice.notes ?? "");
      setCae(invoice.cae ?? "");
      setCaeDue(invoice.cae_due ?? "");
    } else {
      setSupplier(supplierId ?? "");
      setKind("invoice");
      setLetter("A");
      setPos("");
      setNumber("");
      setIssue(today());
      setDue("");
      setDueTouched(false);
      setCurrency("ARS");
      setFx("1");
      setVatRows([{ key: nextKey(), rate: 21, net: "", vat: "", vatTouched: false }]);
      setPlainAmount("");
      setExempt("");
      setNonTaxed("");
      setTaxes([]);
      setTotal("");
      setTotalTouched(false);
      setNotes("");
      setCae("");
      setCaeDue("");
      if (prefill) applyPrefill(prefill);
    }
    setLinesState([]);
    setLinesTouched(false);
    setStoreId(currentStoreId ?? "");
    setLinked(receiptIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.id, prefill]);

  // Gastos ya guardados (edición): se editan acá; los artículos quedan fijos.
  useEffect(() => {
    if (!open || !invoice?.id || linesTouched) return;
    setLinesState(
      savedLines
        .filter((l) => l.kind === "expense")
        .map((l) => ({
          ...newExpenseLine(l.description ?? "", s(l.net), l.vat_rate),
          accountId: l.account_id ?? "",
        })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice?.id, savedLinesQ.dataUpdatedAt]);

  // Precarga leída con IA: el proveedor se busca por CUIT.
  const prefillCuit = normalizeCuit(prefill?.supplier_cuit);
  const prefillSupplier = prefillCuit ? (suppliers.find((x) => normalizeCuit(x.cuit) === prefillCuit) ?? null) : null;
  useEffect(() => {
    if (open && !invoice && prefillSupplier && !supplier) setSupplier(prefillSupplier.id);
  }, [open, invoice, prefillSupplier, supplier]);

  function applyPrefill(d: OcrInvoice) {
    setKind(d.kind);
    if (d.letter) setLetter(d.letter as InvoiceLetter);
    if (d.point_of_sale) setPos(String(d.point_of_sale));
    if (d.number) setNumber(String(d.number));
    if (d.issue_date) setIssue(d.issue_date);
    if (d.due_date) {
      setDue(d.due_date);
      setDueTouched(true);
    }
    setCurrency(d.currency || "ARS");
    const disc = d.letter ? letterDiscriminatesVat(d.letter as InvoiceLetter) : true;
    if (disc) {
      setVatRows(
        d.vat_lines.length > 0
          ? d.vat_lines.map((l) => ({ key: nextKey(), rate: l.rate, net: s(l.net), vat: s(l.vat), vatTouched: true }))
          : [{ key: nextKey(), rate: 21, net: "", vat: "", vatTouched: false }],
      );
    } else {
      setPlainAmount(s(d.vat_lines.reduce((t, l) => t + l.net + l.vat, 0)));
    }
    setExempt(s(d.exempt_amount));
    setNonTaxed(s(d.non_taxed_amount));
    setTaxes(
      d.other_taxes.map((t) => ({
        key: nextKey(),
        kind: t.kind as OtherTaxKind,
        jurisdiction: t.jurisdiction ?? "",
        description: t.description ?? "",
        amount: s(t.amount),
      })),
    );
    if (d.total) {
      setTotal(s(d.total));
      setTotalTouched(true);
    }
    setCae(d.cae ?? "");
    setCaeDue(d.cae_due ?? "");
  }

  // Al elegir proveedor: letra sugerida, moneda y vencimiento por plazo.
  useEffect(() => {
    if (!open || editing || !sup) return;
    const l = suggestedLetter(sup.iva_condition, buyerIva);
    if (l) setLetter(l);
    if (access.pro) setCurrency(sup.currency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sup?.id, open, buyerIva]);

  useEffect(() => {
    if (!dueTouched && issue) setDue(defaultDueDate(issue, sup?.payment_terms_days ?? 0));
  }, [issue, sup?.payment_terms_days, dueTouched]);

  const { data: receipts = [] } = useReceipts({ supplierId: supplier || null }, open && Boolean(supplier));
  const linkable = useMemo(
    () => receipts.filter((r) => !r.invoice_id || r.invoice_id === invoice?.id || linked.includes(r.id)),
    [receipts, invoice?.id, linked],
  );

  const discriminates = letterDiscriminatesVat(letter);
  const letterOptions = sup ? allowedLetters(sup.iva_condition, buyerIva) : null;
  const draft = {
    kind,
    letter,
    point_of_sale: parseNum(pos),
    number: parseNum(number),
    issue_date: issue,
    due_date: due || null,
    vat_lines: discriminates
      ? vatRows
          .filter((r) => parseNum(r.net) > 0 || parseNum(r.vat) > 0)
          .map((r) => ({ rate: r.rate, net: parseNum(r.net), vat: parseNum(r.vat) }))
      : parseNum(plainAmount) > 0
        ? [{ rate: 0, net: parseNum(plainAmount), vat: 0 }]
        : [],
    exempt_amount: parseNum(exempt),
    non_taxed_amount: parseNum(nonTaxed),
    other_taxes: taxes
      .filter((t) => parseNum(t.amount) > 0)
      .map((t) => ({
        kind: t.kind,
        description: t.description.trim() || OTHER_TAX_LABEL[t.kind],
        jurisdiction: t.kind === "percepcion_iibb" ? t.jurisdiction || null : null,
        amount: parseNum(t.amount),
      })),
    total: 0,
  };
  const computed = invoiceTotals(draft);
  const totalValue = totalTouched ? parseNum(total) : computed.total;
  const validation = validateInvoice({ ...draft, total: totalValue });
  const foreign = currency !== "ARS";
  const lineDrafts = lines.map(toDraft);
  const caeDigits = cae.replace(/\D/g, "");
  const errors = [
    ...validation.errors,
    ...(!supplier ? ["Elegí el proveedor."] : []),
    ...(foreign && !(parseNum(fx) > 0) ? ["Cargá el tipo de cambio."] : []),
    ...(caeDigits && caeDigits.length !== 14 ? ["El CAE tiene 14 números."] : []),
    ...validateLines(lineDrafts, {
      invoiceNet: computed.net + draft.exempt_amount + draft.non_taxed_amount,
      hasStore: Boolean(storeId),
      editing,
    }),
  ];

  function patchVat(key: number, p: Partial<VatRow>) {
    setVatRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...p };
        if (!next.vatTouched && (p.net !== undefined || p.rate !== undefined)) {
          next.vat = s(vatFor(parseNum(next.net), next.rate));
        }
        return next;
      }),
    );
  }

  function onNumberPaste(text: string) {
    const parsed = parseInvoiceNumber(text);
    if (parsed) {
      setPos(String(parsed.pos));
      setNumber(String(parsed.number));
      return true;
    }
    return false;
  }

  async function save() {
    if (errors.length > 0) return;
    const input: InvoiceSaveInput = {
      supplier_id: supplier,
      kind,
      letter,
      point_of_sale: draft.point_of_sale,
      number: draft.number,
      issue_date: issue,
      due_date: due || null,
      currency,
      fx_rate: foreign ? parseNum(fx) : 1,
      vat_lines: draft.vat_lines,
      exempt_amount: draft.exempt_amount,
      non_taxed_amount: draft.non_taxed_amount,
      other_taxes: draft.other_taxes,
      total: totalValue,
      order_id: invoice?.order_id ?? orderId ?? null,
      notes: notes.trim() || null,
    };
    const hasItems = lineDrafts.some((l) => l.kind === "item");
    try {
      const id = await pro.saveInvoiceFull.mutateAsync({
        id: invoice?.id ?? null,
        input: {
          ...input,
          cae: caeDigits || null,
          cae_due: caeDue || null,
          source: prefill ? "ia" : "manual",
        },
        receiptIds: linked,
        lines: editing ? (linesTouched ? lineDrafts : null) : lineDrafts.length > 0 ? lineDrafts : null,
        storeId: hasItems ? storeId : null,
      });
      if (inboxId) {
        await pro.inboxSetStatus.mutateAsync({ id: inboxId, status: "processed", invoiceId: id });
      }
      toast({
        title: editing
          ? "Comprobante actualizado"
          : hasItems
            ? "Comprobante cargado: el stock ya está actualizado"
            : "Comprobante cargado",
        variant: "success",
      });
      onSaved?.(id);
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const fixedSupplier = Boolean(supplierId) && !editing;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Editar comprobante" : "Cargar comprobante de proveedor"}
      className="sm:max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            Total: <b className="tabular-nums">{formatCurrency(totalValue)}</b>
            {foreign && <span className="text-muted-foreground"> {currency}</span>}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} loading={pro.saveInvoiceFull.isPending} disabled={errors.length > 0}>
              {editing ? "Guardar" : "Cargar comprobante"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {prefill && (
          <Callout tone="info" title="Precargado con IA: revisá todo antes de guardar">
            {prefillWarnings && prefillWarnings.length > 0 ? (
              <ul className="list-disc pl-4 text-sm">
                {prefillWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : (
              "Compará los datos con el papel: la lectura puede equivocarse."
            )}
          </Callout>
        )}
        <section className="grid gap-3 sm:grid-cols-3">
          <Field label="Proveedor" className="sm:col-span-3">
            <select
              className={selectCls}
              value={supplier}
              disabled={fixedSupplier}
              onChange={(e) => {
                setSupplier(e.target.value);
                setLinked([]);
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
            {prefill && prefillCuit && !prefillSupplier && !supplier && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  El proveedor {prefill.supplier_name ?? ""} (CUIT {formatCuit(prefillCuit)}) no está cargado.
                </span>
                <Button size="sm" variant="secondary" onClick={() => setNewSupplierOpen(true)}>
                  Crear proveedor
                </Button>
              </div>
            )}
          </Field>
          <Field label="Tipo">
            <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as InvoiceKind)}>
              {(Object.keys(INVOICE_KIND_LABEL) as InvoiceKind[]).map((k) => (
                <option key={k} value={k} className="bg-popover text-popover-foreground">
                  {INVOICE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Letra">
            <select className={selectCls} value={letter} onChange={(e) => setLetter(e.target.value as InvoiceLetter)}>
              {INVOICE_LETTERS.map((l) => (
                <option key={l} value={l} className="bg-popover text-popover-foreground">
                  {l}
                </option>
              ))}
            </select>
            {letterOptions && !letterOptions.includes(letter) && (
              <p className="mt-1 text-xs text-danger">
                Con estas condiciones de IVA corresponde {letterOptions.join(" o ")}.
              </p>
            )}
          </Field>
          <div className="grid grid-cols-[5rem_1fr] gap-2">
            <Field label="Pto. venta">
              <input
                inputMode="numeric"
                className={cn(inputCls, "h-11")}
                value={pos}
                placeholder="0003"
                onChange={(e) => {
                  if (!onNumberPaste(e.target.value)) setPos(e.target.value.replace(/\D/g, "").slice(0, 5));
                }}
              />
            </Field>
            <Field label="Número">
              <input
                inputMode="numeric"
                className={cn(inputCls, "h-11")}
                value={number}
                placeholder="00001234"
                onPaste={(e) => {
                  if (onNumberPaste(e.clipboardData.getData("text"))) e.preventDefault();
                }}
                onChange={(e) => {
                  if (!onNumberPaste(e.target.value)) setNumber(e.target.value.replace(/\D/g, "").slice(0, 8));
                }}
              />
            </Field>
          </div>
          <Field label="Fecha">
            <input type="date" className={cn(inputCls, "h-11")} value={issue} onChange={(e) => setIssue(e.target.value)} />
          </Field>
          <Field label="Vencimiento">
            <input
              type="date"
              className={cn(inputCls, "h-11")}
              value={due}
              onChange={(e) => {
                setDue(e.target.value);
                setDueTouched(true);
              }}
            />
          </Field>
          <Field label="CAE o CAI (opcional)">
            <input
              inputMode="numeric"
              className={cn(inputCls, "h-11")}
              value={cae}
              placeholder="14 números"
              onChange={(e) => setCae(e.target.value.replace(/\D/g, "").slice(0, 14))}
            />
          </Field>
          <Field label="Vencimiento del CAE (opcional)">
            <input type="date" className={cn(inputCls, "h-11")} value={caeDue} onChange={(e) => setCaeDue(e.target.value)} />
          </Field>
          {(access.pro || foreign) && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Moneda">
                <select className={selectCls} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-popover text-popover-foreground">
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              {foreign && (
                <Field label="Tipo de cambio">
                  <input inputMode="decimal" className={cn(inputCls, "h-11")} value={fx} onChange={(e) => setFx(e.target.value)} />
                </Field>
              )}
            </div>
          )}
        </section>

        {/* Importes */}
        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {discriminates ? "Neto gravado e IVA por alícuota" : `Importe (los comprobantes ${letter} no discriminan IVA)`}
          </h4>
          {discriminates ? (
            <>
              {vatRows.map((r) => (
                <div key={r.key} className="grid grid-cols-[6rem_1fr_1fr_auto] gap-2">
                  <select
                    aria-label="Alícuota"
                    className={cn(selectCls, "h-10 px-2")}
                    value={r.rate}
                    onChange={(e) => patchVat(r.key, { rate: Number(e.target.value) })}
                  >
                    {VAT_RATES.map((v) => (
                      <option key={v} value={v} className="bg-popover text-popover-foreground">
                        {String(v).replace(".", ",")} %
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Neto"
                    placeholder="Neto"
                    inputMode="decimal"
                    className={cn(inputCls, "text-right")}
                    value={r.net}
                    onChange={(e) => patchVat(r.key, { net: e.target.value })}
                  />
                  <input
                    aria-label="IVA"
                    placeholder="IVA"
                    inputMode="decimal"
                    className={cn(inputCls, "text-right")}
                    value={r.vat}
                    onChange={(e) => patchVat(r.key, { vat: e.target.value, vatTouched: true })}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Quitar alícuota"
                    disabled={vatRows.length === 1}
                    onClick={() => setVatRows((p) => p.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setVatRows((p) => [...p, { key: nextKey(), rate: 10.5, net: "", vat: "", vatTouched: false }])
                }
              >
                <Plus size={14} /> Otra alícuota
              </Button>
            </>
          ) : (
            <input
              aria-label="Importe"
              inputMode="decimal"
              className={cn(inputCls, "max-w-xs text-right")}
              value={plainAmount}
              onChange={(e) => setPlainAmount(e.target.value)}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Exento">
              <input inputMode="decimal" className={cn(inputCls, "text-right")} value={exempt} onChange={(e) => setExempt(e.target.value)} />
            </Field>
            <Field label="No gravado">
              <input inputMode="decimal" className={cn(inputCls, "text-right")} value={nonTaxed} onChange={(e) => setNonTaxed(e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Percepciones y otros tributos
          </h4>
          {taxes.map((t) => (
            <div key={t.key} className="grid grid-cols-2 gap-2 max-sm:[&>*:last-child]:justify-self-start sm:grid-cols-[1fr_1fr_8rem_auto]">
              <select
                aria-label="Tributo"
                className={cn(selectCls, "h-10 px-2")}
                value={t.kind}
                onChange={(e) =>
                  setTaxes((p) => p.map((x) => (x.key === t.key ? { ...x, kind: e.target.value as OtherTaxKind } : x)))
                }
              >
                {(Object.keys(OTHER_TAX_LABEL) as OtherTaxKind[]).map((k) => (
                  <option key={k} value={k} className="bg-popover text-popover-foreground">
                    {OTHER_TAX_LABEL[k]}
                  </option>
                ))}
              </select>
              {t.kind === "percepcion_iibb" ? (
                <select
                  aria-label="Jurisdicción"
                  className={cn(selectCls, "h-10 px-2")}
                  value={t.jurisdiction}
                  onChange={(e) =>
                    setTaxes((p) => p.map((x) => (x.key === t.key ? { ...x, jurisdiction: e.target.value } : x)))
                  }
                >
                  <option value="" className="bg-popover text-popover-foreground">
                    Jurisdicción
                  </option>
                  {PROVINCES.map((pr) => (
                    <option key={pr} value={pr} className="bg-popover text-popover-foreground">
                      {pr}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="Detalle"
                  placeholder="Detalle (opcional)"
                  className={inputCls}
                  value={t.description}
                  onChange={(e) =>
                    setTaxes((p) => p.map((x) => (x.key === t.key ? { ...x, description: e.target.value } : x)))
                  }
                />
              )}
              <input
                aria-label="Monto"
                inputMode="decimal"
                className={cn(inputCls, "text-right")}
                value={t.amount}
                onChange={(e) =>
                  setTaxes((p) => p.map((x) => (x.key === t.key ? { ...x, amount: e.target.value } : x)))
                }
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Quitar tributo"
                onClick={() => setTaxes((p) => p.filter((x) => x.key !== t.key))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setTaxes((p) => [
                ...p,
                { key: nextKey(), kind: "percepcion_iibb", jurisdiction: "", description: "", amount: "" },
              ])
            }
          >
            <Plus size={14} /> Agregar percepción o tributo
          </Button>
        </section>

        <section className="grid gap-3 rounded-xl bg-muted p-3.5 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Neto</span>
              <span className="tabular-nums">{formatCurrency(computed.net)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">IVA</span>
              <span className="tabular-nums">{formatCurrency(computed.vat)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Percepciones y otros</span>
              <span className="tabular-nums">{formatCurrency(computed.other)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Suma</span>
              <span className="tabular-nums">{formatCurrency(computed.total)}</span>
            </div>
          </div>
          <Field label="Total del comprobante (como figura en el papel)">
            <input
              inputMode="decimal"
              className={cn(inputCls, "h-11 text-right font-semibold")}
              value={totalTouched ? total : s(computed.total)}
              onChange={(e) => {
                setTotal(e.target.value);
                setTotalTouched(true);
              }}
            />
            {totalTouched && (
              <button
                type="button"
                className="mt-1 text-xs text-muted-foreground underline"
                onClick={() => setTotalTouched(false)}
              >
                Usar la suma
              </button>
            )}
          </Field>
        </section>

        <InvoiceLinesSection
          lines={lines}
          setLines={setLines}
          editing={editing}
          saved={savedLines}
          storeId={storeId}
          setStoreId={setStoreId}
          open={open}
        />
        {prefill && prefill.items.length > 0 && !editing && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>La lectura encontró {prefill.items.length} renglones de detalle.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setLines((p) => [
                  ...p,
                  ...prefill.items.map((it) =>
                    newExpenseLine(it.description, s(Math.round(it.qty * it.unit_price * 100) / 100), it.vat_rate),
                  ),
                ])
              }
            >
              Pasarlos como gastos
            </Button>
          </div>
        )}

        {(errors.length > 0 || validation.warnings.length > 0) && (
          <Callout tone={errors.length > 0 ? "danger" : "warning"} icon={TriangleAlert}>
            <ul className="list-disc pl-4 text-sm">
              {[...errors, ...validation.warnings].map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </Callout>
        )}

        {supplier && (
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recepciones que factura
            </h4>
            {linkable.length === 0 ? (
              <p className="text-xs text-muted-foreground">No hay recepciones de este proveedor sin facturar.</p>
            ) : (
              <div className="divide-y divide-border rounded-xl ring-1 ring-border">
                {linkable.map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={linked.includes(r.id)}
                      onChange={(e) =>
                        setLinked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
                      }
                    />
                    <span className="font-mono font-semibold">{formatReceiptNumber(r.number)}</span>
                    <span className="text-muted-foreground">{fmtDate(r.received_date)}</span>
                    {r.remito_number && <span className="text-muted-foreground">Remito {r.remito_number}</span>}
                    <span className="ml-auto tabular-nums">
                      {formatQty(r.total_units)} u · {formatCurrency(r.total_cost)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        <Field label="Notas (opcional)">
          <textarea className={textareaCls} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <SupplierFormModal
        open={newSupplierOpen}
        onOpenChange={setNewSupplierOpen}
        initial={prefill ? { name: prefill.supplier_name ?? "", cuit: prefillCuit } : null}
        onSaved={(sx) => setSupplier(sx.id)}
      />
    </Modal>
  );
}
