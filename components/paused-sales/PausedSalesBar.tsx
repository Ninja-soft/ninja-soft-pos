"use client";

import { ChevronRight, Pause } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { money } from "@/components/pos/ui/posStyles";
import {
  pausedBadges,
  pausedExpiry,
  pausedTimeLabel,
  pausedTitle,
  type PausedBadge,
  type PausedSale,
} from "@/modules/paused-sales/logic";

// Barra de "Ventas pausadas" del POS (ADR-106): un chip por venta con su
// nombre, monto y hora; tocarlo la retoma. Scroll horizontal sólo dentro de
// la barra (la pantalla no se corre). Sin sombras ni bordes de color.

const TONE: Record<string, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-ninja-flameSoft",
  neutral: "text-muted-foreground",
};

export function PausedSalesBar({
  list,
  busyId,
  onResume,
  onOpenAll,
}: {
  list: PausedSale[];
  busyId: string | null;
  onResume: (s: PausedSale) => void;
  onOpenAll: () => void;
}) {
  if (list.length === 0) return null;
  return (
    <section aria-label="Ventas pausadas" className="mx-3 mb-2 flex min-w-0 shrink-0 items-center gap-2 md:mx-4">
      <button
        type="button"
        onClick={onOpenAll}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-fg-6 px-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-fg-10"
        title="Ver y administrar las ventas pausadas"
      >
        <Pause size={15} aria-hidden />
        <span className="hidden sm:inline">Pausadas</span>
        <span className="tabular-nums">{list.length}</span>
      </button>
      <ul className="slim-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {list.map((s) => {
          // Vencimiento a las 24 h (ADR-108): lo que vence pronto va primero.
          const exp = pausedExpiry(s);
          const badge: PausedBadge | { tone: "danger"; text: string } | undefined =
            exp.kind === "held"
              ? { tone: "danger", text: "Venció" }
              : exp.kind === "soon"
                ? { tone: "warning", text: exp.label }
                : pausedBadges(s)[0];
          const busy = busyId === s.id;
          return (
            <li key={s.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onResume(s)}
                disabled={Boolean(busyId)}
                aria-label={`Retomar ${pausedTitle(s)}, ${money(s.total)}`}
                className={cn(
                  "flex min-h-11 max-w-[15rem] flex-col justify-center rounded-lg bg-fg-4 px-3 py-1.5 text-left transition-colors hover:bg-fg-6 disabled:opacity-60",
                  s.needs_review && "bg-warning/10 hover:bg-warning/15",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight">
                  {busy && <Spinner size={12} />}
                  <span className="truncate">{pausedTitle(s)}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
                  <span className="font-price tabular-nums text-foreground">{money(s.total)}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{pausedTimeLabel(s.paused_at)}</span>
                  {badge && (
                    <>
                      <span aria-hidden>·</span>
                      <span className={cn("truncate font-medium", TONE[badge.tone])}>{badge.text}</span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onOpenAll}
        className="hidden h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground sm:grid"
        aria-label="Ver todas las ventas pausadas"
      >
        <ChevronRight size={18} aria-hidden />
      </button>
    </section>
  );
}
