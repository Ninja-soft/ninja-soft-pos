"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, Users } from "lucide-react";
import type { DiningArea, DiningTable, TableStatus } from "@/modules/dining/api";
import { TABLE_STATUS_LABELS } from "@/modules/dining/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";
import { POS_EYEBROW, POS_SEG_OFF, POS_SEG_ON, POS_SEG_TRACK, POS_TILE, money } from "../ui/posStyles";

// Mapa de mesas del preset Salón. Reusa los estados de la vista de Salón
// (H44): tocar una mesa la abre o muestra su cuenta (TableAccountModal), desde
// donde se cobra en este mismo POS. Cada mesa es un tile neutro; el estado va
// como punto + texto (nunca sólo color), y la mesa en cobro se marca con el
// relleno de selección.

const STATUS_DOT: Record<TableStatus, string> = {
  libre: "bg-success",
  ocupada: "bg-warning",
  cuenta_pedida: "bg-info",
  reservada: "bg-[#A78BFA]",
  bloqueada: "bg-muted-foreground/50",
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
  const seg = "flex h-8 shrink-0 items-center rounded-md px-3 text-xs font-medium transition-colors";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-1 pb-2.5">
        <p className={POS_EYEBROW}>Mesas</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {busy} de {tables.length} ocupadas
        </p>
      </div>
      {areas.length > 1 && (
        <div
          className={cn("mb-3 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", POS_SEG_TRACK)}
          role="group"
          aria-label="Salones"
        >
          <button
            type="button"
            onClick={() => setArea(null)}
            aria-pressed={area === null}
            className={cn(seg, area === null ? POS_SEG_ON : POS_SEG_OFF)}
          >
            Todas
          </button>
          {areas.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setArea(a.id)}
              aria-pressed={area === a.id}
              className={cn(seg, area === a.id ? POS_SEG_ON : POS_SEG_OFF)}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
      {!loading && tables.length === 0 ? (
        <EmptyState
          compact
          icon={LayoutGrid}
          title="Todavía no cargaste mesas"
          description="Definilas en Configuración, Salones y mesas."
        />
      ) : (
        <div className="slim-scrollbar grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 overflow-y-auto pr-1">
          {visible.map((t) => {
            const total = t.current_order_id ? totals?.[t.current_order_id] ?? 0 : 0;
            const active = Boolean(activeOrderId && t.current_order_id === activeOrderId);
            const blocked = t.status === "bloqueada";
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTap(t)}
                className={cn(
                  POS_TILE,
                  "flex min-h-[84px] flex-col justify-between gap-2 p-2.5 text-left",
                  active && "choice-on choice-check hover:bg-[var(--choice-fill)]",
                  blocked && "opacity-60",
                )}
                aria-label={`Mesa ${t.label}, ${TABLE_STATUS_LABELS[t.status]}${active ? ", en cobro" : ""}`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="font-display text-lg font-semibold leading-none tabular-nums">{t.label}</span>
                  <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                    <Users size={12} aria-hidden /> {t.capacity}
                  </span>
                </span>
                <span className="space-y-0.5">
                  {t.status !== "libre" && t.current_order_id && (
                    <span className="block font-price text-[13px] font-semibold tabular-nums text-foreground">
                      {money(total)}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[t.status])} />
                    <span className="truncate">{TABLE_STATUS_LABELS[t.status]}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
