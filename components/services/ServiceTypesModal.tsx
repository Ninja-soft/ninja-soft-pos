"use client";

// Tipos de servicio del negocio (ADR-122): Programa, Visita, Trabajo,
// Informe, Análisis, Consultoría, Mantenimiento y los que sume el negocio.
// Dueño o encargado (RLS); baja lógica: los servicios, presupuestos y ventas
// guardan su nombre.
import { useState } from "react";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { serviceTypeError, useServiceTypeMutations, useServiceTypes, type ServiceType } from "@/modules/services/types";
import { ServiceTypeIcon } from "./ServiceTypeIcon";

export function ServiceTypesModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { data: rows = [], isLoading } = useServiceTypes(open);
  const { create, update, remove } = useServiceTypeMutations();
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ServiceType | null>(null);

  function reset() {
    setEditId(null);
    setName("");
  }

  async function save() {
    if (!name.trim()) return;
    try {
      if (editId) {
        await update.mutateAsync({ id: editId, patch: { name } });
        toast({ title: "Tipo actualizado", variant: "success" });
      } else {
        await create.mutateAsync({ name, sort: (rows.at(-1)?.sort ?? 0) + 10 });
        toast({ title: "Tipo creado", variant: "success" });
      }
      reset();
    } catch (e) {
      toast({ title: "No se pudo guardar", description: serviceTypeError(e), variant: "error" });
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
        title="Tipos de servicio"
        description="Clasifican tus servicios y salen en el presupuesto y la factura. También sirven de filtro."
        className="sm:max-w-lg"
      >
        <div className="space-y-4">
          <div className="flex items-end gap-2 rounded-lg bg-muted/60 p-3">
            <div className="min-w-0 flex-1">
              <Input
                variant="filled"
                label={editId ? "Editar tipo" : "Nuevo tipo"}
                placeholder="Ej. Capacitación, Auditoría"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
            </div>
            {editId && (
              <Button type="button" variant="ghost" onClick={reset}>
                Cancelar
              </Button>
            )}
            <Button type="button" onClick={save} loading={create.isPending || update.isPending} disabled={!name.trim()}>
              {editId ? "Guardar" : (
                <>
                  <Plus size={15} /> Agregar
                </>
              )}
            </Button>
          </div>

          <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg bg-muted">
            {!isLoading && rows.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <Layers size={24} className="opacity-40" aria-hidden />
                <span>Todavía no hay tipos. Creá el primero arriba.</span>
              </div>
            )}
            {rows.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-fg-6 text-muted-foreground" aria-hidden>
                  <ServiceTypeIcon icon={t.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
                {t.is_seed && (
                  <Badge tone="neutral">
                    Base
                  </Badge>
                )}
                <Switch
                  checked={t.is_active}
                  onCheckedChange={(v) =>
                    update.mutate(
                      { id: t.id, patch: { is_active: v } },
                      { onError: (e) => toast({ title: "No se pudo actualizar", description: serviceTypeError(e), variant: "error" }) },
                    )
                  }
                  label={`Activo: ${t.name}`}
                />
                <button
                  type="button"
                  onClick={() => {
                    setEditId(t.id);
                    setName(t.name);
                  }}
                  className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                  aria-label={`Editar ${t.name}`}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(t)}
                  className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-danger/15 hover:text-danger"
                  aria-label={`Eliminar ${t.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={deleteTarget ? `Eliminar "${deleteTarget.name}"` : "Eliminar tipo"}
        description="Los servicios con este tipo quedan sin tipo. Los presupuestos y las ventas ya hechas conservan el nombre."
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await remove.mutateAsync(deleteTarget.id);
            toast({ title: "Tipo eliminado", variant: "success" });
          } catch (e) {
            toast({ title: "No se pudo eliminar", description: serviceTypeError(e), variant: "error" });
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </>
  );
}
