"use client";

import { cn } from "@/lib/utils/cn";

interface Option<T extends string> {
  value: T;
  label: string;
  preview?: React.ReactNode;
  icon?: React.ReactNode;
}

// Control segmentado estilo iOS: riel tonal y "thumb" sólido en la opción
// activa. Sin bordes de color. `fill` lo estira al ancho disponible.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  fill = false,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  fill?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "max-w-full gap-1 rounded-xl bg-muted p-1",
        fill ? "grid auto-cols-fr grid-flow-col" : "inline-flex flex-wrap",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "min-h-[32px] px-2.5 py-1 text-xs" : "min-h-[36px] px-3 py-1.5 text-sm",
              active
                ? "bg-card text-foreground shadow-ninjaSoft"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon}
            {o.preview ?? <span className="truncate">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
