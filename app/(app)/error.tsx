"use client";

import { ErrorScreen } from "@/components/errors/ErrorScreen";

// Error boundary del panel (ADR-098): el menú lateral queda en pie y sólo la
// pantalla que falló muestra el aviso, con "Probar de nuevo".
export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} boundary="panel" homeHref="/dashboard" homeLabel="Ir al panel" />;
}
