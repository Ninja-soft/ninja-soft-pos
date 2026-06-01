"use client";

import { useMemo, useRef, useState } from "react";
import { CornerDownRight, Plus, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useCategories, useCategoryMutations } from "@/modules/products/hooks";
import {
  flattenCategories,
  CATEGORY_MAX_DEPTH,
  type Category,
} from "@/modules/products/api";

// Gestión de categorías con hasta 4 niveles (rubro → sub-rubro → …).
// El árbol sale de parent_id; la profundidad se calcula y se topea en 4.
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
  const nameRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(
    () => flattenCategories((categories ?? []) as Category[]),
    [categories],
  );
  const depthById = useMemo(() => {
    const m = new Map<string, number>();
    flat.forEach(({ cat, depth }) => m.set(cat.id, depth));
    return m;
  }, [flat]);

  const parentName = parentId
    ? (categories ?? []).find((c) => c.id === parentId)?.name
    : null;
  const childrenCount = (id: string) =>
    flat.filter(({ cat }) => cat.parent_id === id).length;

  function add() {
    if (name.trim().length < 1) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    create.mutate(
      { name: name.trim(), parent_id: parentId || null },
      {
        onSuccess: () => {
          setName("");
          nameRef.current?.focus();
          toast({ title: "Categoría creada", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  function del(c: Category) {
    const msg =
      childrenCount(c.id) > 0
        ? `Eliminar "${c.name}" y sus sub-categorías?`
        : `Eliminar "${c.name}"?`;
    if (!window.confirm(msg)) return;
    if (parentId === c.id) setParentId("");
    remove.mutate(c.id, {
      onSuccess: () => toast({ title: "Categoría eliminada", variant: "success" }),
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  }

  function addSubTo(c: Category) {
    setParentId(c.id);
    nameRef.current?.focus();
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Categorías" className="max-w-lg">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Organizá tu catálogo en rubros y sub-rubros, hasta <strong>4 niveles</strong>.
          Ej: Indumentaria → Calzado → Zapatillas → Running. Tocá{" "}
          <CornerDownRight size={13} className="inline align-middle" /> en una categoría
          para agregarle una sub-categoría.
        </p>

        {/* Alta */}
        <div className="rounded-lg border border-border p-3">
          {parentName ? (
            <div className="mb-2 flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Agregando dentro de</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-ninja-flame/12 px-2 py-0.5 font-medium text-ninja-flameSoft">
                {parentName}
                <button onClick={() => setParentId("")} aria-label="Quitar padre">
                  <X size={12} />
                </button>
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
              placeholder={parentName ? `Sub-categoría de ${parentName}` : "Nombre de la categoría"}
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

        {/* Árbol */}
        <div className="max-h-80 space-y-0.5 overflow-y-auto">
          {flat.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin categorías aún.
            </p>
          )}
          {flat.map(({ cat, depth }) => {
            const canChild = depth < CATEGORY_MAX_DEPTH;
            return (
              <div
                key={cat.id}
                className="group flex items-center justify-between rounded-md py-1.5 pr-2 hover:bg-muted"
                style={{ paddingLeft: `${8 + depth * 18}px` }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {depth > 0 && (
                    <CornerDownRight
                      size={13}
                      className="shrink-0 text-muted-foreground"
                    />
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
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {canChild && (
                    <button
                      onClick={() => addSubTo(cat)}
                      title="Agregar sub-categoría"
                      className="rounded p-1 text-muted-foreground transition hover:text-ninja-flameSoft"
                    >
                      <CornerDownRight size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => del(cat)}
                    title="Eliminar"
                    className="rounded p-1 text-muted-foreground transition hover:text-destructive"
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
