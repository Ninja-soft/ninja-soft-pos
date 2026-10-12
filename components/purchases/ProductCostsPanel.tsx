"use client";

// Tres costos del producto (BASE, F18 · H101, ADR-050): último costo y
// promedio ponderado (los mantiene la recepción de mercadería) y costo de
// reposición (manual o desde la lista del proveedor). Muestra el margen con
// cada uno y cuál alimenta el margen del negocio.

import type { UseFormRegisterReturn } from "react-hook-form";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  COST_BASIS_LABEL,
  markupPct,
  productCosts,
  type CostBasis,
} from "@/lib/purchases/costs";
import { useCostHistory, usePurchaseSettings } from "@/modules/purchases/hooks";
import { DEFAULT_PURCHASE_SETTINGS } from "@/modules/purchases/api";

const KIND_LABEL: Record<string, string> = {
  cost: "Costo",
  last: "Último costo",
  average: "Promedio ponderado",
  replacement: "Reposición",
};

const SOURCE_LABEL: Record<string, string> = {
  receipt: "Recepción",
  import_costing: "Costeo de importación",
  supplier_list: "Lista del proveedor",
  cost_basis_change: "Cambio de base de costo",
  manual: "Manual",
};

export function ProductCostsPanel({
  product,
  price,
  replacementField,
}: {
  product: unknown;
  price: number;
  replacementField: UseFormRegisterReturn;
}) {
  const { data: settings } = usePurchaseSettings();
  const s = settings ?? DEFAULT_PURCHASE_SETTINGS;
  const c = productCosts(product);
  const id = (product as { id?: string } | null)?.id ?? null;
  const { data: history = [] } = useCostHistory(id);

  const rows: Array<{ basis: CostBasis; value: number | null; hint: string }> = [
    { basis: "last", value: c.last_cost, hint: "De la última recepción" },
    { basis: "average", value: c.avg_cost, hint: "Se recalcula en cada recepción" },
    { basis: "replacement", value: c.replacement_cost, hint: "Lo cargás vos o sale del proveedor" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {rows.map((r) => {
          const m = markupPct(price, r.value);
          const active = s.cost_basis === r.basis;
          return (
            <div
              key={r.basis}
              className={cn("rounded-xl bg-muted p-3", active && "ring-1 ring-border")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{COST_BASIS_LABEL[r.basis]}</span>
                {active && <Badge tone="brand">Margen</Badge>}
              </div>
              {r.basis === "replacement" ? (
                <Input
                  variant="filled"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="Sin cargar"
                  aria-label="Costo de reposición"
                  className="mt-1 h-9"
                  {...replacementField}
                />
              ) : (
                <div className="mt-1 font-price text-lg font-bold tabular-nums">
                  {r.value == null ? <span className="text-sm text-muted-foreground">Sin compras</span> : formatCurrency(r.value)}
                </div>
              )}
              <div className="mt-1 text-[11px] text-muted-foreground">
                {m == null ? r.hint : `Margen ${String(m).replace(".", ",")} %`}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Costos netos de IVA.{" "}
        {s.sync_product_cost
          ? `El costo del producto se actualiza solo con el ${COST_BASIS_LABEL[s.cost_basis].toLowerCase()} (Configuración de compras).`
          : "El costo del producto lo cargás a mano (la sincronización está apagada en Configuración de compras)."}
      </p>
      {history.length > 0 && (
        <Disclosure title="Historial de costos">
          <ul className="divide-y divide-border text-xs">
            {history.slice(0, 30).map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <span className="font-medium">{KIND_LABEL[h.kind] ?? h.kind}</span>
                  <span className="text-muted-foreground"> · {SOURCE_LABEL[h.source ?? ""] ?? h.source ?? ""}</span>
                </span>
                <span className="tabular-nums">
                  {h.old_value == null ? "Sin dato" : formatCurrency(h.old_value)} a{" "}
                  {h.new_value == null ? "Sin dato" : formatCurrency(h.new_value)}
                  <span className="ml-2 text-muted-foreground">
                    {new Date(h.created_at).toLocaleDateString("es-AR")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
