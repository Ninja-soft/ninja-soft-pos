"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, Users } from "lucide-react";
import type { DiningArea, DiningTable } from "@/modules/dining/api";
import { TABLE_STATUS_DOT, TABLE_STATUS_LABELS } from "@/modules/dining/api";
import { cn } from "@/lib/utils/cn";
import { POS_IDLE, POS_SELECTED, money } from "../ui/posStyles";

// Mapa de mesas del preset Salón. Reusa los estados y colores de la vista de
// Salón (H44): tocar una mesa la abre o muestra su cuenta (TableAccountModal),
// desde donde se cobra en este mismo POS.

const TILE: Record<string, string> = {
  libre: "bg-card hover:bg-muted",
  ocupada: "bg-amber-400/15 hover:bg-amber-400/25",
  cuenta_pedida: "bg-sky-400/15 hover:bg-sky-400/25",
  reservada: "bg-purple-400/15 hover:bg-purple-400/20",
  bloqueada: "bg-muted/40 opacity-60",
};

export function SalonTablesPanel({
  areas,
  tables,
  totals,
  activeOrderId,
  onTap,
  loading,
}: {
  areas: DiningArea[];
  tables: DiningTable[];
  totals: Record<string, number> | undefined;
  activeOrderId: string | null;
  onTap: (t: DiningTable) => void;
  loading?: boolean;
}) {
  const [area, setArea] = useState<string | null>(null);
  const visible = useMemo(
    () => (area ? tables.filter((t) => t.area_id === area) : tables),
    [tables, area],
  );
  const busy = tables.filter((t) => t.status !== "libre" && t.status !== "bloqueada").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Mesas</p>
        <p className="text-[11px] text-muted-foreground">
          {busy} de {tables.length} ocupadas
        </p>
      </div>
      {areas.length > 1 && (
        <div className="mb-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" onClick={() => setArea(null)} className={cn("h-8 shrink-0 rounded-full px-3 text-xs font-bold", area === null ? POS_SELECTED : POS_IDLE)}>
            Todas
          </button>
          {areas.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setArea(a.id)}
              className={cn("h-8 shrink-0 rounded-full px-3 text-xs font-bold", area === a.id ? POS_SELECTED : POS_IDLE)}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
      {!loading && tables.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-muted/40 p-6 text-center">
          <LayoutGrid size={24} className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Todavía no cargaste mesas. Definilas en Configuración, Salones y mesas.
          </p>
        </div>
      ) : (
        <div className="slim-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2 overflow-y-auto pr-1">
          {visible.map((t) => {
            const total = t.current_order_id ? totals?.[t.current_order_id] ?? 0 : 0;
            const active = Boolean(activeOrderId && t.current_order_id === activeOrderId);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTap(t)}
                className={cn(
                  "flex aspect-square flex-col justify-between rounded-2xl p-2.5 text-left transition active:scale-95",
                  active ? POS_SELECTED : TILE[t.status] ?? TILE.libre,
                )}
                aria-label={`Mesa ${t.label}, ${TABLE_STATUS_LABELS[t.status]}`}
              >
                <span className="flex items-start justify-between">
                  <span className="font-display text-xl font-black leading-none">{t.label}</span>
                  <span className={cn("mt-0.5 h-2.5 w-2.5 rounded-full", TABLE_STATUS_DOT[t.status])} />
                </span>
                <span>
                  <span className={cn("flex items-center gap-1 text-[10px]", active ? "opacity-70" : "text-muted-foreground")}>
                    <Users size={10} /> {t.capacity}
                  </span>
                  {t.status !== "libre" && t.current_order_id ? (
                    <span className="block font-price text-xs font-black tabular-nums">{money(total)}</span>
                  ) : (
                    <span className={cn("block text-[10px] font-semibold", active ? "" : "text-muted-foreground")}>
                      {TABLE_STATUS_LABELS[t.status]}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
