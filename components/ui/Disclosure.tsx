"use client";

// H9b PR7 — Disclosure: reemplazo lindo de los <details>/<summary> nativos.
// Botón con chevron que rota 180° al abrir + slot de ícono (HelpCircle por
// defecto en la variante "help"). Controlado o no controlado. type="button"
// para no disparar submits dentro de forms.
import { useState, type ReactNode } from "react";
import { ChevronDown, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface Props {
  title: ReactNode;
  children: ReactNode;
  // "help" usa HelpCircle por defecto y texto acentuado en flame.
  variant?: "default" | "help";
  icon?: ReactNode;
  defaultOpen?: boolean;
  // Modo controlado (opcional): si se pasa `open`, el componente no maneja estado.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Disclosure({
  title,
  children,
  variant = "default",
  icon,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }

  const leadingIcon =
    icon ?? (variant === "help" ? <HelpCircle size={15} /> : null);

  return (
    <div className={cn("rounded-lg border border-border bg-muted/30", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-muted/50",
          variant === "help" ? "text-ninja-flameSoft" : "text-muted-foreground",
        )}
      >
        {leadingIcon && <span className="shrink-0">{leadingIcon}</span>}
        <span className="min-w-0 flex-1 font-medium">{title}</span>
        <ChevronDown
          size={16}
          className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-3 text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
