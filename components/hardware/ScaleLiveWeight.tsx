"use client";

import { useEffect, useRef } from "react";
import { Scale } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { RegisterHardware } from "@/lib/hardware/config";
import { formatKg, weightUsable } from "@/lib/hardware/scale/stable";
import { useScaleReader } from "@/modules/hardware/hooks";

// Peso en vivo de la balanza de la caja dentro del editor de peso del POS
// (ADR-063). Con el peso estable completa los gramos solo; el cajero puede
// igual tipearlos (la balanza nunca traba la venta).

export function ScaleLiveWeight({
  hw,
  active,
  onStableGrams,
}: {
  hw: RegisterHardware;
  active: boolean;
  onStableGrams: (grams: number) => void;
}) {
  const scale = useScaleReader(hw.scale, hw.registerId, active);
  const lastSent = useRef<number | null>(null);
  const r = scale.reading;
  const usable = r ? weightUsable(r.netKg, r.stable) : false;

  useEffect(() => {
    if (!active) lastSent.current = null;
  }, [active]);
  useEffect(() => {
    if (!r || !usable) return;
    const g = Math.round(r.netKg * 1000);
    if (lastSent.current === g) return;
    lastSent.current = g;
    onStableGrams(g);
  }, [r, usable]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-lg bg-muted/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Scale size={13} aria-hidden /> Balanza {hw.scale.model ? `(${hw.scale.model})` : ""}
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium",
            usable ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
          aria-live="polite"
        >
          {scale.status === "connecting"
            ? "Conectando"
            : scale.status === "error"
              ? "Sin conexión"
              : !r
                ? "Esperando peso"
                : usable
                  ? "Estable"
                  : r.netKg <= 0
                    ? "Apoyá el producto"
                    : "Esperá que se quede quieto"}
        </span>
      </div>
      <p className="mt-1 font-mono text-3xl font-semibold tabular-nums" aria-label="Peso en la balanza">
        {r ? formatKg(r.netKg) : "-"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={scale.tareNow}
          disabled={!r}
          className="h-9 rounded-md bg-fg-6 px-3 text-[13px] font-semibold transition-colors hover:bg-fg-10 disabled:opacity-50"
        >
          Tara
        </button>
        {r && r.tareKg > 0 && (
          <button
            type="button"
            onClick={scale.clearTare}
            className="h-9 rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Quitar tara ({formatKg(r.tareKg)})
          </button>
        )}
        {scale.simulate &&
          [0.35, 1.25].map((kg) => (
            <button
              key={kg}
              type="button"
              onClick={() => scale.simulate?.(kg)}
              className="h-9 rounded-md px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Simular {kg} kg
            </button>
          ))}
      </div>
      {(scale.error || scale.silent) && (
        <p className="mt-1.5 text-xs text-danger">
          {scale.error ?? "La balanza no manda datos."} Podés tipear el peso.
        </p>
      )}
    </div>
  );
}
