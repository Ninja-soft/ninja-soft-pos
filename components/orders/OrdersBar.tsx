"use client";

import Link from "next/link";
import { ChevronRight, ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { money } from "@/components/pos/ui/posStyles";
import { DELIVERY_TYPE_LABEL, minutesLeftLabel, orderReservationState } from "@/lib/orders/logic";
import type { SaleOrder } from "@/modules/orders/api";

// Pedidos de salón esperando caja (F11 · H32, ADR-129): un chip por pedido con
// número, cliente, monto y cuánto le queda a la reserva; tocarlo lo levanta
// para cobrarlo. Mismo lenguaje que la barra de ventas pausadas (ADR-106):
// scroll lateral dentro de la barra, sin sombras ni bordes de color.

export function OrdersBar({
  list,
  currentUserId,
  onTake,
}: {
  list: SaleOrder[];
  currentUserId: string | null;
  onTake: (o: SaleOrder) => void;
}) {
  if (list.length === 0) return null;
  const now = new Date();
  return (
    <section aria-label="Pedidos para cobrar" className="mx-3 mb-2 flex min-w-0 shrink-0 items-center gap-2 md:mx-4">
      <Link
        href="/pedidos"
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-fg-6 px-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-fg-10"
        title="Ver todos los pedidos"
      >
        <ClipboardList size={15} aria-hidden />
        <span className="hidden sm:inline">Pedidos</span>
        <span className="tabular-nums">{list.length}</span>
      </Link>
      <ul className="slim-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {list.map((o) => {
          const res = orderReservationState(o, now);
          const otherCash = o.status === "tomado" && o.taken_by !== currentUserId;
          const soon = res.kind === "active" && res.msLeft < 5 * 60_000;
          return (
            <li key={o.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onTake(o)}
                disabled={otherCash}
                aria-label={`Cobrar el pedido ${o.number}, ${money(o.total)}`}
                className="flex min-h-11 max-w-[15rem] flex-col justify-center rounded-lg bg-fg-4 px-3 py-1.5 text-left transition-colors hover:bg-fg-6 disabled:opacity-60"
              >
                <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight">
                  <span className="tabular-nums">N° {o.number}</span>
                  <span className="truncate font-medium text-muted-foreground">
                    {o.customer_name || o.pickup_name || o.seller_name || DELIVERY_TYPE_LABEL[o.delivery_type]}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
                  <span className="font-price tabular-nums text-foreground">{money(o.total)}</span>
                  <span aria-hidden>·</span>
                  {otherCash ? (
                    <span className="truncate">En otra caja</span>
                  ) : res.kind === "active" ? (
                    <span className={cn("truncate tabular-nums", soon && "font-medium text-warning")}>
                      Reserva {minutesLeftLabel(res.msLeft)}
                    </span>
                  ) : (
                    <span className="truncate">{res.kind === "released" ? "Sin reserva" : DELIVERY_TYPE_LABEL[o.delivery_type]}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Link
        href="/pedidos"
        className="hidden h-11 w-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground sm:grid"
        aria-label="Ver todos los pedidos"
      >
        <ChevronRight size={18} aria-hidden />
      </Link>
    </section>
  );
}
