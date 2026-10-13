"use client";

import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils/cn";

// Estado de la venta offline en el POS (ADR-077). Superficie neutra con borde
// sutil y el ícono en el color del estado (sin rellenos, sombras ni bordes de
// color). Se muestra sólo si hay algo que decir.
export function offlineBannerText(s: {
  isOffline: boolean;
  pending: number;
  held: number;
  syncing: boolean;
  enabled: boolean;
}): { title: string; text: string; tone: "warning" | "info" | "danger" } | null {
  const n = (k: number) => (k === 1 ? "1 venta" : `${k} ventas`);
  if (s.isOffline) {
    return {
      tone: "warning",
      title: s.enabled
        ? `Sin conexión: vendiendo offline, ${n(s.pending)} por sincronizar`
        : "Sin conexión: la venta offline está apagada",
      text: s.enabled
        ? "Sólo efectivo, transferencia o tarjeta en posnet. Se envían solas cuando vuelve la conexión."
        : "El dueño la puede prender en Configuración, Operación.",
    };
  }
  if (s.held > 0) {
    return {
      tone: "danger",
      title: `${n(s.held)} offline sin enviar`,
      text: "El servidor no las aceptó desde este usuario. Siguen guardadas en este dispositivo.",
    };
  }
  if (s.pending > 0) {
    return {
      tone: "info",
      title: s.syncing ? `Sincronizando ${n(s.pending)} offline` : `${n(s.pending)} offline por sincronizar`,
      text: "No cierres la caja hasta que terminen de enviarse.",
    };
  }
  return null;
}

export function OfflineBanner({
  isOffline,
  pending,
  held,
  syncing,
  enabled,
  onRetry,
}: {
  isOffline: boolean;
  pending: number;
  held: number;
  syncing: boolean;
  enabled: boolean;
  onRetry: () => void;
}) {
  const msg = offlineBannerText({ isOffline, pending, held, syncing, enabled });
  if (!msg) return null;
  const Icon = msg.tone === "danger" ? TriangleAlert : msg.tone === "warning" ? CloudOff : RefreshCw;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pos-offline-banner"
      className="mx-3 mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card py-2 pl-2 pr-2 md:mx-4"
    >
      <span
        aria-hidden
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-md",
          msg.tone === "warning" && "bg-warning/15 text-warning",
          msg.tone === "info" && "bg-info/15 text-info",
          msg.tone === "danger" && "bg-destructive/15 text-destructive",
        )}
      >
        <Icon size={18} className={cn(syncing && msg.tone === "info" && "animate-spin")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{msg.title}</span>
        <span className="block text-xs text-muted-foreground">{msg.text}</span>
      </span>
      {!isOffline && (pending > 0 || held > 0) && (
        <button
          type="button"
          onClick={onRetry}
          disabled={syncing}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw size={16} aria-hidden />
          <span className="hidden sm:inline">Enviar ahora</span>
        </button>
      )}
    </div>
  );
}
