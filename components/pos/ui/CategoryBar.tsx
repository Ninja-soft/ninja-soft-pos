"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { buildCategoryTree, type Category, type CategoryTreeNode } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import { POS_IDLE, POS_SELECTED } from "./posStyles";

// Navegación de rubros del POS. Dos formas:
//  - "top": pestañas horizontales (raíces) + fila de sub-rubros al elegir una.
//  - "left": riel vertical con el árbol (Boutique), para catálogos visuales.
// Elegir un rubro filtra por todo su sub-árbol (lo resuelve la página).

function useTreeIndex(categories: Category[]) {
  return useMemo(() => {
    const tree = buildCategoryTree(categories);
    const nodeById = new Map<string, CategoryTreeNode>();
    const parentById = new Map<string, string | null>();
    const walk = (nodes: CategoryTreeNode[], parent: string | null) => {
      for (const n of nodes) {
        nodeById.set(n.cat.id, n);
        parentById.set(n.cat.id, parent);
        walk(n.children, n.cat.id);
      }
    };
    walk(tree, null);
    return { tree, nodeById, parentById };
  }, [categories]);
}

function trailOf(
  selected: string | null,
  nodeById: Map<string, CategoryTreeNode>,
  parentById: Map<string, string | null>,
) {
  const out: string[] = [];
  let cur = selected;
  while (cur) {
    if (!nodeById.has(cur)) break;
    out.unshift(cur);
    cur = parentById.get(cur) ?? null;
  }
  return out;
}

const chip =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition active:scale-95";

export function CategoryChips({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { tree, nodeById, parentById } = useTreeIndex(categories);
  const trail = trailOf(selected, nodeById, parentById);
  const active = selected ? nodeById.get(selected) : null;
  const drillParent = active
    ? active.children.length > 0
      ? active
      : nodeById.get(parentById.get(active.cat.id) ?? "") ?? null
    : null;

  if (tree.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button type="button" onClick={() => onSelect(null)} className={cn(chip, selected === null ? POS_SELECTED : POS_IDLE)}>
          <LayoutGrid size={14} /> Todo
        </button>
        {tree.map((n) => {
          const on = trail.includes(n.cat.id);
          return (
            <button
              key={n.cat.id}
              type="button"
              onClick={() => onSelect(n.cat.id === selected ? null : n.cat.id)}
              className={cn(chip, on ? POS_SELECTED : POS_IDLE)}
            >
              {n.cat.name}
              {n.children.length > 0 && <ChevronRight size={13} className="opacity-60" />}
            </button>
          );
        })}
      </div>
      {drillParent && drillParent.children.length > 0 && (
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => onSelect(parentById.get(drillParent.cat.id) ?? null)}
            className={cn(chip, "h-8 px-2.5 text-xs", POS_IDLE)}
            aria-label={`Volver de ${drillParent.cat.name}`}
          >
            <ChevronLeft size={14} />
            <span className="max-w-[9rem] truncate">{drillParent.cat.name}</span>
          </button>
          {drillParent.children.map((c) => {
            const on = trail.includes(c.cat.id);
            return (
              <button
                key={c.cat.id}
                type="button"
                onClick={() => onSelect(c.cat.id === selected ? drillParent.cat.id : c.cat.id)}
                className={cn(
                  chip,
                  "h-8 text-xs",
                  on ? "bg-[color-mix(in_srgb,var(--pos-from)_22%,transparent)] text-foreground" : POS_IDLE,
                )}
              >
                {c.cat.name}
                {c.children.length > 0 && <ChevronRight size={12} className="opacity-60" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CategoryRail({
  categories,
  selected,
  onSelect,
  counts,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  counts?: Map<string, number>;
}) {
  const { tree, nodeById, parentById } = useTreeIndex(categories);
  const trail = trailOf(selected, nodeById, parentById);

  const row = (n: CategoryTreeNode, depth: number): React.ReactNode => {
    const on = selected === n.cat.id;
    const inTrail = trail.includes(n.cat.id);
    return (
      <li key={n.cat.id}>
        <button
          type="button"
          onClick={() => onSelect(on ? (parentById.get(n.cat.id) ?? null) : n.cat.id)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-xl py-2 pr-2.5 text-left text-[13px] font-semibold transition",
            on ? POS_SELECTED : inTrail ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          <span className="truncate">{n.cat.name}</span>
          {counts?.get(n.cat.id) != null && (
            <span className="shrink-0 text-[11px] font-medium tabular-nums opacity-60">
              {counts.get(n.cat.id)}
            </span>
          )}
        </button>
        {inTrail && n.children.length > 0 && (
          <ul className="mt-0.5 space-y-0.5">{n.children.map((c) => row(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Rubros" className="flex h-full flex-col">
      <p className="px-2.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Colecciones
      </p>
      <ul className="slim-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold transition",
              selected === null ? POS_SELECTED : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <LayoutGrid size={14} /> Todo
          </button>
        </li>
        {tree.map((n) => row(n, 0))}
      </ul>
    </nav>
  );
}
