"use client";

// Valuación del stock (ADR-137): cuánto vale lo que hay al costo y a precio de
// venta, total y por categoría, con avisos de lo que distorsiona el número
// (stock negativo, productos sin costo).

import { AlertTriangle, Wallet } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { TableWrap } from "@/components/ui/Table";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { useInventoryValuation } from "@/modules/stock/adjustments";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-card p-4 ring-1 ring-border">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ValuationTab({ storeId }: { storeId: string | null }) {
  const { data: v, isLoading } = useInventoryValuation(storeId);

  if (isLoading || !v) return <SpinnerBlock label="Calculando valuación" />;
  if (v.items_with_stock === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Acá vas a ver cuánto vale tu stock"
        description="Cuando haya productos con stock y costo cargado, calculamos el valor al costo y a precio de venta."
      />
    );
  }
  const margin = v.retail_value - v.cost_value;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Unidades en stock" value={formatQty(v.units)} hint={`${v.items_with_stock} productos`} />
        <Tile label="Valor al costo" value={formatCurrency(v.cost_value)} />
        <Tile label="Valor a precio de venta" value={formatCurrency(v.retail_value)} />
        <Tile label="Ganancia si vendés todo" value={formatCurrency(margin)} hint="Precio de venta menos costo" />
      </div>

      {(v.negative_items > 0 || v.no_cost_items > 0) && (
        <Callout tone="warning" icon={AlertTriangle} title="Revisá esto para que el número sea real">
          {v.negative_items > 0 && <span className="block">{v.negative_items} productos tienen stock negativo (no se suman).</span>}
          {v.no_cost_items > 0 && (
            <span className="block">{v.no_cost_items} productos con stock no tienen costo cargado (valen $ 0 al costo).</span>
          )}
        </Callout>
      )}

      <section>
        <h2 className="text-base font-semibold">Por categoría</h2>
        <TableWrap className="mt-2">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-semibold">Categoría</th>
                <th className="px-3 py-2 text-right font-semibold">Unidades</th>
                <th className="px-3 py-2 text-right font-semibold">Al costo</th>
                <th className="px-3 py-2 text-right font-semibold">A precio de venta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {v.by_category.map((c) => (
                <tr key={c.category}>
                  <td className="px-3 py-2">
                    {c.category}
                    <span className="ml-1 text-xs text-muted-foreground">({c.items})</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQty(c.units)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(c.cost_value)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(c.retail_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>
    </div>
  );
}
