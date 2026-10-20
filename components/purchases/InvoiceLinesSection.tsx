"use client";

// Renglones de la factura de compra (F24 · H167, ADR-178): artículos que
// también ingresan el stock (al guardar se crea la recepción, igual que
// recibir mercadería) y gastos con cuenta contable (servicios, alquiler,
// luz). Opcional: sin renglones la factura se carga como siempre.

import { useState } from "react";
import { PackagePlus, ReceiptText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { VAT_RATES } from "@/lib/purchases/invoices";
import { lineNet, type InvoiceLineDraft } from "@/lib/purchases/invoiceLines";
import { variantLabel } from "@/modules/products/api";
import { useAccAccounts, useAccountingAccess } from "@/modules/accounting/hooks";
import { useStores } from "@/modules/stock/hooks";
import type { InvoiceLineRow } from "@/modules/purchases/pro";
import { ProductPicker } from "./ProductPicker";
import { inputCls, parseNum, selectCls } from "./shared";

export interface LineState {
  key: number;
  kind: "item" | "expense";
  product_id: string | null;
  variant_id: string | null;
  label: string;
  description: string;
  qty: string;
  unitCost: string;
  vatRate: number;
  net: string;
  accountId: string;
}

let seq = 1;
export const newExpenseLine = (description = "", net = "", vatRate = 21): LineState => ({
  key: seq++,
  kind: "expense",
  product_id: null,
  variant_id: null,
  label: "",
  description,
  qty: "",
  unitCost: "",
  vatRate,
  net,
  accountId: "",
});

export function toDraft(l: LineState): InvoiceLineDraft {
  return l.kind === "item"
    ? {
        kind: "item",
        product_id: l.product_id,
        variant_id: l.variant_id,
        qty: parseNum(l.qty),
        unit_cost: parseNum(l.unitCost),
        vat_rate: l.vatRate,
      }
    : {
        kind: "expense",
        description: l.description.trim(),
        net: parseNum(l.net),
        vat_rate: l.vatRate,
        account_id: l.accountId || null,
      };
}

export function InvoiceLinesSection({
  lines,
  setLines,
  editing,
  saved,
  storeId,
  setStoreId,
  open,
}: {
  lines: LineState[];
  setLines: (fn: (p: LineState[]) => LineState[]) => void;
  editing: boolean;
  saved: InvoiceLineRow[];
  storeId: string;
  setStoreId: (v: string) => void;
  open: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const acc = useAccountingAccess();
  const { data: accounts = [] } = useAccAccounts(open && acc.enabled);
  const imputable = accounts.filter((a) => a.imputable && a.is_active);
  const { data: stores = [] } = useStores();
  const hasItems = lines.some((l) => l.kind === "item");
  const savedItems = saved.filter((l) => l.kind === "item");
  const patch = (key: number, p: Partial<LineState>) =>
    setLines((prev) => prev.map((x) => (x.key === key ? { ...x, ...p } : x)));

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Renglones (opcional)
        </h4>
        <div className="flex flex-wrap gap-2">
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setPicking((v) => !v)}>
              <PackagePlus size={14} /> Artículo que recibís
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setLines((p) => [...p, newExpenseLine()])}>
            <ReceiptText size={14} /> Gasto
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Los artículos ingresan al stock al guardar (se crea la recepción vinculada a la factura, con el costo de la
        factura). Los gastos van a la cuenta contable que elijas.
      </p>

      {savedItems.length > 0 && (
        <div className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
          Artículos recibidos con esta factura:{" "}
          {savedItems.map((l) => `${formatQty(Number(l.qty))} × ${formatCurrency(Number(l.unit_cost))}`).join(" · ")}.
          Para cambiarlos, anulá la recepción.
        </div>
      )}

      {picking && !editing && (
        <ProductPicker
          enabled={open}
          onPick={(p, v) => {
            setLines((prev) => [
              ...prev,
              {
                key: seq++,
                kind: "item",
                product_id: p.id,
                variant_id: v?.id ?? null,
                label: v ? `${p.name} (${variantLabel(v)})` : p.name,
                description: "",
                qty: "1",
                unitCost: p.cost ? String(p.cost).replace(".", ",") : "",
                vatRate: Number(p.tax_rate ?? 21) || 21,
                net: "",
                accountId: "",
              },
            ]);
            setPicking(false);
          }}
        />
      )}

      {lines.map((l) => (
        <div key={l.key} className="space-y-2 rounded-md bg-muted/50 p-3">
          {l.kind === "item" ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_8rem_6rem_auto]">
              <div className="col-span-2 self-center text-sm font-medium sm:col-span-1">{l.label}</div>
              <input
                aria-label="Cantidad"
                inputMode="decimal"
                placeholder="Cant."
                className={cn(inputCls, "text-right")}
                value={l.qty}
                onChange={(e) => patch(l.key, { qty: e.target.value })}
              />
              <input
                aria-label="Costo unitario sin IVA"
                inputMode="decimal"
                placeholder="Costo s/IVA"
                className={cn(inputCls, "text-right")}
                value={l.unitCost}
                onChange={(e) => patch(l.key, { unitCost: e.target.value })}
              />
              <VatSelect value={l.vatRate} onChange={(v) => patch(l.key, { vatRate: v })} />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Quitar renglón"
                onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_8rem_6rem_auto]">
              <input
                aria-label="Detalle del gasto"
                placeholder="Detalle (luz, alquiler, flete...)"
                maxLength={200}
                className={cn(inputCls, "col-span-2 sm:col-span-1")}
                value={l.description}
                onChange={(e) => patch(l.key, { description: e.target.value })}
              />
              <input
                aria-label="Neto"
                inputMode="decimal"
                placeholder="Neto"
                className={cn(inputCls, "text-right")}
                value={l.net}
                onChange={(e) => patch(l.key, { net: e.target.value })}
              />
              <VatSelect value={l.vatRate} onChange={(v) => patch(l.key, { vatRate: v })} />
              <Button
                size="sm"
                variant="ghost"
                aria-label="Quitar renglón"
                onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}
              >
                <Trash2 size={14} />
              </Button>
              {acc.enabled && (
                <select
                  aria-label="Cuenta contable"
                  className={cn(selectCls, "col-span-2 h-10 sm:col-span-4")}
                  value={l.accountId}
                  onChange={(e) => patch(l.key, { accountId: e.target.value })}
                >
                  <option value="" className="bg-popover text-popover-foreground">
                    Cuenta de compras del proveedor (la de siempre)
                  </option>
                  {imputable.map((a) => (
                    <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div className="text-right text-xs text-muted-foreground tabular-nums">
            Neto {formatCurrency(lineNet(toDraft(l)))}
          </div>
        </div>
      ))}

      {hasItems && (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Sucursal que recibe</span>
          <select className={selectCls} value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="" className="bg-popover text-popover-foreground">
              Elegí la sucursal
            </option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

function VatSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select
      aria-label="Alícuota"
      className={cn(selectCls, "h-10 px-2")}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {VAT_RATES.map((v) => (
        <option key={v} value={v} className="bg-popover text-popover-foreground">
          {String(v).replace(".", ",")} %
        </option>
      ))}
    </select>
  );
}
