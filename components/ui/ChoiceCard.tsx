import { forwardRef } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Selección por relleno (regla de marca): la opción activa se tiñe con flame
// y el borde se vuelve transparente. Nunca borde/ring de color.
export function choiceClass(selected: boolean, extra?: string) {
  return cn(
    "rounded-xl border text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    selected
      ? "border-transparent bg-ninja-flame/[0.12] text-foreground"
      : "border-border bg-card hover:bg-muted",
    extra,
  );
}

/** Indicador de radio/selección: círculo con gradiente de marca al activarse. */
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
          ? "bg-ninja-gradient text-white shadow-ninjaGlow"
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
      className={choiceClass(selected, cn("flex w-full items-start gap-3 p-3.5", className))}
      {...props}
    >
      {indicator && <ChoiceDot selected={selected} className="mt-0.5" />}
      {icon && (
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition",
            selected ? "bg-ninja-flame/15 text-ninja-flameSoft" : "bg-muted text-muted-foreground",
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
      {!indicator && selected && (
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ninja-gradient text-white">
          <Check size={12} strokeWidth={3} />
        </span>
      )}
    </button>
  ),
);
ChoiceCard.displayName = "ChoiceCard";
