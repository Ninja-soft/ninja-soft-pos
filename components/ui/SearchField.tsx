"use client";

import { forwardRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";

// Buscador estilo iOS: campo con RELLENO tonal (sin borde ni glow de color),
// lupa a la izquierda, spinner o botón de limpiar a la derecha.
export interface SearchFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "size"> {
  value: string;
  onValueChange: (v: string) => void;
  loading?: boolean;
  size?: "md" | "lg";
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  ({ value, onValueChange, loading, size = "md", className, ...props }, ref) => (
    <div className={cn("relative w-full", className)}>
      <Search
        size={size === "lg" ? 19 : 17}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "w-full rounded-xl border-0 bg-muted pl-11 pr-11 text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)] [&::-webkit-search-cancel-button]:hidden",
          size === "lg" ? "h-12 text-[15px]" : "h-11 text-sm",
        )}
        {...props}
      />
      {/* Zona derecha del mismo ancho que el padding (pr-11): spinner y botón
          quedan centrados en vertical y horizontal, en el eje de la lupa. */}
      <span className="absolute inset-y-0 right-0 flex w-11 items-center justify-center">
        {loading ? (
          <Spinner size={17} className="block" />
        ) : value ? (
          <button
            type="button"
            onClick={() => onValueChange("")}
            className="grid h-6 w-6 place-items-center rounded-full bg-secondary text-foreground transition hover:bg-muted"
            aria-label="Limpiar búsqueda"
          >
            <X size={13} />
          </button>
        ) : null}
      </span>
    </div>
  ),
);
SearchField.displayName = "SearchField";
