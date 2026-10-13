"use client";

import { CloudOff } from "lucide-react";
import { useArcaStatus } from "@/modules/arca/hooks";

// Aviso del POS (ADR-072): sólo cuando ARCA no responde y se está facturando
// en contingencia (CAEA). Nunca bloquea: la venta se cobra igual. Sin la
// facturación activa (o sin las tablas) no muestra nada.
export function ArcaPosIndicator() {
  const { data } = useArcaStatus();
  if (!data?.enabled || !data.contingency) return null;
  return (
    <div
      role="status"
      className="mx-3 mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 md:mx-4"
    >
      <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-warning/15 text-warning">
        <CloudOff size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">ARCA no responde: facturando en contingencia</span>
        <span className="block truncate text-xs text-muted-foreground">
          Seguí vendiendo normal. Las facturas salen con CAEA y se informan a ARCA cuando vuelva.
        </span>
      </span>
    </div>
  );
}
ArcaPosIndicator.displayName = "ArcaPosIndicator";
