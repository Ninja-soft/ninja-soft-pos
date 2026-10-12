"use client";

import { forwardRef, useId, useState } from "react";
import { AlertCircle, Check, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface CredentialInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Campo secreto: se oculta y suma el botón mostrar/ocultar. */
  secret?: boolean;
  optional?: boolean;
  /** Ya hay un valor guardado del lado del servidor (no se muestra). */
  configured?: boolean;
  configuredLabel?: string;
  hint?: React.ReactNode;
  error?: string;
  /** Tipografía monoespaciada (claves, tokens, IDs). */
  mono?: boolean;
}

// Campo de credencial (API keys, tokens, contraseñas de aplicación).
//   · "configurada": chip relleno con check en vez de puntos en el placeholder.
//   · Error inline: pista rellena con ícono, sin borde rojo.
//   · Foco neutro: sin borde ni anillo de color (regla de marca).
export const CredentialInput = forwardRef<HTMLInputElement, CredentialInputProps>(
  (
    {
      label,
      secret = false,
      optional = false,
      configured = false,
      configuredLabel = "Guardada",
      hint,
      error,
      mono = false,
      type = "text",
      id,
      className,
      ...props
    },
    ref,
  ) => {
    const auto = useId();
    const inputId = id ?? auto;
    const [show, setShow] = useState(false);
    const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
    return (
      <div className="w-full">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor={inputId} className="text-[13px] font-semibold text-foreground">
            {label}
            {optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">Opcional</span>}
          </label>
          {configured && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
              <Check size={11} strokeWidth={3} /> {configuredLabel}
            </span>
          )}
        </div>
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            type={secret ? (show ? "text" : "password") : type}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              "h-11 w-full rounded-xl border border-transparent bg-fg-6 px-3.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/80",
              "focus:bg-[var(--background)] focus:shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_22%,transparent)]",
              mono && "font-mono text-[13px] tracking-tight placeholder:font-sans placeholder:text-sm placeholder:tracking-normal",
              secret && "pr-11",
              className,
            )}
            {...props}
          />
          {secret && (
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? `Ocultar ${label}` : `Mostrar ${label}`}
              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition hover:bg-fg-6 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
        {error ? (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs font-medium text-danger"
          >
            <AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
CredentialInput.displayName = "CredentialInput";
