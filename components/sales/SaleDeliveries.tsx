"use client";

// Detalle de la venta: cómo se entrega (ADR-149 · L0, R18). Una línea por
// entrega con su modo, su estado y su remito. Sin entregas (se lo llevó en el
// momento, sin expedición) no muestra nada.

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import {
  DELIVERY_TYPE_LABEL,
  DISPATCH_STATUS_LABEL,
  FULFILLMENT_MODE_LABEL,
  fulfillmentModeOf,
  type DispatchStatus,
} from "@/lib/orders/logic";
import { useSaleDeliveries } from "@/modules/orders/hooks";
import type { SaleDelivery } from "@/modules/orders/api";

const TONE: Record<DispatchStatus, BadgeTone> = {
  pendiente: "info",
  armando: "brand",
  listo: "success",
  en_transito: "warning",
  despachado: "warning",
  entregado: "neutral",
  cancelado: "neutral",
};

export function SaleDeliveriesView({ deliveries, mode }: { deliveries: SaleDelivery[]; mode: unknown }) {
  const m = fulfillmentModeOf(mode);
  // La parte "se lo lleva ahora" sola no es una entrega para mostrar.
  const shown = deliveries.filter((d) => d.delivery_type !== "inmediato" || deliveries.length > 1);
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="sd-delivery">
      <h3 id="sd-delivery" className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Entrega{m && m !== "en_mostrador" ? ` · ${FULFILLMENT_MODE_LABEL[m]}` : ""}
      </h3>
      <ul className="space-y-2">
        {shown.map((d) => (
          <li key={d.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium tabular-nums">Entrega N° {d.number}</span>
              <Badge tone="neutral">{DELIVERY_TYPE_LABEL[d.delivery_type]}</Badge>
              <Badge tone={TONE[d.status]}>{DISPATCH_STATUS_LABEL[d.status]}</Badge>
              {d.parts_total > 1 && <span className="text-xs text-muted-foreground">{`${d.part} de ${d.parts_total}`}</span>}
            </div>
            {(d.ship_address || d.pickup_name || d.tracking || d.remito) && (
              <p className="mt-1 text-xs text-muted-foreground">
                {[
                  d.ship_address ? `A ${d.ship_address}` : d.pickup_name ? `Retira ${d.pickup_name}` : null,
                  d.tracking ? `Seguimiento ${d.tracking}` : null,
                  d.remito ? `Remito ${d.remito.label}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SaleDeliveries({ saleId, mode, enabled }: { saleId: string | null; mode: unknown; enabled: boolean }) {
  const q = useSaleDeliveries(saleId, enabled);
  if (!q.data || q.data.length === 0) return null;
  return <SaleDeliveriesView deliveries={q.data} mode={mode} />;
}
