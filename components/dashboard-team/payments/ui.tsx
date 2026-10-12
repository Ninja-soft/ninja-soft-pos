"use client";

import { Check, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { paymentIcon, paymentIconFullBleed, paymentWordmark } from "@/lib/payments/logos";
import type { Env } from "./types";

// Isotipo cuadrado del medio (los canales Point usan el de su marca).
export function BrandLogo({
  brandKey,
  name,
  size = 44,
  muted = false,
  className,
}: {
  brandKey: string;
  name: string;
  size?: number;
  muted?: boolean;
  className?: string;
}) {
  const src = paymentIcon(brandKey);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[22%] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.06)]",
        muted && "opacity-55 grayscale",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          className={cn("h-full w-full", paymentIconFullBleed(brandKey) ? "object-cover" : "object-contain p-[16%]")}
          draggable={false}
        />
      ) : (
        <CreditCard size={size * 0.45} className="text-neutral-500" />
      )}
    </span>
  );
}

// Logo horizontal sobre placa clara (legible en los 4 temas).
export function BrandWordmark({
  brandKey,
  name,
  className,
}: {
  brandKey: string;
  name: string;
  className?: string;
}) {
  const src = paymentWordmark(brandKey);
  if (!src) return <BrandLogo brandKey={brandKey} name={name} size={56} />;
  return (
    <span
      className={cn(
        "inline-flex h-16 items-center justify-center rounded-2xl bg-white px-6 shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_1px_rgba(0,0,0,0.05)]",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={name} className="max-h-9 w-auto max-w-[180px] object-contain" draggable={false} />
    </span>
  );
}

export type StatusTone = "ok" | "test" | "idle" | "soon" | "locked";

const TONE: Record<StatusTone, string> = {
  ok: "bg-success/10 text-success",
  test: "bg-warning/15 text-warning",
  idle: "bg-muted text-muted-foreground",
  soon: "bg-muted text-muted-foreground",
  locked: "bg-ninja-flame/10 text-ninja-flameSoft",
};

const DOT: Record<StatusTone, string> = {
  ok: "bg-success",
  test: "bg-warning",
  idle: "bg-[color-mix(in_srgb,var(--muted-foreground)_50%,transparent)]",
  soon: "bg-[color-mix(in_srgb,var(--muted-foreground)_40%,transparent)]",
  locked: "bg-ninja-flameSoft",
};

export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT[tone])} aria-hidden />
      {children}
    </span>
  );
}

// Selector de ambiente estilo iOS: pista gris, segmento activo relleno.
// Sin bordes ni anillos de color (pedido del dueño).
export function EnvSegmented({
  value,
  onChange,
  disabledTest = false,
  testHint,
}: {
  value: Env;
  onChange: (v: Env) => void;
  disabledTest?: boolean;
  testHint?: string;
}) {
  const opts: { v: Env; title: string; sub: string; dot: string }[] = [
    { v: "prod", title: "Producción", sub: "Cobros reales", dot: "bg-success" },
    { v: "test", title: "Prueba", sub: testHint ?? "Sin plata real", dot: "bg-warning" },
  ];
  return (
    <div role="radiogroup" aria-label="Ambiente" className="grid grid-cols-2 gap-1 rounded-xl bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] p-1">
      {opts.map((o) => {
        const active = value === o.v;
        const disabled = o.v === "test" && disabledTest;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-[10px] px-3 py-2 text-center transition-all duration-200 focus-visible:outline-none",
              active
                ? "bg-foreground text-background shadow-[0_1px_3px_rgba(0,0,0,0.18)]"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <span className={cn("h-1.5 w-1.5 rounded-full", active ? o.dot : "bg-[color-mix(in_srgb,var(--muted-foreground)_40%,transparent)]")} />
              {o.title}
            </span>
            <span className="text-[11px] leading-tight opacity-80">{o.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

// Stepper horizontal: círculos numerados rellenos (sin anillos).
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Pasos">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors",
                done && "bg-success text-white",
                active && "bg-foreground text-background",
                !done && !active && "bg-muted text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <Check size={13} strokeWidth={3} /> : i + 1}
            </span>
            <span
              className={cn(
                "truncate text-xs font-medium",
                active ? "text-foreground" : "hidden text-muted-foreground sm:inline",
              )}
            >
              {label}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn("h-px min-w-3 flex-1", done ? "bg-success/60" : "bg-border")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// Encabezado de sección dentro de un modal / detalle.
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </div>
  );
}
