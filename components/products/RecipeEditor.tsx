"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import {
  useProductRecipe,
  useSaveProductRecipe,
  recipeCost,
  marginAmount,
  marginPct,
  type RecipeItem,
} from "@/modules/products/recipes";
import { formatCurrency } from "@/lib/utils/format";

// Fila editable de insumo (en memoria mientras se edita).
interface Row {
  key: string;
  ingredient: string;
  qty: string; // string en el input; se castea al guardar
  unit: string;
  unit_cost: string;
}

function uid(): string {
  return crypto.randomUUID();
}

function emptyRow(): Row {
  return { key: uid(), ingredient: "", qty: "1", unit: "", unit_cost: "0" };
}

// Editor de receta / escandallo de un producto (H50). Mismo patrón de editor
// anidado del form que ModifiersEditor / KitComponentsEditor: edita en memoria y
// persiste todo de un toque (reemplaza la receta del producto). Muestra el costo
// total y, contra el precio de venta, el margen estimado.
export function RecipeEditor({
  productId,
  salePrice,
}: {
  productId: string;
  salePrice: number;
}) {
  const { toast } = useToast();
  const { data: existing } = useProductRecipe(productId, true);
  const save = useSaveProductRecipe(productId);

  const [rows, setRows] = useState<Row[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hidrata desde lo guardado una sola vez (no pisa lo que se está editando).
  useEffect(() => {
    if (!existing || hydrated) return;
    setRows(
      existing.map((it: RecipeItem) => ({
        key: it.id,
        ingredient: it.ingredient,
        qty: String(it.qty),
        unit: it.unit ?? "",
        unit_cost: String(it.unit_cost),
      })),
    );
    setHydrated(true);
  }, [existing, hydrated]);

  function patch(key: string, p: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  // Costo total y margen, recalculados en vivo sobre lo que se está editando.
  const cost = useMemo(
    () =>
      recipeCost(
        rows.map((r) => ({ qty: Number(r.qty) || 0, unit_cost: Number(r.unit_cost) || 0 })),
      ),
    [rows],
  );
  const margin = marginAmount(salePrice, cost);
  const mpct = marginPct(salePrice, cost);

  function persist() {
    const cleaned = rows
      .filter((r) => r.ingredient.trim() !== "")
      .map((r, i) => ({
        ingredient: r.ingredient.trim(),
        qty: Math.max(0, Number(r.qty) || 0),
        unit: r.unit.trim() || null,
        unit_cost: Math.max(0, Number(r.unit_cost) || 0),
        sort: i,
      }));

    save.mutate(cleaned, {
      onSuccess: () => {
        setHydrated(false); // re-hidrata con ids reales
        toast({ title: "Receta guardada", variant: "success" });
      },
      onError: (e: unknown) =>
        toast({
          title: "No se pudo guardar la receta",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        }),
    });
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-3 text-xs text-muted-foreground">
        Cargá los insumos del plato (ingrediente, cantidad, unidad y costo por
        unidad). El costo del plato es la suma; el margen se calcula contra el
        precio de venta. No descuenta stock al vender (eso llega después).
      </p>

      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            Sin insumos. Agregá uno abajo (ej. “Muzzarella · 0.2 kg · $4500/kg”).
          </p>
        )}

        {rows.map((r) => (
          <div key={r.key} className="flex flex-wrap items-end gap-2">
            <label className="min-w-[140px] flex-1 text-xs font-medium text-muted-foreground">
              Ingrediente
              <input
                value={r.ingredient}
                onChange={(e) => patch(r.key, { ingredient: e.target.value })}
                placeholder="Muzzarella"
                className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="w-20 text-xs font-medium text-muted-foreground">
              Cantidad
              <input
                type="number"
                min="0"
                step="0.001"
                value={r.qty}
                onChange={(e) => patch(r.key, { qty: e.target.value })}
                className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="w-16 text-xs font-medium text-muted-foreground">
              Unidad
              <input
                value={r.unit}
                onChange={(e) => patch(r.key, { unit: e.target.value })}
                placeholder="kg"
                className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <label className="w-24 text-xs font-medium text-muted-foreground">
              Costo/unidad
              <input
                type="number"
                min="0"
                step="0.01"
                value={r.unit_cost}
                onChange={(e) => patch(r.key, { unit_cost: e.target.value })}
                className="mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground outline-none focus:border-ninja-flameSoft"
              />
            </label>
            <span className="w-20 pb-2 text-right text-xs font-medium tabular-nums text-muted-foreground">
              {formatCurrency((Number(r.qty) || 0) * (Number(r.unit_cost) || 0))}
            </span>
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              className="mb-1.5 text-muted-foreground hover:text-destructive"
              title="Quitar insumo"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2"
        onClick={() => setRows((rs) => [...rs, emptyRow()])}
      >
        <Plus size={14} /> Agregar insumo
      </Button>

      {/* Resumen costo / margen */}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Costo del plato</div>
          <div className="font-price font-bold tabular-nums">{formatCurrency(cost)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Precio de venta</div>
          <div className="font-price font-bold tabular-nums">{formatCurrency(salePrice)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Margen</div>
          <div
            className={`font-price font-bold tabular-nums ${margin < 0 ? "text-red-400" : "text-emerald-400"}`}
          >
            {formatCurrency(margin)}
            {mpct != null && (
              <span className="ml-1 text-xs font-medium opacity-80">
                ({mpct.toFixed(0)}%)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Button type="button" size="sm" onClick={persist} loading={save.isPending}>
          Guardar receta
        </Button>
      </div>
    </div>
  );
}
