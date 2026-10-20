"use client";

import Link from "next/link";
import type { Route } from "next";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/lib/utils/format";
import type { AlertItem } from "@/modules/alerts/api";

// Casos de una alerta (Probar ahora e historial). Lista simple, sin bordes
// de color: título, detalle, monto y "Nuevo" cuando corresponde.
export function AlertItemsList({
  items,
  total,
  showNew = false,
  empty = "Sin casos.",
}: {
  items: AlertItem[];
  total?: number;
  showNew?: boolean;
  empty?: string;
}) {
  if (items.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  }
  const more = total != null && total > items.length ? total - items.length : 0;
  return (
    <div>
      <ul className="divide-y divide-border">
        {items.map((it) => (
          <li key={it.key} className="flex items-start justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                {it.url ? (
                  <Link href={it.url as Route} className="hover:underline">
                    {it.title}
                  </Link>
                ) : (
                  it.title
                )}
                {showNew && it.new && <Badge tone="info">Nuevo</Badge>}
              </p>
              {it.detail && <p className="mt-0.5 text-xs text-muted-foreground">{it.detail}</p>}
            </div>
            {it.amount != null && (
              <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(Number(it.amount))}</span>
            )}
          </li>
        ))}
      </ul>
      {more > 0 && <p className="pt-2 text-xs text-muted-foreground">Y {more} más.</p>}
    </div>
  );
}
AlertItemsList.displayName = "AlertItemsList";
