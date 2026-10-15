"use client";

import { Minus, Plus } from "lucide-react";
import { formatQty } from "@/lib/utils/format";

// Cantidad con − y + (botones de 40 px para el dedo). El tope lo da el
// disponible del servidor.
export function QtyStepper({
  value,
  max,
  onChange,
  step = 1,
  label,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  step?: number;
  label: string;
}) {
  const btn =
    "grid h-10 w-10 place-items-center rounded-lg text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white" role="group" aria-label={label}>
      <button type="button" className={btn} onClick={() => onChange(Math.max(0, value - step))} aria-label="Restar uno">
        <Minus size={16} aria-hidden />
      </button>
      <span className="min-w-[2.5rem] text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {formatQty(value)}
      </span>
      <button
        type="button"
        className={btn}
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value + step > max}
        aria-label="Sumar uno"
      >
        <Plus size={16} aria-hidden />
      </button>
    </div>
  );
}
