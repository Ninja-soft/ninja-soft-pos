"use client";

import { useMemo, useState } from "react";
import { Eye, ShieldCheck, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { SearchField } from "@/components/ui/SearchField";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { formatCategoryPath, pathToCategory } from "@/lib/products/categoryPath";
import {
  formatDateAr,
  monthsLabel,
  resolvePlanScope,
  sortPlans,
  warrantyExpiry,
  warrantyUnitPrice,
  type CategoryNodeLike,
  type ScopeResolution,
} from "@/lib/warranty/pricing";
import { useProducts } from "@/modules/products/hooks";
import type { WarrantyScope, WarrantyType } from "@/modules/warranty/api";

export function reasonText(r: ScopeResolution, categories: CategoryNodeLike[]): string {
  const path = () =>
    formatCategoryPath(pathToCategory(r.categoryId, categories.map((c) => ({ id: c.id, name: c.name ?? "", parent_id: c.parent_id }))));
  switch (r.reason) {
    case "product_include":
      return "Elegido puntualmente";
    case "product_exclude":
      return "Sacado puntualmente";
    case "category_include":
      return `Por la categoría ${path()}`;
    case "category_exclude":
      return `Excluido por ${path()}`;
    case "all":
      return "Todos los productos";
    default:
      return "No está asignado";
  }
}

// Vista previa (ADR-139): "este producto ofrece estas garantías a estos
// precios". Mismo cálculo que el POS y que valida el servidor.
export function WarrantyPreview({
  plans,
  scopes,
  categories,
}: {
  plans: WarrantyType[];
  scopes: WarrantyScope[];
  categories: CategoryNodeLike[];
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string; price: number; category_id: string | null; warranty_months: number } | null>(null);
  const { data: found, isFetching } = useProducts(query);
  const results = query.trim().length >= 2 && !picked ? (found ?? []).slice(0, 6) : [];

  const rows = useMemo(() => {
    if (!picked) return [];
    return sortPlans(plans.filter((p) => !p.deleted_at)).map((p) => {
      const res = resolvePlanScope(p, scopes, { id: picked.id, categoryId: picked.category_id }, categories);
      const unit = warrantyUnitPrice(p, picked.price);
      return { plan: p, res, unit, offered: res.applies && p.is_active && unit > 0 };
    });
  }, [picked, plans, scopes, categories]);
  const offered = rows.filter((r) => r.offered).length;

  return (
    <div className="space-y-3">
      <SearchField
        value={picked ? picked.name : query}
        onValueChange={(v) => {
          setPicked(null);
          setQuery(v);
        }}
        loading={isFetching && query.trim().length >= 2 && !picked}
        placeholder="Probá con un producto"
        aria-label="Producto para la vista previa"
      />
      {results.length > 0 && (
        <ul className="overflow-hidden rounded-lg border border-border">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() =>
                  setPicked({
                    id: p.id,
                    name: p.name,
                    price: Number(p.price) || 0,
                    category_id: p.category_id ?? null,
                    warranty_months: p.warranty_months ?? 0,
                  })
                }
                className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left transition last:border-b-0 hover:bg-muted"
              >
                <span className="truncate text-sm text-foreground">{p.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatCurrency(Number(p.price) || 0)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!picked ? (
        <div className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-3 py-3 text-xs text-muted-foreground">
          <Eye size={16} className="shrink-0" aria-hidden />
          Buscá un producto para ver qué garantías ofrece el POS y a qué precio.
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-foreground">
            <span className="font-semibold">{picked.name}</span>{" "}
            <span className="text-muted-foreground">
              ({formatCurrency(picked.price)}
              {picked.warranty_months > 0 ? `, ${monthsLabel(picked.warranty_months)} de fábrica` : ""}) ofrece{" "}
              {offered === 0 ? "ninguna garantía extendida" : offered === 1 ? "1 garantía" : `${offered} garantías`}.
            </span>
          </p>
          <ul className="space-y-1.5">
            {rows.map(({ plan, res, unit, offered: on }) => (
              <li
                key={plan.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border px-3 py-2.5",
                  !on && "bg-muted/40",
                )}
              >
                {on ? (
                  <ShieldCheck size={16} className="shrink-0 text-foreground" aria-hidden />
                ) : (
                  <ShieldOff size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm font-medium", on ? "text-foreground" : "text-muted-foreground")}>
                    {plan.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {!plan.is_active ? "Pausada" : reasonText(res, categories)}
                    {on ? ` · cubre hasta el ${formatDateAr(warrantyExpiry(new Date(), picked.warranty_months, plan.months))}` : ""}
                  </span>
                </span>
                {on ? (
                  <span className="shrink-0 font-price text-sm font-semibold tabular-nums text-foreground">+{formatCurrency(unit)}</span>
                ) : (
                  <Badge tone="neutral">No se ofrece</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
