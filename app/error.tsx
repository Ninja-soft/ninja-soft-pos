"use client";

import { ErrorScreen } from "@/components/errors/ErrorScreen";

// Error boundary raíz (ADR-098): cualquier pantalla sin un boundary propio
// (auth, páginas públicas, onboarding, pantallas del cliente y cocina).
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-background">
      <ErrorScreen error={error} reset={reset} boundary="root" />
    </main>
  );
}
