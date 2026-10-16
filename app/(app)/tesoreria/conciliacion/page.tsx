"use client";

// Tesorería > Conciliación (H155, ADR-158): el mismo hub de /reportes/conciliacion.
import { Suspense } from "react";
import { ConciliacionHub } from "@/components/reports/conciliacion/ConciliacionHub";

export default function TesoreriaConciliacionPage() {
  return (
    <Suspense fallback={null}>
      <ConciliacionHub />
    </Suspense>
  );
}
