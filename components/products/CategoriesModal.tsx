"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  CornerDownRight,
  FolderTree,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useCategories, useCategoryMutations } from "@/modules/products/hooks";
import {
  buildCategoryTree,
  CATEGORY_MAX_DEPTH,
  type Category,
  type CategoryTreeNode,
} from "@/modules/products/api";

// Gestión de categorías con hasta 10 niveles (rubro → sub-rubro → …).
// El árbol sale de parent_id; se muestra como un listado anidado y desglosable
// (expandible/colapsable), no plano. La profundidad se topea en 10.
export function CategoriesModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: categories } = useCategories();
  const { create, remove } = useCategoryMutations();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [delTarget, setDelTarget] = useState<Category | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(
    () => buildCategoryTree((categories ?? []) as Category[]),
    [categories],
  );

  // Ids que tienen al menos un hijo (los únicos que se pueden expandir).
  const expandableIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (nodes: CategoryTreeNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          ids.push(n.cat.id);
          walk(n.children);
        }
      }
    };
    walk(tree);
    return ids;
  }, [tree]);

  // Al abrir (o cuando llegan/cambian las categorías) arrancamos con todo
  // desglosado: el usuario quiere ver la jerarquía completa de un vistazo.
  useEffect(() => {
    if (open) setExpanded(new Set(expandableIds));
  }, [open, expandableIds]);

  // Mapa id → ruta "Padre › Hijo › …" para mostrar dónde cae la nueva categoría.
  const pathById = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (nodes: CategoryTreeNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix} › ${n.cat.name}` : n.cat.name;
        m.set(n.cat.id, path);
        walk(n.children, path);
      }
    };
    walk(tree, "");
    return m;
  }, [tree]);

  const depthById = useMemo(() => {
    const m = new Map<string, number>();
    const walk = (nodes: CategoryTreeNode[]) => {
      for (const n of nodes) {
        m.set(n.cat.id, n.depth);
        walk(n.children);
      }
    };
    walk(tree);
    return m;
  }, [tree]);

  const parentPath = parentId ? pathById.get(parentId) : null;
  const parentDepth = parentId ? (depthById.get(parentId) ?? 0) : -1;
  const nextLevel = parentDepth + 2; // nivel humano (1-based) de la nueva cat.

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function add() {
    if (name.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    create.mutate(
      { name: name.trim(), parent_id: parentId || null },
      {
        onSuccess: () => {
          // Dejamos el padre expandido para ver el hijo recién creado.
          if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
          setName("");
          nameRef.current?.focus();
          toast({ title: "Categoría creada", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  function confirmDelete() {
    const c = delTarget;
    if (!c) return;
    if (parentId === c.id) setParentId("");
    remove.mutate(c.id, {
      onSuccess: () => {
        setDelTarget(null);
        toast({ title: "Categoría eliminada", variant: "success" });
      },
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  }

  function addSubTo(c: Category) {
    setParentId(c.id);
    setExpanded((prev) => new Set(prev).add(c.id));
    nameRef.current?.focus();
  }

  const allExpanded =
    expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange} title="Categorías" className="max-w-lg">
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Organizá tu catálogo en rubros y sub-rubros, hasta{" "}
            <strong>10 niveles</strong>. Ej: Indumentaria → Calzado → Zapatillas →
            Running. Tocá{" "}
            <CornerDownRight size={13} className="inline align-middle" /> en una
            categoría para agregarle una sub-categoría y la flecha{" "}
            <ChevronRight size={13} className="inline align-middle" /> para
            desglosar el árbol.
          </p>

          {/* Alta */}
          <div className="rounded-lg border border-border p-3">
            {parentPath ? (
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">
                  Agregando dentro de
                </span>
                <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ninja-flame/12 px-2 py-0.5 font-medium text-ninja-flameSoft">
                  <span className="truncate">{parentPath}</span>
                  <button
                    onClick={() => setParentId("")}
                    aria-label="Quitar padre"
                    className="shrink-0"
                  >
                    <X size={12} />
                  </button>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  (nivel {nextLevel})
                </span>
              </div>
            ) : (
              <div className="mb-2 text-xs text-muted-foreground">
                Nueva categoría de <strong>nivel 1</strong> (sin padre).
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  parentPath ? `Sub-categoría de ${parentPath}` : "Nombre de la categoría"
                }
                className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
              <Button type="button" onClick={add} loading={create.isPending}>
                <Plus size={15} /> Agregar
              </Button>
            </div>
          </div>

          {/* Controles del árbol */}
          {expandableIds.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide text-muted-foreground">
                <FolderTree size={13} className="text-ninja-flameSoft" /> Árbol de
                categorías
              </span>
              <button
                onClick={() =>
                  setExpanded(allExpanded ? new Set() : new Set(expandableIds))
                }
                className="font-medium text-ninja-flameSoft transition hover:underline"
              >
                {allExpanded ? "Colapsar todo" : "Expandir todo"}
              </button>
            </div>
          )}

          {/* Árbol anidado desglosable */}
          <div className="max-h-80 space-y-0.5 overflow-y-auto">
            {tree.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Sin categorías aún.
              </p>
            )}
            {tree.map((node) => (
              <CategoryRow
                key={node.cat.id}
                node={node}
                expanded={expanded}
                onToggle={toggle}
                onAddSub={addSubTo}
                onDelete={setDelTarget}
                activeParentId={parentId}
              />
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={delTarget !== null}
        onOpenChange={(o) => !o && setDelTarget(null)}
        title="Eliminar categoría"
        description={
          delTarget
            ? (descendantCountFor(tree, delTarget.id) ?? 0) > 0
              ? `Se elimina "${delTarget.name}" y sus sub-categorías.`
              : `Se elimina "${delTarget.name}".`
            : ""
        }
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

// Cantidad de descendientes de una categoría dentro del árbol (para el mensaje
// de borrado). Devuelve undefined si no se encuentra.
function descendantCountFor(
  nodes: CategoryTreeNode[],
  id: string,
): number | undefined {
  for (const n of nodes) {
    if (n.cat.id === id) return n.descendantCount;
    const found = descendantCountFor(n.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Fila recursiva del árbol: renderiza la categoría y, si está expandida, sus
// hijos (que a su vez se renderizan con este mismo componente).
function CategoryRow({
  node,
  expanded,
  onToggle,
  onAddSub,
  onDelete,
  activeParentId,
}: {
  node: CategoryTreeNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onAddSub: (c: Category) => void;
  onDelete: (c: Category) => void;
  activeParentId: string;
}) {
  const { cat, depth, children, descendantCount } = node;
  const hasChildren = children.length > 0;
  const isOpen = expanded.has(cat.id);
  const canChild = depth < CATEGORY_MAX_DEPTH;
  const isActiveParent = activeParentId === cat.id;

  return (
    <div>
      <div
        className={`group flex items-center justify-between rounded-md py-1.5 pr-2 transition ${
          isActiveParent ? "bg-ninja-flame/10" : "hover:bg-muted"
        }`}
        style={{ paddingLeft: `${4 + depth * 16}px` }}
      >
        <span className="flex min-w-0 items-center gap-1">
          {hasChildren ? (
            <button
              onClick={() => onToggle(cat.id)}
              aria-label={isOpen ? "Colapsar" : "Expandir"}
              aria-expanded={isOpen}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:text-ninja-flameSoft"
            >
              <ChevronRight
                size={15}
                className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <span className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground/50">
              {depth > 0 ? (
                <CornerDownRight size={12} />
              ) : (
                <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
              )}
            </span>
          )}
          <span
            className={
              depth === 0
                ? "truncate font-semibold"
                : "truncate text-sm text-muted-foreground"
            }
          >
            {cat.name}
          </span>
          {hasChildren && (
            <span className="ml-1 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {descendantCount}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {canChild && (
            <button
              onClick={() => onAddSub(cat)}
              title="Agregar sub-categoría"
              className="rounded p-1 text-muted-foreground opacity-0 transition hover:text-ninja-flameSoft focus:opacity-100 group-hover:opacity-100"
            >
              <CornerDownRight size={14} />
            </button>
          )}
          <button
            onClick={() => onDelete(cat)}
            title="Eliminar"
            className="rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>

      {hasChildren && isOpen && (
        <div className="space-y-0.5">
          {children.map((child) => (
            <CategoryRow
              key={child.cat.id}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              onAddSub={onAddSub}
              onDelete={onDelete}
              activeParentId={activeParentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
