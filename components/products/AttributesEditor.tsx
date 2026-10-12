"use client";

import { Plus, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ATTRIBUTE_SUGGESTIONS, type ProductAttribute } from "@/lib/products/attributes";

const field =
  "h-10 w-full min-w-0 rounded-lg border-0 bg-muted px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]";

// Atributos libres (clave / valor), en filas tipo lista agrupada iOS. Con
// sugerencias rápidas de claves comunes que todavía no se usaron.
export function AttributesEditor({
  value,
  onChange,
  compact = false,
}: {
  value: ProductAttribute[];
  onChange: (next: ProductAttribute[]) => void;
  compact?: boolean;
}) {
  const used = new Set(value.map((a) => a.key.trim().toLowerCase()));
  const suggestions = ATTRIBUTE_SUGGESTIONS.filter((s) => !used.has(s.toLowerCase())).slice(
    0,
    compact ? 4 : 8,
  );
  const update = (i: number, patch: Partial<ProductAttribute>) =>
    onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        !compact && (
          <div className="rounded-2xl bg-muted">
            <EmptyState
              compact
              icon={Tag}
              title="Sin atributos"
              description="Sumá datos como color, talle, material o contenido. Se ven en la ficha y ayudan a buscar."
            />
          </div>
        )
      ) : (
        <ul className="space-y-2">
          {value.map((a, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                value={a.key}
                onChange={(e) => update(i, { key: e.target.value.slice(0, 60) })}
                placeholder="Atributo"
                aria-label="Atributo"
                className={`${field} max-w-[42%] font-medium`}
              />
              <input
                value={a.value}
                onChange={(e) => update(i, { value: e.target.value.slice(0, 200) })}
                placeholder="Valor"
                aria-label="Valor"
                className={field}
              />
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Quitar atributo"
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange([...value, { key: s, value: "" }])}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Plus size={12} /> {s}
          </button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-full px-3 text-xs"
          onClick={() => onChange([...value, { key: "", value: "" }])}
        >
          <Plus size={13} /> Otro
        </Button>
      </div>
    </div>
  );
}
AttributesEditor.displayName = "AttributesEditor";
