"use client";

// Devolución a proveedor (F18 · ADR-059): desde una recepción (lo recibido
// menos lo ya devuelto, al costo con que entró) o libre (producto, sucursal y
// costo). Saca stock de la sucursal, descuenta del lote y recalcula el costo
// promedio. La nota de crédito del proveedor se puede cargar acá o vincular
// después: es la que da el crédito en la cuenta corriente.

import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { INVOICE_LETTERS, VAT_RATES, letterDiscriminatesVat, validateInvoice, vatFor, type InvoiceLetter } from "@/lib/purchases/invoices";
import { formatReceiptNumber, purchaseErrorMessage } from "@/lib/purchases/orders";
import {
  RETURN_REASONS,
  RETURN_REASON_LABEL,
  returnTotals,
  returnableQty,
  validateReturn,
  type ReturnReason,
} from "@/lib/purchases/returns";
import { variantLabel } from "@/modules/products/api";
import { useStores } from "@/modules/stock/hooks";
import { usePurchaseV2Mutations, useStoreStock, useSuppliers } from "@/modules/purchases/hooks";
import type { ReceiptDetail } from "@/modules/purchases/api";
import { ProductPicker } from "./ProductPicker";
import {
  ErrorList,
  FormField,
  SectionTitle,
  inputCls,
  parseNum,
  selectCls,
  supplierName,
  textareaCls,
  today,
} from "./shared";

interface Line {
  key: string;
  receipt_item_id: string | null;
  product_id: string;
  variant_id: string | null;
  name: string;
  unit: string;
  max: number | null;
  qty: string;
  unit_cost: number;
}

export function ReturnModal({
  open,
  onOpenChange,
  receipt,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  receipt: ReceiptDetail | null;
  onCreated?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = usePurchaseV2Mutations();
  const { data: stores = [] } = useStores();
  const { data: suppliers = [] } = useSuppliers({}, open);

  const [store, setStore] = useState("");
  const [supplier, setSupplier] = useState("");
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState<ReturnReason>("danado");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [withNc, setWithNc] = useState(false);
  const [nc, setNc] = useState({ letter: "A" as InvoiceLetter, pos: "", number: "", date: today(), net: "", rate: 21, other: "" });

  useEffect(() => {
    if (!open) return;
    setDate(today());
    setReason("danado");
    setNotes("");
    setWithNc(false);
    setNc({ letter: "A", pos: "", number: "", date: today(), net: "", rate: 21, other: "" });
    if (receipt) {
      setStore(receipt.store_id);
      setSupplier(receipt.supplier_id ?? "");
      setLines(
        receipt.items
          .filter((i) => returnableQty(i) > 0)
          .map((i) => ({
            key: i.id,
            receipt_item_id: i.id,
            product_id: i.product_id,
            variant_id: i.variant_id,
            name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
            unit: i.unit,
            max: returnableQty(i),
            qty: "",
            unit_cost: i.valued_unit_cost,
          })),
      );
    } else {
      setStore(stores[0]?.id ?? "");
      setSupplier("");
      setLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, receipt?.id]);

  const productIds = useMemo(() => [...new Set(lines.map((l) => l.product_id))], [lines]);
  const { data: stock } = useStoreStock(open && store ? store : null, productIds);

  const drafts = lines.map((l) => ({
    qty: parseNum(l.qty),
    unit_cost: l.unit_cost,
    max: l.max,
    store_qty: stock ? (stock.get(`${l.product_id}:${l.variant_id ?? ""}`) ?? 0) : null,
  }));
  const totals = returnTotals(drafts);

  const ncNet = parseNum(nc.net);
  const ncVat = letterDiscriminatesVat(nc.letter) ? vatFor(ncNet, nc.rate) : 0;
  const ncOther = parseNum(nc.other);
  const ncTotal = Math.round((ncNet + ncVat + ncOther) * 100) / 100;
  const ncDraft = {
    kind: "credit_note" as const,
    letter: nc.letter,
    point_of_sale: Number(nc.pos) || 0,
    number: Number(nc.number) || 0,
    issue_date: nc.date,
    vat_lines: ncNet > 0 ? [{ rate: letterDiscriminatesVat(nc.letter) ? nc.rate : 0, net: ncNet, vat: ncVat }] : [],
    exempt_amount: 0,
    non_taxed_amount: 0,
    other_taxes: ncOther > 0 ? [{ kind: "percepcion_iibb" as const, description: "Percepciones", amount: ncOther }] : [],
    total: ncTotal,
  };

  const errors = [
    ...(!supplier ? ["Elegí el proveedor."] : []),
    ...(!store ? ["Elegí la sucursal."] : []),
    ...validateReturn(drafts),
    ...(withNc ? validateInvoice(ncDraft).errors : []),
  ];

  async function save() {
    if (errors.length > 0) return;
    try {
      const id = await m.createReturn.mutateAsync({
        receipt_id: receipt?.id ?? null,
        supplier_id: supplier,
        store_id: store,
        return_date: date,
        reason,
        notes: notes.trim() || null,
        items: lines
          .filter((l) => parseNum(l.qty) > 0)
          .map((l) =>
            l.receipt_item_id
              ? { receipt_item_id: l.receipt_item_id, qty: parseNum(l.qty) }
              : { product_id: l.product_id, variant_id: l.variant_id, qty: parseNum(l.qty), unit_cost: l.unit_cost },
          ),
        credit_note: withNc
          ? {
              letter: ncDraft.letter,
              point_of_sale: ncDraft.point_of_sale,
              number: ncDraft.number,
              issue_date: ncDraft.issue_date,
              due_date: null,
              currency: "ARS",
              fx_rate: 1,
              vat_lines: ncDraft.vat_lines,
              exempt_amount: 0,
              non_taxed_amount: 0,
              other_taxes: ncDraft.other_taxes,
              total: ncDraft.total,
            }
          : null,
      });
      toast({ title: "Devolución registrada", variant: "success" });
      onOpenChange(false);
      onCreated?.(id);
    } catch (e) {
      toast({ title: "No se pudo registrar la devolución", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={receipt ? `Devolver de ${formatReceiptNumber(receipt.number)}` : "Devolución a proveedor"}
      description={
        receipt
          ? `${supplierName(suppliers, receipt.supplier_id)} · sale de la sucursal de la recepción`
          : "Sale stock de la sucursal y baja el costo promedio con el costo de lo devuelto."
      }
      className="sm:max-w-3xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm tabular-nums">
            {formatQty(totals.units)} u · <b>{formatCurrency(totals.value)}</b> a costo
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} loading={m.createReturn.isPending} disabled={errors.length > 0}>
              Registrar devolución
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-2">
          {!receipt && (
            <>
              <FormField label="Proveedor">
                <select className={selectCls} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
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
              <FormField label="Sucursal (de donde sale la mercadería)">
                <select className={selectCls} value={store} onChange={(e) => setStore(e.target.value)}>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                      {s.name}
                    </option>
                  ))}
                </select>
              </FormField>
            </>
          )}
          <FormField label="Motivo">
            <select className={selectCls} value={reason} onChange={(e) => setReason(e.target.value as ReturnReason)}>
              {RETURN_REASONS.map((r) => (
                <option key={r} value={r} className="bg-popover text-popover-foreground">
                  {RETURN_REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Fecha">
            <input type="date" className={cn(inputCls, "h-11")} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
        </section>

        <section className="space-y-2">
          <SectionTitle>Qué devolvés</SectionTitle>
          {!receipt && (
            <ProductPicker
              enabled={open}
              autoFocus={false}
              onPick={(p, v) => {
                const key = `${p.id}:${v?.id ?? ""}`;
                setLines((prev) =>
                  prev.some((x) => x.key === key)
                    ? prev
                    : [
                        ...prev,
                        {
                          key,
                          receipt_item_id: null,
                          product_id: p.id,
                          variant_id: v?.id ?? null,
                          name: v ? `${p.name} (${variantLabel(v)})` : p.name,
                          unit: p.unit ?? "un",
                          max: null,
                          qty: "1",
                          unit_cost: Number(p.cost ?? 0),
                        },
                      ],
                );
              }}
            />
          )}
          {lines.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              {receipt ? "Ya se devolvió todo lo recibido." : "Buscá los productos que devolvés."}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Producto</th>
                    <th className="px-3 py-2 text-right">{receipt ? "Devolvible" : "En sucursal"}</th>
                    <th className="px-3 py-2 text-right">Costo unit.</th>
                    <th className="w-28 px-3 py-2 text-right">Devolver</th>
                    {!receipt && <th className="w-10" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((l, idx) => {
                    const d = drafts[idx]!;
                    const bad = (d.max != null && d.qty > d.max) || (d.store_qty != null && d.qty > d.store_qty);
                    return (
                      <tr key={l.key}>
                        <td className="px-3 py-2 font-medium">{l.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatQty(l.max ?? d.store_qty ?? 0)} {l.unit}
                          {receipt && d.store_qty != null && (
                            <div className="text-xs">en sucursal {formatQty(d.store_qty)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {receipt ? (
                            formatCurrency(l.unit_cost)
                          ) : (
                            <input
                              aria-label="Costo unitario"
                              inputMode="decimal"
                              className={cn(inputCls, "h-9 w-28 text-right")}
                              defaultValue={String(l.unit_cost).replace(".", ",")}
                              onChange={(e) =>
                                setLines((p) =>
                                  p.map((x) => (x.key === l.key ? { ...x, unit_cost: parseNum(e.target.value) } : x)),
                                )
                              }
                            />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            aria-label={`Cantidad de ${l.name}`}
                            inputMode="decimal"
                            className={cn(inputCls, "h-9 text-right", bad && "border-danger")}
                            value={l.qty}
                            onChange={(e) =>
                              setLines((p) => p.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))
                            }
                          />
                        </td>
                        {!receipt && (
                          <td className="px-2 py-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="Quitar"
                              onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={withNc} onCheckedChange={setWithNc} label="Cargar la nota de crédito" />
            Ya tengo la nota de crédito del proveedor
          </label>
          {!withNc && (
            <p className="text-xs text-muted-foreground">
              Sin la nota de crédito la devolución queda con NC pendiente y no cambia la cuenta corriente. Podés
              vincularla después desde la devolución.
            </p>
          )}
          {withNc && (
            <div className="grid gap-3 rounded-md bg-muted/50 p-3 sm:grid-cols-4">
              <FormField label="Letra">
                <select
                  className={cn(selectCls, "h-10")}
                  value={nc.letter}
                  onChange={(e) => setNc((p) => ({ ...p, letter: e.target.value as InvoiceLetter }))}
                >
                  {INVOICE_LETTERS.map((l) => (
                    <option key={l} value={l} className="bg-popover text-popover-foreground">
                      {l}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Punto de venta">
                <input inputMode="numeric" className={inputCls} value={nc.pos} onChange={(e) => setNc((p) => ({ ...p, pos: e.target.value }))} />
              </FormField>
              <FormField label="Número">
                <input
                  inputMode="numeric"
                  className={inputCls}
                  value={nc.number}
                  onChange={(e) => setNc((p) => ({ ...p, number: e.target.value }))}
                />
              </FormField>
              <FormField label="Fecha">
                <input type="date" className={inputCls} value={nc.date} onChange={(e) => setNc((p) => ({ ...p, date: e.target.value }))} />
              </FormField>
              <FormField label={letterDiscriminatesVat(nc.letter) ? "Neto gravado" : "Importe"}>
                <input
                  inputMode="decimal"
                  className={cn(inputCls, "text-right")}
                  value={nc.net}
                  placeholder={formatCurrency(totals.value)}
                  onChange={(e) => setNc((p) => ({ ...p, net: e.target.value }))}
                />
              </FormField>
              {letterDiscriminatesVat(nc.letter) && (
                <FormField label="Alícuota IVA">
                  <select
                    className={cn(selectCls, "h-10")}
                    value={nc.rate}
                    onChange={(e) => setNc((p) => ({ ...p, rate: Number(e.target.value) }))}
                  >
                    {VAT_RATES.map((r) => (
                      <option key={r} value={r} className="bg-popover text-popover-foreground">
                        {String(r).replace(".", ",")} %
                      </option>
                    ))}
                  </select>
                </FormField>
              )}
              <FormField label="Percepciones (opcional)">
                <input
                  inputMode="decimal"
                  className={cn(inputCls, "text-right")}
                  value={nc.other}
                  onChange={(e) => setNc((p) => ({ ...p, other: e.target.value }))}
                />
              </FormField>
              <div className="flex items-end text-sm">
                <span>
                  Total NC <b className="tabular-nums">{formatCurrency(ncTotal)}</b>
                </span>
              </div>
            </div>
          )}
        </section>

        <FormField label="Notas (opcional)">
          <textarea className={textareaCls} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {lines.some((l) => parseNum(l.qty) > 0) && <ErrorList errors={errors} />}
      </div>
    </Modal>
  );
}
