"use client";

// F24 · H163 (ADR-177): unidades de venta con coeficiente (bulto, caja, pack).
// Vender 1 bulto = vender N unidades (el stock baja N). Precio propio o
// derivado de N × precio unitario con un descuento opcional.

import { Boxes, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { formatCurrency } from "@/lib/utils/format";
import {
  SALE_UNIT_LABELS,
  saleUnitError,
  saleUnitLabel,
  saleUnitPrice,
  type SaleUnit,
} from "@/lib/products/catalogCodes";

const field =
  "h-10 w-full min-w-0 rounded-lg border-0 bg-muted px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary";

const num = (v: string): number | null => {
  if (!v.trim()) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function SaleUnitsEditor({
  value,
  onChange,
  unitPrice,
  product,
  allowDiscount,
}: {
  value: SaleUnit[];
  onChange: (next: SaleUnit[]) => void;
  unitPrice: number;
  product: { unit?: string | null; has_variants?: boolean | null; is_serialized?: boolean | null; is_service?: boolean | null };
  allowDiscount: boolean;
}) {
  const blocked =
    (product.unit ?? "un") === "kg"
      ? "Un artículo pesable se vende por kilo: no lleva bultos."
      : product.has_variants || product.is_serialized
        ? "Los artículos con variantes o serializados no se venden por bulto."
        : null;
  const update = (i: number, patch: Partial<SaleUnit>) => onChange(value.map((u, j) => (j === i ? { ...u, ...patch } : u)));

  if (blocked && value.length === 0) {
    return <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">{blocked}</p>;
  }

  return (
    <div className="space-y-3">
      {blocked && <p className="text-xs text-danger">{blocked} Quitá los bultos para guardar.</p>}
      {value.map((u, i) => {
        const err = saleUnitError(u, product);
        const price = saleUnitPrice(u, unitPrice, allowDiscount);
        return (
          <div key={u.id ?? `new-${i}`} className="space-y-2 rounded-lg bg-muted p-3">
            <div className="flex items-center gap-2">
              <Boxes size={16} className="shrink-0 text-muted-foreground" />
              <p className="flex-1 text-sm font-semibold">{saleUnitLabel(u)}</p>
              <span className="font-mono text-sm tabular-nums">{formatCurrency(price)}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                aria-label={`Quitar ${saleUnitLabel(u)}`}
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-danger"
              >
                <X size={15} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="space-y-1 text-xs text-muted-foreground">
                Nombre
                <input
                  className={field + " bg-background"}
                  list="sale-unit-labels"
                  value={u.label}
                  maxLength={20}
                  onChange={(e) => update(i, { label: e.target.value })}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Unidades
                <input
                  className={field + " bg-background"}
                  inputMode="numeric"
                  value={Number.isFinite(u.units) ? String(u.units) : ""}
                  onChange={(e) => update(i, { units: Math.round(num(e.target.value) ?? 0) })}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Precio del bulto
                <input
                  className={field + " bg-background"}
                  inputMode="decimal"
                  placeholder={formatCurrency(saleUnitPrice({ ...u, price: null }, unitPrice, allowDiscount))}
                  value={u.price == null ? "" : String(u.price)}
                  onChange={(e) => update(i, { price: num(e.target.value) })}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Descuento %
                <input
                  className={field + " bg-background"}
                  inputMode="decimal"
                  disabled={u.price != null || !allowDiscount}
                  value={u.discountPct ? String(u.discountPct) : ""}
                  placeholder="0"
                  onChange={(e) => update(i, { discountPct: num(e.target.value) ?? 0 })}
                />
              </label>
            </div>
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Código del bulto (opcional)
                <input
                  className={field + " bg-background font-mono"}
                  value={u.barcode}
                  maxLength={60}
                  placeholder="DUN-14 o el que traiga la caja"
                  onChange={(e) => update(i, { barcode: e.target.value })}
                />
              </label>
              <label className="flex h-10 items-center gap-2 text-xs text-muted-foreground">
                Activo
                <Switch checked={u.isActive} onCheckedChange={(v) => update(i, { isActive: v })} />
              </label>
            </div>
            {err && <p className="text-xs text-danger">{err}</p>}
            {!err && !allowDiscount && (u.price != null || u.discountPct > 0) && (
              <p className="text-xs text-muted-foreground">
                Sin descuentos en este artículo: el bulto se cobra a {u.units} × precio unitario.
              </p>
            )}
          </div>
        );
      })}
      <datalist id="sale-unit-labels">
        {SALE_UNIT_LABELS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {!blocked && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            onChange([...value, { id: null, label: "Caja", units: 12, price: null, discountPct: 0, barcode: "", isActive: true }])
          }
        >
          <Plus size={15} /> Agregar bulto o caja
        </Button>
      )}
    </div>
  );
}
