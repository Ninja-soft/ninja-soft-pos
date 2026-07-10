"use client";

import { useState } from "react";
import { Check, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useBrands, useCreateBrand, useBrandMutations } from "@/modules/products/hooks";
import type { Brand } from "@/modules/products/api";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function BrandsModal({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { data: brands } = useBrands();
  const create = useCreateBrand();
  const { update, remove } = useBrandMutations();
  const [newName, setNewName] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await create.mutateAsync(newName.trim());
      setNewName("");
      toast({ title: "Marca creada", variant: "success" });
    } catch {
      toast({ title: "No se pudo crear", variant: "error" });
    }
  }

  function startEdit(b: Brand) {
    setEditId(b.id);
    setEditName(b.name);
  }

  function cancelEdit() {
    setEditId(null);
    setEditName("");
  }

  async function handleUpdate() {
    if (!editId || !editName.trim()) return;
    try {
      await update.mutateAsync({ id: editId, name: editName.trim() });
      cancelEdit();
      toast({ title: "Marca actualizada", variant: "success" });
    } catch {
      toast({ title: "No se pudo actualizar", variant: "error" });
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast({ title: "Marca eliminada", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Gestión de marcas"
        className="max-w-md"
      >
        <div className="space-y-4">
          {/* Nueva marca */}
          <div className="flex gap-2">
            <Input
              placeholder="Nueva marca…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              className="flex-1"
            />
            <Button
              onClick={handleCreate}
              loading={create.isPending}
              disabled={!newName.trim()}
            >
              <Plus size={16} /> Agregar
            </Button>
          </div>

          {/* Lista de marcas */}
          <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {(brands ?? []).length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                <Tag size={24} className="opacity-40" />
                <span>No hay marcas todavía. Creá la primera.</span>
              </div>
            )}
            {(brands ?? []).map((b: Brand) => (
              <div key={b.id} className="flex items-center gap-2 px-3 py-2.5">
                {editId === b.id ? (
                  <>
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleUpdate();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="h-8 flex-1 rounded-md border border-ninja-flameSoft bg-background px-2 text-sm text-foreground outline-none"
                    />
                    <button
                      onClick={handleUpdate}
                      disabled={update.isPending}
                      className="rounded p-1 text-ninja-flameSoft hover:bg-ninja-flameSoft/10"
                      title="Guardar"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                      title="Cancelar"
                    >
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium">{b.name}</span>
                    <button
                      onClick={() => startEdit(b)}
                      className="rounded p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      title="Editar"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(b)}
                      className="rounded p-1.5 text-muted-foreground transition hover:bg-red-400/15 hover:text-danger"
                      title="Eliminar"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Eliminar marca"
        description={`¿Eliminar la marca "${deleteTarget?.name}"? Los productos asociados quedarán sin marca.`}
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
