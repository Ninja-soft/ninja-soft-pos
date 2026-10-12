"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import { buildCategoryTree, type Category, type CategoryTreeNode } from "@/modules/products/api";
import { cn } from "@/lib/utils/cn";
import { POS_EYEBROW, POS_ROW_ON, POS_SEG_OFF, POS_SEG_ON, POS_SEG_TRACK } from "./posStyles";

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

// Rubros en un riel segmentado (mismo lenguaje que components/ui/Segmented):
// el elegido es el "pulgar" neutro elevado, sin relleno invertido.
const chip =
  "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors [@media(pointer:coarse)]:h-10";
const track = cn(
  "inline-flex max-w-full gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  POS_SEG_TRACK,
);

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
      <div className={track} role="group" aria-label="Rubros">
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-pressed={selected === null}
          className={cn(chip, selected === null ? POS_SEG_ON : POS_SEG_OFF)}
        >
          <LayoutGrid size={16} aria-hidden /> Todo
        </button>
        {tree.map((n) => {
          const on = trail.includes(n.cat.id);
          return (
            <button
              key={n.cat.id}
              type="button"
              onClick={() => onSelect(n.cat.id === selected ? null : n.cat.id)}
              aria-pressed={on}
              className={cn(chip, on ? POS_SEG_ON : POS_SEG_OFF)}
            >
              {n.cat.name}
              {n.children.length > 0 && <ChevronRight size={14} className="-mr-1 opacity-50" aria-hidden />}
            </button>
          );
        })}
      </div>
      {drillParent && drillParent.children.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => onSelect(parentById.get(drillParent.cat.id) ?? null)}
            className={cn(chip, "h-8 px-2 text-xs text-muted-foreground hover:bg-fg-6 hover:text-foreground")}
            aria-label={`Volver de ${drillParent.cat.name}`}
          >
            <ChevronLeft size={16} aria-hidden />
            <span className="max-w-[9rem] truncate">{drillParent.cat.name}</span>
          </button>
          {drillParent.children.map((c) => {
            const on = trail.includes(c.cat.id);
            return (
              <button
                key={c.cat.id}
                type="button"
                onClick={() => onSelect(c.cat.id === selected ? drillParent.cat.id : c.cat.id)}
                aria-pressed={on}
                className={cn(
                  chip,
                  "h-8 text-xs",
                  on ? "bg-fg-10 font-semibold text-foreground" : "text-muted-foreground hover:bg-fg-6 hover:text-foreground",
                )}
              >
                {c.cat.name}
                {c.children.length > 0 && <ChevronRight size={14} className="-mr-1 opacity-50" aria-hidden />}
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
            "flex min-h-9 w-full items-center justify-between gap-2 rounded-md py-1.5 pr-2.5 text-left text-[13px] font-medium transition-colors",
            on ? POS_ROW_ON : inTrail ? "text-foreground" : "text-muted-foreground hover:bg-fg-4 hover:text-foreground",
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
      <p className={cn("px-2.5 pb-2 pt-1", POS_EYEBROW)}>Colecciones</p>
      <ul className="slim-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
              selected === null ? POS_ROW_ON : "text-muted-foreground hover:bg-fg-4 hover:text-foreground",
            )}
          >
            <LayoutGrid size={16} aria-hidden /> Todo
          </button>
        </li>
        {tree.map((n) => row(n, 0))}
      </ul>
    </nav>
  );
}
