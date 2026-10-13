"use client";

import { ErrorScreen } from "@/components/errors/ErrorScreen";

// Error boundary del panel interno de NinjaSoft (ADR-098).
export default function InternalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorScreen error={error} reset={reset} boundary="internal" homeHref="/internal" homeLabel="Ir al panel interno" />
  );
}
