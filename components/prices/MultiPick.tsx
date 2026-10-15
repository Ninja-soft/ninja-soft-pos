"use client";

import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils/cn";
import { fieldCls } from "@/components/prices/shared";

export interface PickOption {
  id: string;
  name: string;
  /** Nivel en el árbol (categorías): sangría. */
  depth?: number;
}

// Selección múltiple con búsqueda y scroll propio (ADR-140). Sin chips de
// color: el seleccionado se marca con el checkbox neutro del sistema.
export function MultiPick({
  options,
  value,
  onChange,
  placeholder = "Buscar",
  empty = "Sin opciones",
  className,
}: {
  options: PickOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  empty?: string;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.name.toLowerCase().includes(t)) : options;
  }, [options, q]);
  const set = new Set(value);

  function toggle(id: string, on: boolean) {
    const next = new Set(value);
    if (on) next.add(id);
    else next.delete(id);
    onChange([...next]);
  }

  return (
    <div className={cn("rounded-md border border-border", className)}>
      {options.length > 8 && (
        <div className="border-b border-border p-2">
          <input
            className={cn(fieldCls, "h-9")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
          />
        </div>
      )}
      <div className="max-h-44 overflow-y-auto overscroll-contain py-1">
        {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{empty}</p>}
        {shown.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
            style={o.depth ? { paddingLeft: 12 + o.depth * 16 } : undefined}
          >
            <Checkbox checked={set.has(o.id)} onCheckedChange={(v) => toggle(o.id, v)} aria-label={o.name} />
            <span className="min-w-0 truncate">{o.name}</span>
          </label>
        ))}
      </div>
      {value.length > 0 && (
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>{value.length} elegidos</span>
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => onChange([])}>
            Limpiar
          </button>
        </div>
      )}
    </div>
  );
}

/** Categorías en árbol (padre y después sus hijas, con sangría). */
export function categoryTree(rows: { id: string; name: string; parent_id?: string | null }[]): PickOption[] {
  const kids = new Map<string | null, typeof rows>();
  for (const r of rows) {
    const k = r.parent_id ?? null;
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  const out: PickOption[] = [];
  const ids = new Set(rows.map((r) => r.id));
  const walk = (parent: string | null, depth: number) => {
    for (const r of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, "es"))) {
      out.push({ id: r.id, name: r.name, depth });
      if (depth < 8) walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  // Huérfanas (la madre está borrada): al primer nivel.
  for (const r of rows) if (r.parent_id && !ids.has(r.parent_id) && !out.some((o) => o.id === r.id)) {
    out.push({ id: r.id, name: r.name, depth: 0 });
    walk(r.id, 1);
  }
  return out;
}
