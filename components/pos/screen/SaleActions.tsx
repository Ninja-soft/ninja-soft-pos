"use client";

import { Eraser, Pause } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { POS_QUIET } from "../ui/posStyles";

// "Pausar" y "Limpiar" la venta en curso (ADR-106). Texto visible (no sólo
// ícono), 44 px, relleno neutro. Reemplaza al tachito chico del encabezado del
// carrito: limpiar ahora siempre pide confirmación y se puede deshacer.

export function SaleActions({
  disabled,
  pauseBlocked,
  onPause,
  onClear,
  compact = false,
}: {
  disabled: boolean;
  /** Motivo por el que no se puede pausar (mesa, delivery...). */
  pauseBlocked?: string | null;
  onPause: () => void;
  onClear: () => void;
  compact?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Venta en curso">
      <button
        type="button"
        disabled={disabled || Boolean(pauseBlocked)}
        onClick={onPause}
        title={pauseBlocked ?? "Guardar la venta y atender a otro cliente (Shift + F8)"}
        aria-keyshortcuts="Shift+F8 Pause"
        className={cn(
          "flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] font-semibold",
          POS_QUIET,
        )}
      >
        <Pause size={16} aria-hidden className="shrink-0" />
        <span className="truncate">Pausar</span>
        {!compact && (
          <kbd className="hidden rounded bg-fg-10 px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground xl:inline">
            ⇧F8
          </kbd>
        )}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        title="Vaciar la venta en curso (Shift + F4)"
        aria-keyshortcuts="Shift+F4"
        className={cn(
          "flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] font-semibold hover:!bg-danger/15 hover:text-danger",
          POS_QUIET,
        )}
      >
        <Eraser size={16} aria-hidden className="shrink-0" />
        <span className="truncate">Limpiar</span>
        {!compact && (
          <kbd className="hidden rounded bg-fg-10 px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground xl:inline">
            ⇧F4
          </kbd>
        )}
      </button>
    </div>
  );
}
