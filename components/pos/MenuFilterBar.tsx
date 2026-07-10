"use client";

import { Clock } from "lucide-react";
import type { Menu } from "@/modules/menus/api";

// F13 · H47 — Barra de filtro por menú en el POS. Cuando el negocio tiene menús
// por horario (daypart), el cajero puede filtrar la carta a un menú (Desayuno,
// Almuerzo, Happy hour…). El menú VIGENTE ahora se marca con "● ahora" para que
// se vea de un toque. Default "Todos" (no esconde nada salvo que el cajero elija
// un menú); seleccionar un menú deja sólo sus productos asignados.
export function MenuFilterBar({
  menus,
  activeIds,
  selected,
  onSelect,
}: {
  menus: Menu[];
  activeIds: Set<string>;
  selected: string | null;
  onSelect: (menuId: string | null) => void;
}) {
  if (menus.length === 0) return null;

  return (
    <div className="slim-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Menú
      </span>
      <Chip label="Todos" active={selected === null} onClick={() => onSelect(null)} />
      {menus.map((m) => {
        const isNow = activeIds.has(m.id);
        return (
          <Chip
            key={m.id}
            label={m.name}
            active={selected === m.id}
            now={isNow}
            onClick={() => onSelect(m.id)}
          />
        );
      })}
    </div>
  );
}

function Chip({
  label,
  active,
  now,
  onClick,
}: {
  label: string;
  active: boolean;
  now?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex shrink-0 items-center gap-1.5 rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-semibold text-ninja-flameSoft"
          : "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      }
    >
      {label}
      {now && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-bold text-success"
          title="Menú vigente ahora"
        >
          <Clock size={9} /> ahora
        </span>
      )}
    </button>
  );
}
