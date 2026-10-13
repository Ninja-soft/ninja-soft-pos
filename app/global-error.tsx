"use client";

import { ErrorScreen } from "@/components/errors/ErrorScreen";
import "./globals.css";

// Último recurso (ADR-098): falló el layout raíz, así que esta pantalla trae
// su propio <html> y estilos. Sin reset: se recarga la página.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <ErrorScreen error={error} boundary="global" />
      </body>
    </html>
  );
}
