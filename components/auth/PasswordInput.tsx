"use client";

import { forwardRef, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  error?: string;
  hint?: string;
  /** Contenido alineado a la derecha del label (p. ej. "¿Olvidaste tu contraseña?"). */
  labelAside?: React.ReactNode;
}

// Campo de contraseña con botón "mostrar/ocultar". Mismo estilo que <Input>
// (outline, foco flama, error en rojo con aria-describedby) para usarse junto a
// él en las pantallas de auth. Nunca se precarga: el valor lo maneja el form.
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, label, error, hint, labelAside, id, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const [visible, setVisible] = useState(false);
    const describedBy = error
      ? `${inputId}-error`
      : hint
        ? `${inputId}-hint`
        : undefined;

    return (
      <div className="w-full">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-muted-foreground"
          >
            {label}
          </label>
          {labelAside}
        </div>
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            type={visible ? "text" : "password"}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            spellCheck={false}
            autoCapitalize="none"
            className={cn(
              "h-11 w-full rounded-lg border border-input bg-background pl-4 pr-12 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20",
              error && "border-destructive focus:border-destructive",
              className,
            )}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
            aria-pressed={visible}
            aria-controls={inputId}
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-muted-foreground outline-none transition hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
          </button>
        </div>
        {error ? (
          <p id={`${inputId}-error`} className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-2 text-sm text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
