"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer, RotateCcw, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useComandaData, useMarkComandaPrinted } from "@/modules/dining/hooks";
import {
  KDS_STATIONS,
  KDS_STATION_LABELS,
  type ComandaItem,
} from "@/modules/dining/api";
import { modifiersSummaryNoPrice } from "@/modules/products/modifiers";
import { webPrintCopies } from "@/lib/print/webPrint";
import { formatQty } from "@/lib/utils/format";

// F13 · H45 — Comanda impresa por estación desde la cuenta de la mesa (H44).
//
// Es un ticket de COCINA (no de venta): SIN precios ni totales. Agrupa los ítems
// del pedido por `station` (snapshot del producto, H46) y emite UNA comanda por
// estación con ítems (cocina lo suyo, barra lo suyo). Ítems sin estación → una
// comanda "Sin estación". Reusa el flujo de impresión web de los tickets
// (window.print + CSS print): la clase .comanda-print aísla el contenido y
// .comanda-page fuerza un salto de página entre estaciones (ver globals.css).
//
// Evita re-imprimir: por defecto imprime sólo lo NUEVO (printed_at null). Al
// imprimir, marca esas líneas como enviadas (mark_comanda_printed). "Reimprimir
// todo" trae todas las líneas (no repisa la marca original).

type Paper = "58" | "80";

// Orden estable de estaciones para la salida (mismo orden que el KDS); las sin
// estación van al final.
const STATION_ORDER: Record<string, number> = Object.fromEntries(
  KDS_STATIONS.map((s, i) => [s, i]),
);

function stationLabel(s: string | null): string {
  if (!s) return "Sin estación";
  return KDS_STATION_LABELS[s as keyof typeof KDS_STATION_LABELS] ?? s;
}

interface StationGroup {
  key: string; // station ?? "__none__"
  station: string | null;
  items: ComandaItem[];
}

// Agrupa las líneas por estación, respetando STATION_ORDER (sin estación al final).
function groupByStation(items: ComandaItem[]): StationGroup[] {
  const map = new Map<string, StationGroup>();
  for (const it of items) {
    const key = it.station ?? "__none__";
    const g = map.get(key);
    if (g) g.items.push(it);
    else map.set(key, { key, station: it.station, items: [it] });
  }
  return [...map.values()].sort((a, b) => {
    const oa = a.station ? (STATION_ORDER[a.station] ?? 90) : 99;
    const ob = b.station ? (STATION_ORDER[b.station] ?? 90) : 99;
    return oa - ob;
  });
}

export function ComandaModal({
  open,
  onOpenChange,
  orderId,
  // Estación de origen (opcional): si se abre desde una vista de estación, la
  // comanda arranca filtrada a esa estación.
  initialStation = null,
  businessName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId: string | null;
  initialStation?: string | null;
  businessName?: string | null;
}) {
  const { toast } = useToast();
  // reprintAll=false → sólo lo nuevo (no enviado). true → todas las líneas.
  const [reprintAll, setReprintAll] = useState(false);
  // Filtro por estación (null = todas). Se siembra con initialStation al abrir.
  const [stationFilter, setStationFilter] = useState<string | null>(initialStation);
  const [paper, setPaper] = useState<Paper>("80");

  const { data: items, isLoading } = useComandaData(orderId, !reprintAll, open);
  const markPrinted = useMarkComandaPrinted();

  // Reset de estado al abrir/cerrar para que cada apertura empiece limpia.
  useEffect(() => {
    if (open) {
      setReprintAll(false);
      setStationFilter(initialStation);
    }
  }, [open, initialStation]);

  // Grupos por estación, ya filtrados por la estación elegida (si hay).
  const groups = useMemo(() => {
    const all = groupByStation(items ?? []);
    return stationFilter ? all.filter((g) => (g.station ?? null) === stationFilter) : all;
  }, [items, stationFilter]);

  // Estaciones presentes en el pedido (para las pills de filtro).
  const presentStations = useMemo(() => groupByStation(items ?? []), [items]);

  const header = (items ?? [])[0] ?? null;
  const visibleItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const nothingToPrint = !isLoading && visibleItems.length === 0;

  // Hora de impresión (cabecera de la comanda).
  const printedAtLabel = new Date().toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  async function handlePrint() {
    if (!orderId || visibleItems.length === 0) return;
    // Dispara la impresión web (reusa el helper de los tickets).
    webPrintCopies(1);
    // Marca como enviadas SÓLO las líneas que se imprimieron (las visibles).
    // Reimprimir todo igual marca las que aún fueran nuevas (idempotente en DB).
    try {
      await markPrinted.mutateAsync({
        orderId,
        itemIds: visibleItems.map((it) => it.item_id),
      });
    } catch (e) {
      // La impresión ya salió; sólo avisamos si falló el marcado.
      toast({
        title: "Comanda impresa, pero no se pudo marcar como enviada",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
      return;
    }
    toast({
      title:
        groups.length > 1
          ? `Comanda enviada (${groups.length} estaciones)`
          : "Comanda enviada",
      variant: "success",
    });
  }

  const widthCls = paper === "58" ? "w-[58mm]" : "w-[80mm]";

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Comanda de cocina">
      <div className="space-y-4">
        {/* Controles (no se imprimen) */}
        <div className="no-print space-y-3">
          {/* Nuevo vs reimprimir todo */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Imprimir:</span>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setReprintAll(false)}
                className={
                  !reprintAll
                    ? "rounded-md bg-ninja-flame/15 px-3 py-1 text-sm font-medium text-ninja-flameSoft"
                    : "rounded-md px-3 py-1 text-sm text-muted-foreground transition hover:text-foreground"
                }
              >
                Sólo lo nuevo
              </button>
              <button
                type="button"
                onClick={() => setReprintAll(true)}
                className={
                  reprintAll
                    ? "flex items-center gap-1 rounded-md bg-ninja-flame/15 px-3 py-1 text-sm font-medium text-ninja-flameSoft"
                    : "flex items-center gap-1 rounded-md px-3 py-1 text-sm text-muted-foreground transition hover:text-foreground"
                }
              >
                <RotateCcw size={13} /> Reimprimir todo
              </button>
            </div>
            {/* Papel */}
            <div className="ml-auto inline-flex rounded-lg border border-border p-0.5">
              {(["58", "80"] as Paper[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPaper(p)}
                  className={
                    paper === p
                      ? "rounded-md bg-muted px-2.5 py-1 text-xs font-semibold text-foreground"
                      : "rounded-md px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                  }
                >
                  {p}mm
                </button>
              ))}
            </div>
          </div>

          {/* Filtro por estación (si hay más de una estación en el pedido) */}
          {presentStations.length > 1 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStationFilter(null)}
                className={
                  stationFilter === null
                    ? "rounded-lg bg-ninja-flame/15 px-3 py-1 text-sm font-medium text-ninja-flameSoft"
                    : "rounded-lg px-3 py-1 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                }
              >
                Todas
              </button>
              {presentStations.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => setStationFilter(g.station ?? null)}
                  className={
                    (g.station ?? null) === stationFilter
                      ? "rounded-lg bg-ninja-flame/15 px-3 py-1 text-sm font-medium text-ninja-flameSoft"
                      : "rounded-lg px-3 py-1 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  }
                >
                  {stationLabel(g.station)}{" "}
                  <span className="tabular-nums opacity-70">({g.items.length})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Estado vacío */}
        {nothingToPrint ? (
          <p className="no-print rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {reprintAll
              ? "El pedido no tiene ítems para imprimir."
              : "No hay ítems nuevos para enviar. Usá “Reimprimir todo” para reimprimir la comanda completa."}
          </p>
        ) : isLoading ? (
          <p className="no-print py-6 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          // Vista previa = lo que se imprime. .comanda-print aísla al imprimir.
          <div className="comanda-print mx-auto flex max-w-full flex-col items-center gap-4">
            {groups.map((g) => (
              <ComandaSheet
                key={g.key}
                group={g}
                header={header}
                businessName={businessName ?? null}
                printedAtLabel={printedAtLabel}
                widthCls={widthCls}
              />
            ))}
          </div>
        )}

        {/* Acciones (no se imprimen) */}
        <div className="no-print flex items-center gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X size={16} /> Cerrar
          </Button>
          <Button
            onClick={handlePrint}
            disabled={visibleItems.length === 0 || markPrinted.isPending}
            className="ml-auto"
          >
            <Printer size={16} />
            {groups.length > 1 ? `Imprimir ${groups.length} comandas` : "Imprimir comanda"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Una comanda (hoja) de una estación: encabezado grande con la estación, mesa +
// salón, hora y mozo; y la lista de ítems con cantidad + modificadores + notas.
// Negro sobre blanco, angosto (térmica), SIN precios.
function ComandaSheet({
  group,
  header,
  businessName,
  printedAtLabel,
  widthCls,
}: {
  group: StationGroup;
  header: ComandaItem | null;
  businessName: string | null;
  printedAtLabel: string;
  widthCls: string;
}) {
  return (
    <div
      className={`comanda-page ${widthCls} max-w-full rounded-lg border border-neutral-300 bg-white p-3 font-mono text-sm text-black`}
    >
      {/* Nombre del local (opcional) */}
      {businessName && (
        <div className="text-center text-xs font-semibold uppercase tracking-wide text-neutral-600">
          {businessName}
        </div>
      )}

      {/* Encabezado grande: estación */}
      <div className="mt-1 border-y-2 border-black py-1 text-center text-lg font-extrabold uppercase tracking-wide">
        {stationLabel(group.station)}
      </div>

      {/* Mesa + salón + hora + mozo */}
      <div className="mt-2 space-y-0.5 text-[13px] leading-tight">
        <div className="flex items-baseline justify-between">
          <span className="text-base font-bold">
            Mesa {header?.table_label ?? "—"}
          </span>
          {header?.area_name && (
            <span className="text-neutral-600">{header.area_name}</span>
          )}
        </div>
        <div className="flex items-baseline justify-between text-neutral-600">
          <span>{printedAtLabel}</span>
          {header?.waiter_name && <span>Mozo: {header.waiter_name}</span>}
        </div>
      </div>

      <div className="my-2 border-t border-dashed border-neutral-400" />

      {/* Ítems: cantidad + nombre, modificadores y notas. SIN precios. */}
      <ul className="space-y-2">
        {group.items.map((it) => {
          const mods = modifiersSummaryNoPrice(it.modifiers ?? []);
          return (
            <li key={it.item_id} className="leading-tight">
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-extrabold tabular-nums">
                  {formatQty(it.qty)}×
                </span>
                <span className="text-base font-bold">{it.name}</span>
              </div>
              {mods && <div className="pl-7 text-[13px]">— {mods}</div>}
              {it.notes && (
                <div className="mt-0.5 pl-7 text-[13px] font-semibold">
                  ▸ {it.notes}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
