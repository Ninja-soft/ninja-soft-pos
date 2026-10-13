"use client";

import { RefreshCw } from "lucide-react";
import { swUpdateView } from "@/lib/pwa/update";
import { useServiceWorker } from "@/modules/pwa/useServiceWorker";

// Registra el service worker del POS y avisa cuando hay una versión nueva
// (H65, ADR-087). Mientras hay un cobro en curso (busy) no deja recargar.
// Superficie neutra con borde sutil, sin sombras ni bordes de color.
export function SwUpdateBanner({ busy }: { busy: boolean }) {
  const { updateReady, applyUpdate } = useServiceWorker();
  const view = swUpdateView({ updateReady, busy });
  if (!view) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sw-update-banner"
      className="mx-3 mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card py-2 pl-2 pr-2 md:mx-4"
    >
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-info/15 text-info">
        <RefreshCw size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{view.title}</span>
        <span className="block text-xs text-muted-foreground">{view.text}</span>
      </span>
      <button
        type="button"
        onClick={applyUpdate}
        disabled={!view.canReload}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-fg-6 disabled:opacity-50"
      >
        {view.action}
      </button>
    </div>
  );
}
