import { forwardRef, useId } from "react";
import { cn } from "@/lib/utils/cn";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  /**
   * "filled": relleno tonal estilo iOS, sin borde ni glow de color al enfocar
   * (formularios densos, Tiendita, ficha de producto). Default: "outline".
   */
  variant?: "outline" | "filled";
}

// Input con label y error inline. Ver UI-NinjaSof.md §19, §31.
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, variant = "outline", ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const describedBy = error
      ? `${inputId}-error`
      : hint
        ? `${inputId}-hint`
        : undefined;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className={cn(
              "block font-medium text-muted-foreground",
              variant === "filled" ? "mb-1.5 text-xs" : "mb-2 text-sm",
            )}
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            variant === "filled"
              ? "h-11 w-full rounded-xl border-0 bg-muted px-3.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)] disabled:opacity-60"
              : "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20",
            error &&
              (variant === "filled"
                ? "bg-destructive/10"
                : "border-destructive focus:border-destructive"),
            className,
          )}
          {...props}
        />
        {error ? (
          <p id={`${inputId}-error`} className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p
            id={`${inputId}-hint`}
            className="mt-2 text-sm text-muted-foreground"
          >
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";
