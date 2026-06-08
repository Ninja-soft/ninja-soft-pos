"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import {
  buildCategoryTree,
  type Category,
  type CategoryTreeNode,
} from "@/modules/products/api";

// Navegador de categorías del POS: en vez de una tira plana de "accesos
// rápidos", muestra las categorías raíz como pestañas y, al elegir una con
// sub-categorías, deja desglosar nivel por nivel (con breadcrumb para volver).
// Al tocar cualquier categoría se filtran los productos de ESA categoría y de
// todas sus descendientes. Mobile-first, scroll horizontal sin barra.
//
// `selected` = id de la categoría activa (null = todas).
// `onSelect` recibe el id elegido (o null para "Todos").
export function CategoryNav({
  categories,
  selected,
  onSelect,
}: {
  categories: Category[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const tree = useMemo(() => buildCategoryTree(categories), [categories]);

  // Índices auxiliares: nodo por id, padre por id y cadena de ancestros.
  const { nodeById, parentById } = useMemo(() => {
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
    return { nodeById, parentById };
  }, [tree]);

  // Ruta de ancestros de la categoría activa (de la raíz hacia abajo), para el
  // breadcrumb / botón "volver".
  const trail = useMemo(() => {
    const out: CategoryTreeNode[] = [];
    let cur = selected;
    while (cur) {
      const node = nodeById.get(cur);
      if (!node) break;
      out.unshift(node);
      cur = parentById.get(cur) ?? null;
    }
    return out;
  }, [selected, nodeById, parentById]);

  const activeNode = selected ? nodeById.get(selected) : null;

  // Qué nivel mostramos como "fila de drill-down": los hijos de la categoría
  // activa si los tiene; si la activa es hoja, los hermanos (hijos del padre).
  const drillParent = activeNode
    ? activeNode.children.length > 0
      ? activeNode
      : (parentById.get(activeNode.cat.id)
          ? nodeById.get(parentById.get(activeNode.cat.id) as string) ?? null
          : null)
    : null;
  const drillItems = drillParent ? drillParent.children : [];

  if (tree.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Fila raíz: "Todos" + categorías de nivel 1 */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Pill active={selected === null} onClick={() => onSelect(null)}>
          <LayoutGrid size={14} className="-ml-0.5" />
          Todos
        </Pill>
        {tree.map((n) => {
          // La raíz queda activa si es la seleccionada o un ancestro de ella.
          const rootActive = trail.some((t) => t.cat.id === n.cat.id);
          return (
            <Pill
              key={n.cat.id}
              active={rootActive}
              onClick={() => onSelect(n.cat.id === selected ? null : n.cat.id)}
            >
              {n.cat.name}
              {n.children.length > 0 && (
                <ChevronRight
                  size={13}
                  className={rootActive ? "text-white/70" : "text-muted-foreground/60"}
                />
              )}
            </Pill>
          );
        })}
      </div>

      {/* Fila de drill-down: breadcrumb para volver + sub-categorías */}
      {drillParent && drillItems.length > 0 && (
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => {
              const grand = parentById.get(drillParent.cat.id) ?? null;
              onSelect(grand);
            }}
            className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border px-2 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Volver"
            title="Volver"
          >
            <ChevronLeft size={14} />
            <span className="max-w-[8rem] truncate">{drillParent.cat.name}</span>
          </button>
          <span className="shrink-0 text-muted-foreground/40">/</span>
          {drillItems.map((c) => {
            const active = trail.some((t) => t.cat.id === c.cat.id);
            return (
              <button
                key={c.cat.id}
                onClick={() => onSelect(c.cat.id === selected ? drillParent.cat.id : c.cat.id)}
                className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? "bg-ninja-flame text-white"
                    : "border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {c.cat.name}
                {c.children.length > 0 && (
                  <ChevronRight
                    size={13}
                    className={active ? "text-white/70" : "text-muted-foreground/60"}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active
          ? "bg-ninja-flame text-white"
          : "border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// Conjunto de ids de una categoría + todos sus descendientes. Para filtrar los
// productos: tocar un rubro padre muestra también lo de sus sub-rubros.
export function subtreeIds(categories: Category[], rootId: string): Set<string> {
  const byParent = new Map<string | null, string[]>();
  for (const c of categories) {
    const k = c.parent_id ?? null;
    const arr = byParent.get(k) ?? [];
    arr.push(c.id);
    byParent.set(k, arr);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop() as string;
    out.add(cur);
    for (const child of byParent.get(cur) ?? []) stack.push(child);
  }
  return out;
}
