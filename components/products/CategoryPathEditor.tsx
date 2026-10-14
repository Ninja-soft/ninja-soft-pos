"use client";

import { ChevronDown, CornerDownRight, FolderTree, Plus, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import {
  MAX_CATEGORY_DEPTH,
  childrenOf,
  formatCategoryPath,
  levelLabel,
  normalizeNodes,
  type CategoryLike,
  type CategoryNode,
} from "@/lib/products/categoryPath";

const NEW = "__new__";
const control =
  "h-10 w-full min-w-0 rounded-lg border-0 bg-card px-3 text-sm text-foreground outline-none transition focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

// Árbol de jerarquía editable: rubro > categoría > subcategoría... Cada nivel
// se mapea a una categoría existente del negocio (elegida de las hijas del
// nivel de arriba) o se crea nueva con el nombre que pongas.
export function CategoryPathEditor({
  value,
  onChange,
  categories,
  source,
  onRestore,
}: {
  value: CategoryNode[];
  onChange: (next: CategoryNode[]) => void;
  categories: CategoryLike[];
  /** Ruta original (p. ej. la del catálogo) para mostrar "Restaurar". */
  source?: string | null;
  onRestore?: () => void;
}) {
  const commit = (next: CategoryNode[]) => onChange(next);

  function setNode(i: number, node: CategoryNode) {
    // Cambiar un nivel invalida los de abajo que eran existentes de otra rama:
    // normalizeNodes los pasa a "nuevos" con el mismo nombre.
    const next = value.map((n, j) => (j === i ? node : n));
    commit(normalizeNodes(next, categories));
  }

  function removeLevel(i: number) {
    commit(normalizeNodes(value.filter((_, j) => j !== i), categories));
  }

  function addLevel() {
    if (value.length >= MAX_CATEGORY_DEPTH) return;
    commit([...value, { id: null, name: "" }]);
  }

  const preview = formatCategoryPath(value);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted px-3 py-2.5">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <FolderTree size={15} className="shrink-0 text-ninja-flameSoft" aria-hidden />
          <span className={cn("min-w-0 truncate", preview ? "font-medium text-foreground" : "text-muted-foreground")}>
            {preview || "Sin categoría"}
          </span>
        </p>
        {source && onRestore && (
          <button
            type="button"
            onClick={onRestore}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <RotateCcw size={12} /> Restaurar del catálogo
          </button>
        )}
      </div>

      <ol className="space-y-2">
        {value.map((node, i) => {
          const parent = i === 0 ? null : value[i - 1];
          // Si el padre es nuevo, abajo sólo puede haber nodos nuevos.
          const parentId = i === 0 ? null : parent?.id ?? undefined;
          const options = parentId === undefined ? [] : childrenOf(parentId, categories);
          const isNew = !node.id;
          return (
            <li key={i} className="flex items-start gap-2" style={{ paddingLeft: Math.min(i, 4) * 14 }}>
              <span className="mt-2.5 grid h-5 w-5 shrink-0 place-items-center text-muted-foreground" aria-hidden>
                {i === 0 ? <FolderTree size={15} /> : <CornerDownRight size={15} />}
              </span>
              <div className="min-w-0 flex-1 rounded-lg bg-muted p-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {levelLabel(i)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Badge tone={isNew ? "brand" : "success"} className="px-2 text-[10px]">
                      {isNew ? "Nueva" : "Existe"}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => removeLevel(i)}
                      className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      aria-label={`Quitar ${levelLabel(i).toLowerCase()}`}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {options.length > 0 && (
                    <div className="relative sm:w-1/2">
                      <select
                        aria-label={`${levelLabel(i)} existente`}
                        value={node.id ?? NEW}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === NEW) setNode(i, { id: null, name: node.name });
                          else {
                            const c = options.find((o) => o.id === v);
                            if (c) setNode(i, { id: c.id, name: c.name });
                          }
                        }}
                        className={cn(control, "appearance-none pr-9")}
                      >
                        <option value={NEW} className="bg-popover text-popover-foreground">
                          Crear nueva
                        </option>
                        {options.map((o) => (
                          <option key={o.id} value={o.id} className="bg-popover text-popover-foreground">
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={15}
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                      />
                    </div>
                  )}
                  {isNew && (
                    <input
                      value={node.name}
                      onChange={(e) => {
                        // Tipear sobre un nodo nuevo no re-normaliza (no "salta"
                        // a una existente mientras escribís); se resuelve al guardar.
                        const next = value.map((n, j) =>
                          j === i ? { id: null, name: e.target.value.slice(0, 80) } : n,
                        );
                        commit(next);
                      }}
                      placeholder={`Nombre de la ${levelLabel(i).toLowerCase()}`}
                      aria-label={`Nombre de ${levelLabel(i).toLowerCase()}`}
                      className={cn(control, options.length > 0 && "sm:w-1/2")}
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {value.length < MAX_CATEGORY_DEPTH && (
        <button
          type="button"
          onClick={addLevel}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <Plus size={13} />
          {value.length === 0 ? "Agregar rubro" : `Agregar ${levelLabel(value.length).toLowerCase()}`}
        </button>
      )}
    </div>
  );
}
CategoryPathEditor.displayName = "CategoryPathEditor";
