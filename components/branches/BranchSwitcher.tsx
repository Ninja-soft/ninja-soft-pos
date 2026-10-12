"use client";

import { Check, ChevronDown, Layers, Store } from "lucide-react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { useBranchContext } from "@/modules/branches/hooks";
import { ALL_BRANCHES, branchLabel, type Branch } from "@/modules/branches/logic";
import { cn } from "@/lib/utils/cn";

// Punto de color de la sucursal (o neutro si no tiene).
export function BranchDot({ branch, className }: { branch: Pick<Branch, "color"> | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/50", className)}
      style={branch?.color ? { background: branch.color } : undefined}
    />
  );
}

// Chip "dónde estoy" del panel (F17 · H90). Sólo aparece si el usuario opera
// en más de una sucursal; con una sola no hay nada que elegir. Filtra ventas,
// caja y reportes que tienen sucursal; elegir una sucursal concreta también la
// deja como sucursal del POS de este dispositivo.
export function BranchSwitcher({ compact = false }: { compact?: boolean }) {
  const ctx = useBranchContext();
  if (!ctx.ready || !ctx.isMulti) return null;

  const current = ctx.filterStore;
  const label = current ? branchLabel(current) : "Todas las sucursales";

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label={`Sucursal: ${label}. Cambiar sucursal`}
          title="Cambiar de sucursal"
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card text-left text-sm transition hover:bg-muted",
            compact ? "h-9 max-w-[46vw] px-2.5" : "h-10 w-full px-3",
          )}
        >
          {current ? <BranchDot branch={current} /> : <Layers size={15} className="shrink-0 text-muted-foreground" aria-hidden />}
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-[248px]">
        <DropdownLabel>Estás viendo</DropdownLabel>
        {ctx.allowed.length > 1 && (
          <DropdownItem onSelect={() => ctx.setSelection(ALL_BRANCHES)}>
            <Layers size={15} className="text-muted-foreground" aria-hidden />
            <span className="flex-1">Todas las sucursales</span>
            {ctx.selection === ALL_BRANCHES && <Check size={14} className="text-ninja-flameSoft" />}
          </DropdownItem>
        )}
        <DropdownSeparator />
        {ctx.allowed.map((b) => (
          <DropdownItem key={b.id} onSelect={() => ctx.setSelection(b.id)}>
            <BranchDot branch={b} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{b.name}</span>
              {(!b.is_active || b.is_default) && (
                <span className="block text-[11px] text-muted-foreground">
                  {!b.is_active ? "Pausada" : "Principal"}
                </span>
              )}
            </span>
            {ctx.filterStoreId === b.id && <Check size={14} className="text-ninja-flameSoft" />}
          </DropdownItem>
        ))}
        {!ctx.canSeeAll && (
          <p className="flex items-start gap-1.5 px-3 pb-1 pt-2 text-[11px] text-muted-foreground">
            <Store size={12} className="mt-0.5 shrink-0" aria-hidden />
            Ves las sucursales donde trabajás.
          </p>
        )}
      </DropdownContent>
    </Dropdown>
  );
}
