"use client";

import { ClipboardList, Eraser, Lock, Pause } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { POS_QUIET } from "../ui/posStyles";

// "Pausar" y "Limpiar" la venta en curso (ADR-106). Texto visible (no sólo
// ícono), 44 px, relleno neutro. Reemplaza al tachito chico del encabezado del
// carrito: limpiar ahora siempre pide confirmación y se puede deshacer.
// H32 (ADR-129): "Pedido" al lado, para que el vendedor deje el carrito como
// pedido de salón y lo cobre la caja (con candado si el plan no lo incluye).

export function SaleActions({
  disabled,
  pauseBlocked,
  onPause,
  onClear,
  onOrder,
  orderLocked = false,
  orderBlocked = null,
  compact = false,
}: {
  disabled: boolean;
  /** Motivo por el que no se puede pausar (mesa, delivery...). */
  pauseBlocked?: string | null;
  onPause: () => void;
  onClear: () => void;
  /** Guardar como pedido de salón (sin la prop, el botón no aparece). */
  onOrder?: () => void;
  orderLocked?: boolean;
  /** Motivo por el que no se puede guardar como pedido (mesa, reserva...). */
  orderBlocked?: string | null;
  compact?: boolean;
}) {
  return (
    <div className={cn("grid gap-1.5", onOrder ? "grid-cols-3" : "grid-cols-2")} role="group" aria-label="Venta en curso">
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
      {onOrder && (
        <button
          type="button"
          disabled={disabled || Boolean(orderBlocked)}
          onClick={onOrder}
          title={
            orderBlocked ??
            (orderLocked
              ? "Pedidos de salón: función no incluida en tu plan"
              : "Guardar como pedido para que lo cobre la caja (reserva el stock)")
          }
          className={cn(
            "flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-[13px] font-semibold",
            POS_QUIET,
          )}
        >
          {orderLocked ? (
            <Lock size={16} aria-hidden className="shrink-0 text-muted-foreground" />
          ) : (
            <ClipboardList size={16} aria-hidden className="shrink-0" />
          )}
          <span className="truncate">Pedido</span>
        </button>
      )}
    </div>
  );
}
