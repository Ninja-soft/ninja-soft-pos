"use client";

// Conciliación (ADR-044, ADR-061, ADR-064): un solo hub con el resumen del
// período, Por procesador, Tarjetas por lote y Pendientes de revisar.
// Vistas por URL: ?vista=procesadores|tarjetas|pendientes (&p=<procesador>);
// los avisos de disputas siguen entrando por ?vista=procesadores&filtro=disputas.

import { Suspense } from "react";
import { ConciliacionHub } from "@/components/reports/conciliacion/ConciliacionHub";

export default function ConciliacionPage() {
  return (
    <Suspense fallback={null}>
      <ConciliacionHub />
    </Suspense>
  );
}
