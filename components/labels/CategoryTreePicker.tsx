"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FolderTree } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils/cn";
import { buildCategoryTree, type CategoryTreeNode } from "@/modules/products/api";
import type { Category } from "@/modules/products/api";

/**
 * Árbol de categorías con selección múltiple. Elegir una categoría incluye
 * sus subcategorías (el servidor también las expande), así que los hijos de
 * una elegida se muestran marcados y deshabilitados.
 */
export function CategoryTreePicker({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const tree = useMemo(() => buildCategoryTree(categories), [categories]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const selected = useMemo(() => new Set(value), [value]);

  if (tree.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Todavía no cargaste categorías.</p>;
  }

  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);

  const render = (nodes: CategoryTreeNode[], inherited: boolean) =>
    nodes.map((n) => {
      const on = inherited || selected.has(n.cat.id);
      const expanded = open[n.cat.id] ?? false;
      return (
        <li key={n.cat.id}>
          <div className="flex min-h-[40px] items-center gap-1.5" style={{ paddingLeft: n.depth * 16 }}>
            {n.children.length > 0 ? (
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [n.cat.id]: !expanded }))}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
                aria-label={expanded ? `Cerrar ${n.cat.name}` : `Abrir ${n.cat.name}`}
                aria-expanded={expanded}
              >
                <ChevronRight size={15} className={cn("transition-transform", expanded && "rotate-90")} />
              </button>
            ) : (
              <span className="w-8 shrink-0" />
            )}
            <label className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm", inherited && "opacity-60")}>
              <Checkbox checked={on} disabled={inherited} onCheckedChange={() => toggle(n.cat.id)} aria-label={n.cat.name} />
              <span className="truncate">{n.cat.name}</span>
              {n.descendantCount > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground">+{n.descendantCount}</span>
              )}
            </label>
          </div>
          {expanded && n.children.length > 0 && <ul>{render(n.children, on)}</ul>}
        </li>
      );
    });

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <FolderTree size={14} /> Categorías
        </span>
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-xs font-semibold text-ninja-flameSoft hover:underline">
            Limpiar ({value.length})
          </button>
        )}
      </div>
      <ul className="slim-scrollbar max-h-64 overflow-y-auto rounded-lg border border-border bg-background p-1">{render(tree, false)}</ul>
    </div>
  );
}
