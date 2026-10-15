"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FolderTree } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { cn } from "@/lib/utils/cn";
import type { CategoryNodeLike } from "@/lib/warranty/pricing";
import {
  categoryMixed,
  categoryOn,
  flattenTree,
  toggleCategory,
  type ScopeDraft,
} from "@/lib/warranty/scopes";

// Árbol de categorías con checkboxes (ADR-139). Cada categoría hereda el
// estado de la de arriba; tildar o destildar una la marca a ella y a todo lo
// que cuelga (salvo lo que tenga marca propia). "Incluida" / "Excluida"
// señalan las marcas propias; el checkbox mixto, que adentro hay excepciones.
export function CategoryScopeTree({
  draft,
  onChange,
  categories,
}: {
  draft: ScopeDraft;
  onChange: (d: ScopeDraft) => void;
  categories: CategoryNodeLike[];
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(
    () => flattenTree(categories, { query, collapsed }),
    [categories, query, collapsed],
  );

  if (categories.filter((c) => !c.deleted_at).length === 0) {
    return (
      <EmptyState
        compact
        icon={FolderTree}
        title="Todavía no tenés categorías"
        description="Creá rubros y categorías en Productos para asignar garantías por grupo. Mientras tanto podés elegir productos puntuales."
      />
    );
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <SearchField value={query} onValueChange={setQuery} placeholder="Buscar rubro o categoría" aria-label="Buscar categoría" />
      <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Ninguna categoría coincide con “{query}”.</p>
        ) : (
          <ul role="tree" aria-label="Categorías">
            {rows.map((r) => {
              const on = categoryOn(draft, r.id, categories);
              const mixed = categoryMixed(draft, r.id, categories);
              const own = draft.categories[r.id];
              const open = !collapsed.has(r.id) || Boolean(query);
              return (
                <li
                  key={r.id}
                  role="treeitem"
                  aria-level={r.depth + 1}
                  aria-selected={on}
                  aria-expanded={r.hasChildren ? open : undefined}
                  className="flex min-h-11 items-center gap-1 border-b border-border px-2 last:border-b-0"
                  style={{ paddingLeft: 8 + r.depth * 18 }}
                >
                  {r.hasChildren ? (
                    <button
                      type="button"
                      onClick={() => toggleCollapse(r.id)}
                      aria-label={open ? `Cerrar ${r.name}` : `Abrir ${r.name}`}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <ChevronRight size={15} className={cn("transition", open && "rotate-90")} />
                    </button>
                  ) : (
                    <span className="w-8 shrink-0" aria-hidden />
                  )}
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2">
                    <Checkbox
                      checked={mixed ? "indeterminate" : on}
                      onCheckedChange={() => onChange(toggleCategory(draft, r.id, categories))}
                      aria-label={r.name}
                    />
                    <span className={cn("truncate text-sm", on ? "text-foreground" : "text-muted-foreground")}>{r.name}</span>
                  </label>
                  {own === "include" && <Badge tone="success">Incluida</Badge>}
                  {own === "exclude" && <Badge tone="neutral">Excluida</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
