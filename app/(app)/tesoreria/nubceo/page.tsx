"use client";

// Tesorería > NubCeo (H155, ADR-158): envíos y asientos que devolvió.
import { Suspense } from "react";
import { NubceoView } from "@/components/treasury/NubceoView";

export default function TesoreriaNubceoPage() {
  return (
    <Suspense fallback={null}>
      <NubceoView />
    </Suspense>
  );
}
