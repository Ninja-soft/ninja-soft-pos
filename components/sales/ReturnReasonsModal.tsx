"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useReturnReasons, useReturnReasonMutations } from "@/modules/sales/hooks";

// Catálogo de motivos de devolución (H29). Owner/manager los administra.
export function ReturnReasonsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: reasons } = useReturnReasons(false);
  const { create, setActive, remove } = useReturnReasonMutations();
  const [label, setLabel] = useState("");

  function add() {
    if (label.trim().length < 1) return;
    create.mutate(label.trim(), {
      onSuccess: () => setLabel(""),
      onError: () => toast({ title: "No se pudo crear", variant: "error" }),
    });
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Motivos de devolución" className="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Los motivos activos aparecen al registrar una devolución.
        </p>
        <div className="flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ej. Falla de fábrica"
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ninja-flameSoft"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button onClick={add} loading={create.isPending}>
            <Plus size={15} /> Agregar
          </Button>
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {(reasons ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin motivos. Agregá el primero.
            </p>
          )}
          {(reasons ?? []).map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className={r.is_active ? "text-sm" : "text-sm text-muted-foreground line-through"}>
                {r.label}
              </span>
              <span className="flex items-center gap-3">
                <Switch
                  checked={r.is_active}
                  onCheckedChange={(v) => setActive.mutate({ id: r.id, is_active: v })}
                  label="Activo"
                />
                <button
                  onClick={() => remove.mutate(r.id)}
                  title="Eliminar"
                  className="text-muted-foreground transition hover:text-destructive"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
