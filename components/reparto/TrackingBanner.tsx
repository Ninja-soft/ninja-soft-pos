"use client";

// Aviso del seguimiento en la app del repartidor (ADR-164, doc 45 §11,
// Ley 25.326): la primera vez pide aceptar compartir la ubicación y después
// muestra siempre que se está compartiendo, sólo con la hoja en curso.

import { LocateFixed, LocateOff, MapPin } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import type { TrackingStatus } from "@/modules/logistics/tracking";

export interface TrackingView {
  status: TrackingStatus;
  pending: number;
  accuracy: number | null;
  wakeLock: boolean;
  accept: () => void;
}

export function TrackingBanner({ t }: { t: TrackingView }) {
  if (t.status === "off" || t.status === "disabled") return null;
  if (t.status === "needs_consent") {
    return (
      <div className="space-y-2 bg-info/10 px-4 py-3 text-sm">
        <p className="flex items-center gap-2 font-semibold">
          <MapPin size={16} aria-hidden /> Compartí tu ubicación mientras repartís
        </p>
        <p className="text-muted-foreground">
          Sólo con la hoja en curso: el encargado ve dónde está el camión y a qué hora llega a cada parada. Al cerrar la hoja se deja de enviar.
          Dejá la app abierta con la pantalla encendida.
        </p>
        <Button size="sm" onClick={t.accept}>
          <LocateFixed size={15} /> Compartir ubicación
        </Button>
      </div>
    );
  }
  const bad = t.status === "denied" || t.status === "unsupported";
  const text =
    t.status === "denied"
      ? "La ubicación está bloqueada: activala en el navegador para que te vean en el mapa."
      : t.status === "unsupported"
        ? "Este teléfono no da la ubicación al navegador."
        : t.status === "waiting"
          ? "Buscando señal de GPS…"
          : "Estás compartiendo tu ubicación";
  return (
    <div
      role="status"
      className={cn("flex items-center justify-between gap-2 px-4 py-2 text-xs", bad ? "bg-danger/10 text-danger" : "bg-success/10 text-success")}
    >
      <span className="flex items-center gap-1.5 font-medium">
        {bad ? <LocateOff size={14} aria-hidden /> : <LocateFixed size={14} aria-hidden />}
        {text}
      </span>
      {t.status === "on" && (
        <span className="shrink-0 text-muted-foreground">
          {t.accuracy !== null ? `± ${t.accuracy} m` : ""}
          {t.pending > 1 ? ` · ${t.pending} sin enviar` : ""}
        </span>
      )}
    </div>
  );
}
TrackingBanner.displayName = "TrackingBanner";
