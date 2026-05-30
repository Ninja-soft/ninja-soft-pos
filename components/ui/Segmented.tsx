"use client";

import { cn } from "@/lib/utils/cn";

interface Option<T extends string> {
  value: T;
  label: string;
  preview?: React.ReactNode;
}

// Control segmentado: pills con indicador del valor activo.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex flex-wrap gap-1 rounded-xl border border-border bg-muted/50 p-1",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              active
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.preview ?? o.label}
          </button>
        );
      })}
    </div>
  );
}
