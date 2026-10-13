"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { buildReport, humanError, reportClientError } from "@/lib/errors/clientError";
import { cn } from "@/lib/utils/cn";

// Pantalla de error de los error boundaries de Next (app/error.tsx y los de
// cada sección). Mensaje humano según el tipo de error, botón para reintentar
// y el código para soporte. Reporta una vez al montar (ADR-098).
export function ErrorScreen({
  error,
  reset,
  boundary,
  homeHref = "/",
  homeLabel = "Ir al inicio",
  className,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  boundary: string;
  homeHref?: string;
  homeLabel?: string;
  className?: string;
}) {
  const info = humanError(error);

  useEffect(() => {
    reportClientError(
      buildReport({
        error,
        boundary,
        href: window.location.href,
        release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null,
      }),
    );
  }, [error, boundary]);

  const Icon = info.kind === "network" ? WifiOff : info.kind === "update" ? RefreshCw : AlertTriangle;
  const code = error.digest ?? null;

  return (
    <div
      role="alert"
      className={cn("flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 py-12 text-center", className)}
    >
      <span className="grid h-14 w-14 place-items-center rounded-lg bg-ninja-flame/10 text-ninja-flameSoft" aria-hidden>
        <Icon size={24} strokeWidth={1.75} />
      </span>
      <div className="max-w-md space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{info.title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{info.description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {info.kind === "update" || !reset ? (
          <Button onClick={() => window.location.reload()}>Recargar</Button>
        ) : (
          <Button onClick={() => reset()}>Probar de nuevo</Button>
        )}
        <Button variant="secondary" onClick={() => window.location.assign(homeHref)}>
          {homeLabel}
        </Button>
      </div>
      {code && (
        <p className="text-xs text-muted-foreground">
          Código para soporte: <span className="font-mono">{code}</span>
        </p>
      )}
    </div>
  );
}
ErrorScreen.displayName = "ErrorScreen";
