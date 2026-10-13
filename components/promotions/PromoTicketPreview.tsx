"use client";

import { Gift } from "lucide-react";
import type { TicketPreview } from "@/lib/promotions/describe";
import { formatCurrency } from "@/lib/utils/format";

// "Así se ve en el ticket" (F9, ADR-074): un carrito de ejemplo que dispara la
// promo, con la línea de la promo como sale impresa. Mismo motor que el POS.
export function PromoTicketPreview({ preview, summary }: { preview: TicketPreview; summary: string[] }) {
  const applies = preview.promos.length > 0 || Boolean(preview.gift);
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-background px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
        <p className="text-center text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Así se ve en el ticket</p>
        <div className="my-2 border-t border-dashed border-border" />
        <ul className="space-y-0.5">
          {preview.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {it.quantity}× {it.name}
              </span>
              <span className="shrink-0 tabular-nums">{formatCurrency(it.amount)}</span>
            </li>
          ))}
          {preview.gift && (
            <li className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{preview.gift}</span>
              <span className="shrink-0 tabular-nums">{formatCurrency(0)}</span>
            </li>
          )}
        </ul>
        <div className="my-2 border-t border-dashed border-border" />
        <div className="flex justify-between gap-3">
          <span>Subtotal</span>
          <span className="tabular-nums">{formatCurrency(preview.subtotal)}</span>
        </div>
        {preview.promos.map((p, i) => (
          <div key={i} className="flex justify-between gap-3 text-success">
            <span className="min-w-0 truncate">{p.label}</span>
            <span className="shrink-0 tabular-nums">-{formatCurrency(p.amount)}</span>
          </div>
        ))}
        {preview.gift && (
          <div className="flex items-center gap-1.5 text-success">
            <Gift size={12} aria-hidden /> Regalo incluido
          </div>
        )}
        <div className="mt-1 flex justify-between gap-3 text-sm font-bold">
          <span>TOTAL</span>
          <span className="tabular-nums">{formatCurrency(preview.total)}</span>
        </div>
      </div>
      {!applies && (
        <p className="text-xs text-warning">Con estos datos el ejemplo no llega a la promo. Revisá el descuento o los productos.</p>
      )}
      {summary.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {summary.map((s) => (
            <li key={s} className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
