"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import {
  useProfessionals,
  useProfessionalMutations,
} from "@/modules/agenda/hooks";
import type { Professional } from "@/modules/agenda/api";

// Paleta de colores para la columna del profesional en la agenda (sobrios,
// alineados al tema ninja). El dueño elige uno; el chip se ve en el calendario.
const COLORS = [
  "#ff5a2c", // ninja flame
  "#5f3ad6", // violet
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#8b5cf6", // purple
] as const;
const DEFAULT_COLOR: string = COLORS[0];

function ProfessionalModal({
  open,
  onOpenChange,
  professional,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  professional: Professional | null;
}) {
  const { toast } = useToast();
  const { create, update } = useProfessionalMutations();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [commission, setCommission] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [notes, setNotes] = useState("");

  // Sincroniza el form al abrir.
  function sync() {
    setName(professional?.name ?? "");
    setColor(professional?.color ?? DEFAULT_COLOR);
    setCommission(
      professional?.commission_pct != null ? String(professional.commission_pct) : "",
    );
    setIsActive(professional?.is_active ?? true);
    setNotes(professional?.notes ?? "");
  }

  async function save() {
    if (!name.trim()) {
      toast({ title: "Poné un nombre", variant: "error" });
      return;
    }
    const commissionPct = commission.trim() === "" ? null : Number(commission);
    if (commissionPct != null && (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100)) {
      toast({ title: "Comisión inválida (0–100)", variant: "error" });
      return;
    }
    const payload = {
      name: name.trim(),
      color,
      commission_pct: commissionPct,
      is_active: isActive,
      notes: notes.trim() || null,
    };
    try {
      if (professional) {
        await update.mutateAsync({ id: professional.id, patch: payload });
        toast({ title: "Profesional actualizado", variant: "success" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Profesional agregado", variant: "success" });
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: e instanceof Error ? e.message : undefined,
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
      title={professional ? "Editar profesional" : "Nuevo profesional"}
    >
      <div className="space-y-4">
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="Ej. Ana"
        />
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">
            Color en la agenda
          </span>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
                className={`h-8 w-8 rounded-full border-2 transition ${
                  color === c ? "border-foreground ring-2 ring-ring" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <Input
          label="Comisión por defecto (%) — opcional"
          type="number"
          step="1"
          min="0"
          max="100"
          value={commission}
          onChange={(e) => setCommission(e.target.value)}
          placeholder="Ej. 30"
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Especialidad, días, etc."
        />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Activo (disponible para agendar)</span>
          <Switch checked={isActive} onCheckedChange={setIsActive} label="Activo" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={create.isPending || update.isPending}>
            {professional ? "Guardar" : "Agregar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Gestión de profesionales: alta/edición/baja + color para la agenda. Reusada en
// la página de Agenda y en Configuración. Sólo escritura RLS-permitida (la UI no
// es la única barrera: la policy de professionals acota por tenant).
export function ProfessionalsManager() {
  const { toast } = useToast();
  const { data: professionals, isLoading } = useProfessionals();
  const { remove } = useProfessionalMutations();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Professional | null>(null);

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(p: Professional) {
    setEditing(p);
    setModalOpen(true);
  }

  async function del(p: Professional) {
    try {
      await remove.mutateAsync(p.id);
      toast({ title: "Profesional eliminado", variant: "success" });
    } catch {
      toast({ title: "No se pudo eliminar", variant: "error" });
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <UserCog size={16} className="text-ninja-flameSoft" /> Profesionales
        </span>
        <Button size="sm" variant="secondary" onClick={openNew}>
          <Plus size={15} /> Agregar
        </Button>
      </div>

      {isLoading ? (
        <p className="py-4 text-sm text-muted-foreground">Cargando…</p>
      ) : (professionals ?? []).length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          Sin profesionales. Agregá a quienes prestan los servicios (ej. Ana, Lucas)
          para poder asignarles turnos.
        </p>
      ) : (
        <div className="space-y-2">
          {professionals!.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className="h-4 w-4 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {p.name}
                    {!p.is_active && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                        inactivo
                      </span>
                    )}
                  </span>
                  {p.commission_pct != null && (
                    <span className="block text-xs text-muted-foreground">
                      Comisión {p.commission_pct}%
                    </span>
                  )}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => openEdit(p)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label="Editar"
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => del(p)}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-red-300"
                  aria-label="Eliminar"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <ProfessionalModal open={modalOpen} onOpenChange={setModalOpen} professional={editing} />
    </div>
  );
}
