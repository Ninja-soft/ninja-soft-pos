"use client";

import { useState } from "react";
import { PackageSearch, Plus, X } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { SearchField } from "@/components/ui/SearchField";
import { useProducts, useProductsByIds } from "@/modules/products/hooks";
import { setProductScope, type ScopeDraft } from "@/lib/warranty/scopes";
import { formatCurrency } from "@/lib/utils/format";

// Productos puntuales (ADR-139): ganan a cualquier categoría y a "todos".
// "Ofrecer" suma un producto que su categoría no tiene; "No ofrecer" lo saca
// aunque su categoría sí la tenga.
export function ProductScopePicker({
  draft,
  onChange,
}: {
  draft: ScopeDraft;
  onChange: (d: ScopeDraft) => void;
}) {
  const [query, setQuery] = useState("");
  const { data: found, isFetching } = useProducts(query);
  const chosenIds = Object.keys(draft.products);
  const { data: chosen } = useProductsByIds(chosenIds);
  const byId = new Map((chosen ?? []).map((p) => [p.id, p]));
  const results = query.trim().length >= 2 ? (found ?? []).filter((p) => !draft.products[p.id]).slice(0, 6) : [];

  return (
    <div className="space-y-2">
      <SearchField
        value={query}
        onValueChange={setQuery}
        loading={isFetching && query.trim().length >= 2}
        placeholder="Buscar producto por nombre, código o SKU"
        aria-label="Buscar producto"
      />
      {results.length > 0 && (
        <ul className="overflow-hidden rounded-lg border border-border">
          {results.map((p) => (
            <li key={p.id} className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
              <span className="min-w-0">
                <span className="block truncate text-sm text-foreground">{p.name}</span>
                <span className="block text-xs text-muted-foreground">{formatCurrency(Number(p.price) || 0)}</span>
              </span>
              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onChange(setProductScope(draft, p.id, "include"));
                    setQuery("");
                  }}
                  className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted px-2.5 text-xs font-medium text-foreground transition hover:bg-secondary"
                >
                  <Plus size={13} /> Ofrecer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChange(setProductScope(draft, p.id, "exclude"));
                    setQuery("");
                  }}
                  className="inline-flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  No ofrecer
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {chosenIds.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg bg-muted/60 px-3 py-3 text-xs text-muted-foreground">
          <PackageSearch size={16} className="shrink-0" aria-hidden />
          Sin productos puntuales. Buscá uno para ofrecerla sí o sí, o para sacarla aunque su categoría la tenga.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {chosenIds.map((id) => {
            const p = byId.get(id);
            return (
              <li key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{p?.name ?? "Producto"}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Segmented
                    size="sm"
                    aria-label={`Garantía para ${p?.name ?? "el producto"}`}
                    value={draft.products[id]!}
                    onChange={(v) => onChange(setProductScope(draft, id, v))}
                    options={[
                      { value: "include", label: "Ofrecer" },
                      { value: "exclude", label: "No ofrecer" },
                    ]}
                  />
                  <button
                    type="button"
                    onClick={() => onChange(setProductScope(draft, id, null))}
                    aria-label={`Quitar ${p?.name ?? "producto"}`}
                    className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    <X size={15} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
