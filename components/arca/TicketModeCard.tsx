"use client";

import { Receipt } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { arcaErrorMessage } from "@/lib/arca/labels";
import { TICKET_MODES, TICKET_MODE_INFO, isTicketMode, type TicketMode } from "@/lib/billing/ticketMode";
import type { ArcaConfig } from "@/modules/arca/api";
import { useArcaMutations } from "@/modules/arca/hooks";

// Factura o sólo ticket por defecto (ADR-155). En la hoja de cobro se cambia
// venta por venta con un toque (o Shift + F9).
export function TicketModeCard({ config, canWrite }: { config: ArcaConfig; canWrite: boolean }) {
  const m = useArcaMutations();
  const { toast } = useToast();
  const raw = config.settings?.ticket_mode;
  // Sin la migración el campo no viene: la tarjeta no se muestra.
  if (raw === undefined) return null;
  const mode: TicketMode = isTicketMode(raw) ? raw : "factura";

  const pick = async (v: TicketMode) => {
    if (v === mode) return;
    try {
      await m.setTicketMode.mutateAsync(v);
      toast({ title: "Guardado", description: TICKET_MODE_INFO[v].label, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: arcaErrorMessage(e), variant: "error" });
    }
  };

  return (
    <section className="rounded-md border border-border bg-card p-4" aria-labelledby="ticket-mode-title">
      <h3 id="ticket-mode-title" className="flex items-center gap-1.5 text-sm font-semibold">
        <Receipt size={15} className="text-muted-foreground" aria-hidden /> Factura o sólo ticket en cada venta
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Es lo que propone el cobro. El cajero lo cambia venta por venta con el interruptor Factura / Sólo ticket (o Shift + F9).
        Una venta con sólo ticket no va a ARCA; si después hace falta, la facturás desde el detalle de la venta.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Factura o sólo ticket por defecto">
        {TICKET_MODES.map((k) => {
          const on = k === mode;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canWrite || m.setTicketMode.isPending}
              onClick={() => void pick(k)}
              className={cn(
                "flex min-h-11 flex-col items-start gap-0.5 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                on ? "choice-on" : "bg-fg-4 hover:bg-fg-6",
                !canWrite && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="font-semibold">{TICKET_MODE_INFO[k].label}</span>
              <span className="text-xs text-muted-foreground">{TICKET_MODE_INFO[k].help}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
TicketModeCard.displayName = "TicketModeCard";
