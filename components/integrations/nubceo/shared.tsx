"use client";

import { cn } from "@/lib/utils/cn";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { SyncStatus } from "@/modules/integrations/nubceo/api";

// Piezas compartidas de Configuración > Integraciones > NubCeo (ADR-062).

/**
 * Logo oficial de NubCeo (wordmark transparente). Azul de la marca en claro y
 * blanco en oscuro: el CSS global (.logo-on-light / .logo-on-dark) muestra
 * el que corresponde al tema.
 */
export function NubceoLogo({ height = 22, className }: { height?: number; className?: string }) {
  const width = Math.round(height * (720 / 151));
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} style={{ height }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/integrations/nubceo-wordmark.webp"
        alt="NubCeo"
        width={width}
        height={height}
        draggable={false}
        className="logo-on-light select-none object-contain"
        style={{ height, width: "auto" }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/integrations/nubceo-wordmark-on-dark.webp"
        alt="NubCeo"
        width={width}
        height={height}
        draggable={false}
        className="logo-on-dark select-none object-contain"
        style={{ height, width: "auto" }}
      />
    </span>
  );
}
NubceoLogo.displayName = "NubceoLogo";

export const STATUS_INFO: Record<SyncStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pendiente", tone: "neutral" },
  sending: { label: "Enviando", tone: "info" },
  synced: { label: "Enviada", tone: "success" },
  excluded: { label: "Excluida", tone: "neutral" },
  error: { label: "Con error", tone: "danger" },
  simulated: { label: "Simulada", tone: "info" },
  delete_pending: { label: "Por borrar", tone: "warning" },
  deleted: { label: "Borrada en NubCeo", tone: "neutral" },
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const s = STATUS_INFO[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const RUN_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  ok: { label: "Sin problemas", tone: "success" },
  partial: { label: "Con errores", tone: "warning" },
  error: { label: "Falló", tone: "danger" },
  skipped: { label: "Sin cambios", tone: "neutral" },
  simulated: { label: "Simulación", tone: "info" },
};

export const ERROR_KIND: Record<string, string> = {
  config: "Configuración",
  validation: "Rechazada por NubCeo",
  network: "Sin respuesta",
  credentials: "Credenciales",
  exhausted: "Reintentos agotados",
};

const dtf = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Argentina/Buenos_Aires",
});
const df = new Intl.DateTimeFormat("es-AR", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

export const fmtDateTime = (iso: string | null | undefined) => (iso ? dtf.format(new Date(iso)) : "");
/** "2026-10-20" → "mar 20 oct". */
export const fmtDay = (day: string) => df.format(new Date(`${day}T00:00:00Z`));

/** Fecha local de Argentina (aaaa-mm-dd) de un instante. */
export function arDay(ms: number): string {
  return new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
}

/** Inicio del día (hora de Argentina) en ISO UTC. */
export function arDayStartIso(day: string): string {
  return new Date(`${day}T03:00:00.000Z`).toISOString();
}

export const ENV_LABEL = { test: "Prueba", prod: "Producción" } as const;

/** Bloque de JSON legible, con scroll propio. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        "slim-scrollbar max-h-[46dvh] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed text-foreground",
        className,
      )}
    >
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  );
}
