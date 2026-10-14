"use client";

// Aclaraciones predefinidas de servicios (ADR-116): plantillas de texto del
// negocio que se suman a los renglones de la factura ("Incluye toma de
// muestras", "Normativa CAA art. 1413"). Dueño o encargado (RLS); baja lógica.

import { useState } from "react";
import { MessageSquareText, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { errorDescription } from "@/lib/permissions/errors";
import { useClarificationMutations, useServiceClarifications } from "@/modules/services/hooks";
import type { ServiceClarification } from "@/modules/services/api";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

const textareaCls =
  "min-h-[84px] w-full resize-y rounded-xl border-0 bg-muted px-3.5 py-3 text-sm leading-relaxed text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

export function ClarificationsModal({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const { data: rows = [], isLoading } = useServiceClarifications(false, open);
  const { create, update, remove } = useClarificationMutations();
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ServiceClarification | null>(null);

  function reset() {
    setEditId(null);
    setTitle("");
    setBody("");
  }

  function startEdit(c: ServiceClarification) {
    setEditId(c.id);
    setTitle(c.title);
    setBody(c.body);
  }

  async function save() {
    if (!title.trim() || !body.trim()) return;
    try {
      if (editId) {
        await update.mutateAsync({ id: editId, patch: { title, body } });
        toast({ title: "Aclaración actualizada", variant: "success" });
      } else {
        await create.mutateAsync({ title, body, sort: rows.length });
        toast({ title: "Aclaración creada", variant: "success" });
      }
      reset();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: errorDescription(e), variant: "error" });
    }
  }

  async function setActive(c: ServiceClarification, is_active: boolean) {
    try {
      await update.mutateAsync({ id: c.id, patch: { is_active } });
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: errorDescription(e), variant: "error" });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      if (editId === deleteTarget.id) reset();
      toast({ title: "Aclaración eliminada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo eliminar", description: errorDescription(e), variant: "error" });
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(o) => {
          if (!o) reset();
          onOpenChange(o);
        }}
        title="Aclaraciones de servicios"
        description="Textos que se suman debajo del servicio en la factura. Las ventas ya hechas guardan su propio texto."
        className="sm:max-w-lg"
      >
        <div className="space-y-4">
          <div className="space-y-2.5 rounded-xl bg-muted/60 p-3">
            <Input
              variant="filled"
              label={editId ? "Editar aclaración" : "Nueva aclaración"}
              placeholder="Nombre corto (ej. Toma de muestras)"
              maxLength={80}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              aria-label="Texto de la aclaración"
              className={textareaCls}
              placeholder="Texto que sale en la factura (ej. Incluye toma de muestras en planta por personal propio)"
              maxLength={1000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              {editId && (
                <Button type="button" variant="ghost" size="sm" onClick={reset}>
                  Cancelar
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={save}
                loading={create.isPending || update.isPending}
                disabled={!title.trim() || !body.trim()}
              >
                {editId ? "Guardar" : (
                  <>
                    <Plus size={15} /> Agregar
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg bg-muted">
            {!isLoading && rows.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <MessageSquareText size={24} className="opacity-40" aria-hidden />
                <span>Todavía no hay aclaraciones. Creá la primera arriba.</span>
              </div>
            )}
            {rows.map((c) => (
              <div key={c.id} className="flex items-start gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{c.title}</p>
                  <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{c.body}</p>
                </div>
                <Switch checked={c.is_active} onCheckedChange={(v) => setActive(c, v)} label={`Activa: ${c.title}`} />
                <button
                  type="button"
                  onClick={() => startEdit(c)}
                  className="rounded-md p-1.5 text-muted-foreground outline-none transition hover:bg-fg-10 hover:text-foreground focus-visible:bg-fg-10"
                  aria-label={`Editar ${c.title}`}
                >
                  <Pencil size={14} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(c)}
                  className="rounded-md p-1.5 text-muted-foreground outline-none transition hover:bg-danger/15 hover:text-danger focus-visible:bg-danger/15"
                  aria-label={`Eliminar ${c.title}`}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title="Eliminar aclaración"
        description={`¿Eliminar "${deleteTarget?.title}"? Deja de ofrecerse al vender; las facturas ya hechas no cambian.`}
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
