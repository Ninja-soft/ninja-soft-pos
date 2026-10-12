"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Reemplaza la etiqueta visible (la `label` queda como título). */
  preview?: ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  /** Nombre accesible del grupo (radiogroup). */
  "aria-label"?: string;
  size?: "sm" | "md";
  /** Estira el control al ancho disponible con segmentos de igual ancho. */
  fill?: boolean;
  /** En mobile muestra sólo íconos (la etiqueta queda para lectores). */
  iconOnlyOnMobile?: boolean;
  className?: string;
}

type Thumb = { x: number; y: number; w: number; h: number };

/**
 * Control segmentado estilo iOS: riel neutro (--seg-track) con un "pulgar"
 * relleno (--seg-thumb) que se desliza al segmento activo. Sin bordes de
 * color. Accesible como radiogroup: flechas / Inicio / Fin mueven la
 * selección. Sin `fill` los segmentos toman su ancho natural y pueden pasar
 * a otra línea; el pulgar se mide sobre el segmento activo.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
  size = "md",
  fill = false,
  iconOnlyOnMobile = false,
  className,
}: SegmentedProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const n = options.length;
  const index = options.findIndex((o) => o.value === value);
  const optionsKey = options.map((o) => `${o.value}:${o.label}`).join("|");

  // Mide el segmento activo (y vuelve a medir si cambia el tamaño del riel:
  // fuentes, wrap, viewport). Hasta medir, el activo pinta su propio fondo.
  useEffect(() => {
    const container = containerRef.current;
    function measure() {
      const el = index >= 0 ? refs.current[index] : null;
      setThumb(
        el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null,
      );
    }
    measure();
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [index, optionsKey]);

  function select(i: number) {
    const j = (i + n) % n;
    const next = options[j];
    if (!next) return;
    onChange(next.value);
    refs.current[j]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const from = Math.max(index, 0);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(from + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(from - 1);
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
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "relative max-w-full gap-1 rounded-xl bg-[var(--seg-track)] p-1",
        fill ? "grid auto-cols-fr grid-flow-col" : "inline-flex flex-wrap",
        className,
      )}
    >
      {thumb && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 rounded-lg bg-[var(--seg-thumb)] shadow-[var(--seg-thumb-shadow)] transition-[transform,width,height] duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: thumb.w,
            height: thumb.h,
            transform: `translate(${thumb.x}px, ${thumb.y}px)`,
          }}
        />
      )}
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
            title={iconOnlyOnMobile || o.preview ? o.label : undefined}
            tabIndex={active || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              size === "sm" ? "min-h-[32px] px-2.5 py-1 text-xs" : "min-h-[36px] px-3 py-1.5 text-sm",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              active && !thumb && "bg-[var(--seg-thumb)] shadow-[var(--seg-thumb-shadow)]",
            )}
          >
            {o.icon && (
              <span aria-hidden="true" className="flex shrink-0">
                {o.icon}
              </span>
            )}
            {o.preview ?? (
              <span className={cn("truncate", iconOnlyOnMobile && o.icon && "sr-only sm:not-sr-only")}>
                {o.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
