import { forwardRef } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Selección premium (regla de marca, globals.css → .choice-on/.choice-check):
// relleno neutro elevado, texto de primer plano e insignia de check con el
// fuego Ninja en la esquina. Nunca borde/ring de color ni tinte de marca.
//   check: false → sin insignia (pastillas compactas o cuando ya hay ChoiceDot).
export function choiceClass(selected: boolean, extra?: string, { check = true }: { check?: boolean } = {}) {
  return cn(
    "relative rounded-xl border text-left transition [&>svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    selected ? cn("choice-on", check && "choice-check") : "border-border bg-card hover:bg-muted",
    extra,
  );
}

/** Clases de selección para pastillas compactas (sin insignia). */
export const CHOICE_ON = "choice-on";
/** Clases de selección para cards con título/bajada (con insignia de check). */
export const CHOICE_ON_CHECK = "choice-on choice-check";

/** Indicador de radio/selección: círculo sólido de marca al activarse. */
export function ChoiceDot({
  selected,
  multiple = false,
  className,
}: {
  selected: boolean;
  multiple?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-[18px] w-[18px] shrink-0 place-items-center transition",
        multiple ? "rounded-md" : "rounded-full",
        selected
          ? "bg-[var(--pos-solid)] text-white"
          : "border border-muted-foreground/40 bg-background",
        className,
      )}
    >
      {selected &&
        (multiple ? (
          <Check size={12} strokeWidth={3} />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
        ))}
    </span>
  );
}

export interface ChoiceCardProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  selected: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Muestra el indicador de radio a la izquierda. */
  indicator?: boolean;
}

// Tarjeta de opción (radio visual). Para pickers de 2 a 6 opciones con
// título y bajada; para opciones cortas, usar <Segmented />.
export const ChoiceCard = forwardRef<HTMLButtonElement, ChoiceCardProps>(
  (
    { selected, icon, title, description, indicator = false, className, children, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      className={choiceClass(selected, cn("flex w-full items-start gap-3 p-3.5", !indicator && "pr-9", className), {
        check: !indicator,
      })}
      {...props}
    >
      {indicator && <ChoiceDot selected={selected} className="mt-0.5" />}
      {icon && (
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition",
            selected ? "bg-[var(--seg-thumb)] text-foreground shadow-[var(--seg-thumb-shadow)]" : "bg-muted text-muted-foreground",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        )}
        {children}
      </span>
    </button>
  ),
);
ChoiceCard.displayName = "ChoiceCard";
