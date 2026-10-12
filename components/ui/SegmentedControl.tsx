"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  /** Nombre accesible del grupo (radiogroup). */
  ariaLabel: string;
  size?: "sm" | "md";
  /** En mobile muestra sólo íconos (la etiqueta queda para lectores). */
  iconOnlyOnMobile?: boolean;
  className?: string;
}

/**
 * Control segmentado estilo iOS: riel neutro con un "pulgar" relleno que se
 * desliza al segmento activo. Segmentos de igual ancho, sin bordes de color.
 * Accesible como radiogroup: flechas / Inicio / Fin mueven la selección.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  iconOnlyOnMobile = false,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = options.length;
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function select(i: number) {
    const next = options[(i + n) % n];
    if (!next) return;
    onChange(next.value);
    refs.current[(i + n) % n]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(index + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      select(0);
    } else if (e.key === "End") {
      e.preventDefault();
      select(n - 1);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "relative inline-grid shrink-0 rounded-[10px] bg-[var(--seg-track)] p-[3px]",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-[3px] left-[3px] top-[3px] rounded-[7px] bg-[var(--seg-thumb)] shadow-[var(--seg-thumb-shadow)] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 6px) / ${n})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((o, i) => {
        const active = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            title={iconOnlyOnMobile ? o.label : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon && (
              <span aria-hidden="true" className="flex shrink-0">
                {o.icon}
              </span>
            )}
            <span className={cn("truncate", iconOnlyOnMobile && o.icon && "sr-only sm:not-sr-only")}>
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
