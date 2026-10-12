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
    <div
      className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label="Menú"
    >
      <span className="shrink-0 pr-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
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
      aria-pressed={active}
      className={
        active
          ? "flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-fg-10 px-3 text-[13px] font-semibold text-foreground"
          : "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
      }
    >
      {label}
      {now && (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success"
          title="Menú vigente ahora"
        >
          <Clock size={12} aria-hidden /> ahora
        </span>
      )}
    </button>
  );
}
