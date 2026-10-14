"use client";

import { FileSignature, Lock } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { POS_QUIET } from "@/components/pos/ui/posStyles";

// Botón "Presupuesto" junto a Cobrar (ADR-122): mismo alto que el CTA,
// relleno neutro y etiqueta visible. Sin el plan, candado (abre el upgrade).
export function QuoteCartButton({
  disabled,
  locked,
  onClick,
}: {
  disabled: boolean;
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={locked ? "Presupuestos: función no incluida en tu plan" : "Guardar como presupuesto, sin cobrar ni mover stock"}
      className={cn(
        "flex h-14 w-[5.25rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-semibold",
        POS_QUIET,
      )}
    >
      {locked ? <Lock size={18} aria-hidden className="text-muted-foreground" /> : <FileSignature size={18} aria-hidden />}
      <span className="truncate">Presupuesto</span>
    </button>
  );
}
