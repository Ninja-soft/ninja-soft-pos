"use client";

import { useState } from "react";
import { Armchair, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useAgendaResources, useAgendaResourceMutations } from "@/modules/agenda/hooks";
import {
  RESOURCE_KIND_LABELS,
  type AgendaResource,
  type ResourceKind,
} from "@/modules/agenda/api";
import { agendaErrorMessage } from "@/modules/agenda/overlap";

const COLORS = ["#94a3b8", "#ff5a2c", "#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6"] as const;
const KINDS = Object.keys(RESOURCE_KIND_LABELS) as ResourceKind[];

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

function ResourceModal({
  open,
  onOpenChange,
  resource,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  resource: AgendaResource | null;
}) {
  const { toast } = useToast();
  const { create, update } = useAgendaResourceMutations();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ResourceKind>("silla");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [isActive, setIsActive] = useState(true);

  function sync() {
    setName(resource?.name ?? "");
    setKind(resource?.kind ?? "silla");
    setColor(resource?.color ?? COLORS[0]);
    setIsActive(resource?.is_active ?? true);
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const payload = { name: name.trim(), kind, color, is_active: isActive };
    try {
      if (resource) await update.mutateAsync({ id: resource.id, patch: payload });
      else await create.mutateAsync(payload);
      toast({ title: resource ? "Recurso actualizado" : "Recurso agregado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: agendaErrorMessage(e instanceof Error ? e.message : null),
        variant: "error",
      });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) sync();
        onOpenChange(o);
      }}
      title={resource ? "Editar recurso" : "Nuevo recurso"}
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ej. Sillón 1" />
        <div>
          <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Tipo</label>
          <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k} className="bg-popover text-popover-foreground">
                {RESOURCE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Color en la agenda</span>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                className={`h-8 w-8 rounded-full border-2 transition ${color === c ? "border-foreground" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Activo (disponible para agendar)</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} label="Activo" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {resource ? "Guardar" : "Agregar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Sillas, cabinas, boxes o equipos de la agenda (feature agenda_recursos). Lo
// edita el dueño o el encargado; la policy de agenda_resources lo exige igual.
export function ResourcesManager({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { data: resources, isLoading } = useAgendaResources();
  const { remove } = useAgendaResourceMutations();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AgendaResource | null>(null);

  async function del(r: AgendaResource) {
    try {
      await remove.mutateAsync(r.id);
      toast({ title: "Recurso dado de baja", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo dar de baja", description: agendaErrorMessage(e instanceof Error ? e.message : null), variant: "error" });
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Armchair size={16} className="text-ninja-flameSoft" /> Recursos (sillas, cabinas, equipos)
        </span>
        {canEdit && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus size={15} /> Agregar
          </Button>
        )}
      </div>
      {isLoading ? (
        <SpinnerBlock className="py-6" />
      ) : (resources ?? []).length === 0 ? (
        <div className="rounded-xl bg-muted/50">
          <EmptyState
            compact
            icon={Armchair}
            title="Todavía no hay recursos"
            description="Cargá tus sillas o cabinas para ver la agenda por recurso y evitar dos turnos en el mismo lugar."
          />
        </div>
      ) : (
        <div className="space-y-2">
          {resources!.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {r.name}
                    {!r.is_active && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        inactivo
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{RESOURCE_KIND_LABELS[r.kind]}</span>
                </span>
              </span>
              {canEdit && (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(r);
                      setOpen(true);
                    }}
                    className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label="Editar"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => del(r)}
                    className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-danger"
                    aria-label="Dar de baja"
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <ResourceModal open={open} onOpenChange={setOpen} resource={editing} />
    </div>
  );
}
