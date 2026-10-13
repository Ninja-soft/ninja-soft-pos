"use client";

import { useState } from "react";
import { Bookmark, Star, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import {
  MAX_PRESET_NAME,
  MAX_PRESETS,
  RANGE_PRESET_LABELS,
  type ReportFilters,
  type ReportPreset,
  type ReportPresetState,
} from "@/lib/reports/savedFilters";

// Filtros guardados de Reportes (TX-5 · ADR-100): el usuario guarda la
// combinación actual (rango, sucursal, medio, categoría) con un nombre, la
// aplica con un toque y elige una como predeterminada al abrir Reportes.
// Viven en users.settings: lo mismo en cualquier dispositivo.

export function describeFilters(
  f: ReportFilters,
  names: {
    store: (id: string) => string | null;
    method: (k: string) => string;
    category: (id: string) => string | null;
  },
): string {
  const parts: string[] = [
    f.range === "custom" && f.from
      ? `${f.from}${f.to && f.to !== f.from ? ` al ${f.to}` : ""}`
      : RANGE_PRESET_LABELS[f.range],
  ];
  if (f.storeId) parts.push(names.store(f.storeId) ?? "Sucursal");
  if (f.method) parts.push(names.method(f.method));
  if (f.categoryId) parts.push(names.category(f.categoryId) ?? "Categoría");
  return parts.join(" · ");
}

export function ReportPresetsModal({
  open,
  onOpenChange,
  state,
  current,
  describe,
  onApply,
  onSave,
  onDelete,
  onSetDefault,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  state: ReportPresetState;
  current: ReportFilters;
  describe: (f: ReportFilters) => string;
  onApply: (p: ReportPreset) => void;
  onSave: (name: string) => string | null;
  onDelete: (id: string) => void;
  onSetDefault: (id: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = state.presets.length >= MAX_PRESETS;

  function save(e: React.FormEvent) {
    e.preventDefault();
    const err = onSave(name);
    if (err) {
      setError(err);
      return;
    }
    setName("");
    setError(null);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Filtros guardados"
      description="Guardá el período y los filtros que más usás. El predeterminado se aplica al abrir Reportes."
    >
      <form onSubmit={save} className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Ahora: <span className="text-foreground">{describe(current)}</span>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Input
            aria-label="Nombre del filtro"
            placeholder="Ej.: Efectivo del mes"
            value={name}
            maxLength={MAX_PRESET_NAME}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            error={error ?? undefined}
          />
          <Button type="submit" disabled={!name.trim()} className="shrink-0">
            <Bookmark size={16} /> Guardar
          </Button>
        </div>
        {full && (
          <p className="text-xs text-muted-foreground">
            Tenés {MAX_PRESETS} guardados: con el mismo nombre se actualiza uno
            existente.
          </p>
        )}
      </form>

      <div className="mt-5">
        {state.presets.length === 0 ? (
          <EmptyState
            compact
            icon={Bookmark}
            title="Todavía no guardaste filtros"
            description="Elegí período, sucursal, medio o categoría y guardalos con un nombre."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {state.presets.map((p) => {
              const isDefault = state.defaultId === p.id;
              return (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => onApply(p)}
                    className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-sm font-medium">
                      {p.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {describe(p.filters)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetDefault(isDefault ? null : p.id)}
                    aria-pressed={isDefault}
                    aria-label={
                      isDefault
                        ? `Quitar ${p.name} como predeterminado`
                        : `Usar ${p.name} al abrir Reportes`
                    }
                    title={
                      isDefault ? "Predeterminado" : "Usar al abrir Reportes"
                    }
                    className={cn(
                      "grid h-9 w-9 shrink-0 place-items-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isDefault ? "text-ninja-gold" : "text-muted-foreground",
                    )}
                  >
                    <Star
                      size={16}
                      strokeWidth={1.75}
                      fill={isDefault ? "currentColor" : "none"}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    aria-label={`Eliminar ${p.name}`}
                    title="Eliminar"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 size={16} strokeWidth={1.75} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
