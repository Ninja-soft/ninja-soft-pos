"use client";

// Tesorería > Movimientos (H155, ADR-158). ?mov=<id> resalta un movimiento.
import { Suspense } from "react";
import { MovementsView } from "@/components/treasury/MovementsView";

export default function TesoreriaMovimientosPage() {
  return (
    <Suspense fallback={null}>
      <MovementsView />
    </Suspense>
  );
}
