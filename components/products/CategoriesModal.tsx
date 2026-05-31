"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useCategories, useCategoryMutations } from "@/modules/products/hooks";
import type { Category } from "@/modules/products/api";

// Gestión de categorías con 2 niveles (rubro → sub-rubro). Solo las de nivel 1
// pueden ser padre, así nunca se pasa de 2 niveles.
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

  const { parents, childrenByParent } = useMemo(() => {
    const list = (categories ?? []) as Category[];
    const parents = list.filter((c) => !c.parent_id);
    const childrenByParent = new Map<string, Category[]>();
    for (const c of list) {
      if (c.parent_id) {
        const arr = childrenByParent.get(c.parent_id) ?? [];
        arr.push(c);
        childrenByParent.set(c.parent_id, arr);
      }
    }
    return { parents, childrenByParent };
  }, [categories]);

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
          toast({ title: "Categoría creada", variant: "success" });
        },
        onError: () => toast({ title: "No se pudo crear", variant: "error" }),
      },
    );
  }

  function del(c: Category) {
    const hasChildren = (childrenByParent.get(c.id)?.length ?? 0) > 0;
    const msg = hasChildren
      ? `Eliminar "${c.name}" y sus sub-categorías?`
      : `Eliminar "${c.name}"?`;
    if (!window.confirm(msg)) return;
    remove.mutate(c.id, {
      onSuccess: () => toast({ title: "Categoría eliminada", variant: "success" }),
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Categorías" className="max-w-lg">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Organizá tu catálogo por rubros y sub-rubros (máximo 2 niveles). Ej:
          Indumentaria → Calzado.
        </p>

        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nombre de la categoría"
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="h-10 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          >
            <option value="">Nivel 1 (sin padre)</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id} className="bg-ninja-deepViolet">
                Dentro de {p.name}
              </option>
            ))}
          </select>
          <Button type="button" onClick={add} loading={create.isPending}>
            <Plus size={15} /> Agregar
          </Button>
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {parents.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin categorías aún.
            </p>
          )}
          {parents.map((p) => (
            <div key={p.id}>
              <div className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted">
                <span className="font-medium">{p.name}</span>
                <button
                  onClick={() => del(p)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Eliminar"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {(childrenByParent.get(p.id) ?? []).map((c) => (
                <div
                  key={c.id}
                  className="ml-5 flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                >
                  <span>↳ {c.name}</span>
                  <button
                    onClick={() => del(c)}
                    className="hover:text-destructive"
                    title="Eliminar"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
