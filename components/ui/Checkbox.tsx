"use client";

import { forwardRef } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export type CheckboxState = boolean | "indeterminate";

export interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  checked: CheckboxState;
  onCheckedChange?: (next: boolean) => void;
  /** Muestra un spinner liviano mientras se guarda (no cambia el estado). */
  busy?: boolean;
}

// Checkbox accesible del sistema (role="checkbox", aria-checked mixto).
// Selección neutra: relleno de primer plano con el tilde en el color de fondo,
// sin color de marca ni sombra. 16px con área táctil de 32px vía padding del
// contenedor que lo usa.
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ checked, onCheckedChange, busy, disabled, className, ...props }, ref) => {
    const on = checked === true;
    const mixed = checked === "indeterminate";
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={mixed ? "mixed" : on}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!on)}
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          on || mixed
            ? "border-foreground bg-foreground text-background"
            : "border-muted-foreground/45 bg-background hover:border-foreground/70",
          disabled && "cursor-not-allowed opacity-45 hover:border-muted-foreground/45",
          busy && "animate-pulse",
          className,
        )}
        {...props}
      >
        {on ? <Check size={12} strokeWidth={3} aria-hidden /> : mixed ? <Minus size={12} strokeWidth={3} aria-hidden /> : null}
      </button>
    );
  },
);
Checkbox.displayName = "Checkbox";
