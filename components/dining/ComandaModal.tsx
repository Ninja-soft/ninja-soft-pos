"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer, RotateCcw, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useComandaData, useMarkComandaPrinted } from "@/modules/dining/hooks";
import {
  COURSE_LABELS,
  KDS_STATIONS,
  KDS_STATION_LABELS,
} from "@/modules/dining/api";
import {
  useDeliveryComandaData,
  useMarkDeliveryComandaPrinted,
} from "@/modules/delivery/hooks";
import {
  DELIVERY_CHANNEL_LABELS,
  type DeliveryChannel,
  type DeliveryOrder,
} from "@/modules/delivery/api";
import { modifiersSummaryNoPrice, type SaleLineModifierGroup } from "@/modules/products/modifiers";
import { webPrintCopies } from "@/lib/print/webPrint";
import { formatQty } from "@/lib/utils/format";

// F13 · H45 (mesa) + H49 (delivery/takeaway) — Comanda impresa por estación.
//
// Es un ticket de COCINA (no de venta): SIN precios ni totales. Agrupa los ítems
// DISPARADOS del pedido por `station` (snapshot del producto, H46) y emite UNA
// comanda por estación (cocina lo suyo, barra lo suyo). Ítems sin estación → una
// comanda "Sin estación". Reusa el flujo de impresión web de los tickets
// (window.print + CSS print): la clase .comanda-print aísla el contenido y
// .comanda-page fuerza un salto de página entre estaciones (ver globals.css).
//
// Evita re-imprimir: por defecto imprime sólo lo NUEVO (printed_at null). Al
// imprimir, marca esas líneas como enviadas (mark_comanda_printed /
// mark_delivery_comanda_printed). "Reimprimir todo" trae todas las líneas (no
// repisa la marca original).
//
// FUENTE (`source`): el mismo modal sirve para MESA y DELIVERY/TAKEAWAY. Cambia
// sólo (a) la RPC de datos/marcado y (b) el ENCABEZADO de la comanda: para mesa
// "Mesa N · salón · mozo"; para delivery "DELIVERY/TAKEAWAY #1234 · cliente /
// teléfono / dirección / horario prometido / cadete". El render por estación, el
// filtro nuevo/reimprimir, el papel y la impresión son comunes.

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

// Forma mínima común de una línea de comanda (mesa o delivery) para el render.
interface ComandaLine {
  item_id: string;
  name: string;
  qty: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  // Alergia/intolerancia (F13 · H47): se imprime DESTACADA (recuadro + ⚠).
  allergens: string | null;
  station: string | null;
  course: number;
}

// Datos del encabezado de la comanda. `kind` decide qué bloque se dibuja.
type ComandaHeaderInfo =
  | {
      kind: "table";
      tableLabel: string | null;
      areaName: string | null;
      waiterName: string | null;
    }
  | {
      kind: "delivery";
      sourceLabel: string; // "DELIVERY #1234" / "TAKEAWAY #1234"
      channelLabel: string | null;
      customerName: string | null;
      customerPhone: string | null;
      address: string | null;
      promisedAt: string | null;
      courierName: string | null;
    };

interface StationGroup {
  key: string; // station ?? "__none__"
  station: string | null;
  items: ComandaLine[];
}

// Agrupa las líneas por estación, respetando STATION_ORDER (sin estación al final).
function groupByStation(items: ComandaLine[]): StationGroup[] {
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

// Props del modal: discriminadas por `source`. Mesa = el flujo original (H45).
// Delivery = pasa el pedido para completar el encabezado con datos que no viajan
// en la RPC (teléfono, horario prometido).
type ComandaModalProps = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId: string | null;
  businessName?: string | null;
} & (
  | {
      source?: "table";
      // Estación de origen (opcional): si se abre desde una vista de estación, la
      // comanda arranca filtrada a esa estación.
      initialStation?: string | null;
    }
  | {
      source: "delivery";
      order: DeliveryOrder | null;
    }
);

export function ComandaModal(props: ComandaModalProps) {
  const { open, onOpenChange, orderId, businessName } = props;
  const isDelivery = props.source === "delivery";
  // Lectura de props específicas por fuente (narrowing sobre props.source).
  const initialStation =
    props.source === "delivery" ? null : props.initialStation ?? null;
  const deliveryOrder = props.source === "delivery" ? props.order : null;

  const { toast } = useToast();
  // reprintAll=false → sólo lo nuevo (no enviado). true → todas las líneas.
  const [reprintAll, setReprintAll] = useState(false);
  // Filtro por estación (null = todas). Se siembra con initialStation al abrir.
  const [stationFilter, setStationFilter] = useState<string | null>(initialStation);
  const [paper, setPaper] = useState<Paper>("80");

  // Datos: una u otra RPC según la fuente. Sólo la habilitada hace fetch.
  const tableData = useComandaData(orderId, !reprintAll, open && !isDelivery);
  const deliveryData = useDeliveryComandaData(orderId, !reprintAll, open && isDelivery);
  const markTable = useMarkComandaPrinted();
  const markDelivery = useMarkDeliveryComandaPrinted();

  const isLoading = isDelivery ? deliveryData.isLoading : tableData.isLoading;
  const markPrinted = isDelivery ? markDelivery : markTable;

  // Normaliza las líneas de cualquier fuente a la forma común del render.
  const lines: ComandaLine[] = useMemo(() => {
    if (isDelivery) {
      return (deliveryData.data ?? []).map((it) => ({
        item_id: it.item_id,
        name: it.name,
        qty: it.qty,
        modifiers: it.modifiers ?? [],
        notes: it.notes,
        allergens: it.allergens,
        station: it.station,
        course: it.course,
      }));
    }
    return (tableData.data ?? []).map((it) => ({
      item_id: it.item_id,
      name: it.name,
      qty: it.qty,
      modifiers: it.modifiers ?? [],
      notes: it.notes,
      allergens: it.allergens,
      station: it.station,
      course: it.course,
    }));
  }, [isDelivery, deliveryData.data, tableData.data]);

  // Encabezado de la comanda. Mesa: del primer ítem de la RPC. Delivery: del
  // primer ítem (source_label / canal / cliente / dirección / cadete) + el pedido
  // (teléfono / horario prometido, que no viajan en la RPC).
  const headerInfo: ComandaHeaderInfo | null = useMemo(() => {
    if (isDelivery) {
      const h = (deliveryData.data ?? [])[0] ?? null;
      const sourceLabel =
        h?.source_label ??
        (deliveryOrder
          ? `${deliveryOrder.order_type === "takeaway" ? "TAKEAWAY" : "DELIVERY"} #${deliveryOrder.id.replace(/-/g, "").slice(-4).toUpperCase()}`
          : "PEDIDO");
      const channel: DeliveryChannel | null =
        h?.channel ?? deliveryOrder?.channel ?? null;
      return {
        kind: "delivery",
        sourceLabel,
        channelLabel: channel ? DELIVERY_CHANNEL_LABELS[channel] : null,
        customerName: h?.customer_name ?? deliveryOrder?.customer_name ?? null,
        customerPhone: deliveryOrder?.customer_phone ?? null,
        address: h?.address ?? deliveryOrder?.address ?? null,
        promisedAt: deliveryOrder?.promised_at ?? null,
        courierName: h?.courier_name ?? deliveryOrder?.courier_name ?? null,
      };
    }
    const h = (tableData.data ?? [])[0] ?? null;
    return {
      kind: "table",
      tableLabel: h?.table_label ?? null,
      areaName: h?.area_name ?? null,
      waiterName: h?.waiter_name ?? null,
    };
  }, [isDelivery, deliveryData.data, tableData.data, deliveryOrder]);

  // Reset de estado al abrir/cerrar para que cada apertura empiece limpia.
  useEffect(() => {
    if (open) {
      setReprintAll(false);
      setStationFilter(initialStation);
    }
  }, [open, initialStation]);

  // Grupos por estación, ya filtrados por la estación elegida (si hay).
  const groups = useMemo(() => {
    const all = groupByStation(lines);
    return stationFilter ? all.filter((g) => (g.station ?? null) === stationFilter) : all;
  }, [lines, stationFilter]);

  // Estaciones presentes en el pedido (para las pills de filtro).
  const presentStations = useMemo(() => groupByStation(lines), [lines]);

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
                header={headerInfo}
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

// Una comanda (hoja) de una estación: encabezado grande con la estación, los
// datos del pedido (mesa+salón+mozo para mesa; pedido+cliente/tel/dir/horario/
// cadete para delivery), hora; y la lista de ítems con cantidad + modificadores +
// notas. Negro sobre blanco, angosto (térmica), SIN precios.
function ComandaSheet({
  group,
  header,
  businessName,
  printedAtLabel,
  widthCls,
}: {
  group: StationGroup;
  header: ComandaHeaderInfo | null;
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

      {/* Datos del pedido + hora. Difiere por fuente. */}
      <div className="mt-2 space-y-0.5 text-[13px] leading-tight">
        {header?.kind === "delivery" ? (
          <DeliveryHeaderBlock header={header} printedAtLabel={printedAtLabel} />
        ) : (
          <TableHeaderBlock header={header ?? null} printedAtLabel={printedAtLabel} />
        )}
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
                {/* Tiempo (course): la cocina ve a qué tiempo pertenece la línea. */}
                <span className="ml-auto shrink-0 rounded border border-black px-1 text-[11px] font-bold uppercase">
                  T{it.course}
                  {COURSE_LABELS[it.course] ? ` ${COURSE_LABELS[it.course]}` : ""}
                </span>
              </div>
              {mods && <div className="pl-7 text-[13px]">— {mods}</div>}
              {/* ALERGIA (F13 · H47): recuadro negro + ⚠ + MAYÚSCULAS. En la
                  térmica (B/N) "destacar" = borde grueso + negrita, no color. */}
              {it.allergens && (
                <div className="ml-7 mt-1 border-2 border-black px-1.5 py-0.5 text-[13px] font-extrabold uppercase leading-tight">
                  ⚠ Alergia: {it.allergens}
                </div>
              )}
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

// Encabezado de la comanda de MESA: "Mesa N" + salón + hora + mozo (H45).
function TableHeaderBlock({
  header,
  printedAtLabel,
}: {
  header: Extract<ComandaHeaderInfo, { kind: "table" }> | null;
  printedAtLabel: string;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-base font-bold">Mesa {header?.tableLabel ?? "—"}</span>
        {header?.areaName && <span className="text-neutral-600">{header.areaName}</span>}
      </div>
      <div className="flex items-baseline justify-between text-neutral-600">
        <span>{printedAtLabel}</span>
        {header?.waiterName && <span>Mozo: {header.waiterName}</span>}
      </div>
    </>
  );
}

// Encabezado de la comanda de DELIVERY/TAKEAWAY: "DELIVERY/TAKEAWAY #1234" +
// canal + cliente / teléfono / dirección / horario prometido / cadete + hora.
function DeliveryHeaderBlock({
  header,
  printedAtLabel,
}: {
  header: Extract<ComandaHeaderInfo, { kind: "delivery" }>;
  printedAtLabel: string;
}) {
  const promised = header.promisedAt
    ? new Date(header.promisedAt).toLocaleString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-base font-bold uppercase">{header.sourceLabel}</span>
        {header.channelLabel && (
          <span className="text-neutral-600">{header.channelLabel}</span>
        )}
      </div>
      {header.customerName && (
        <div className="font-semibold">
          {header.customerName}
          {header.customerPhone ? (
            <span className="font-normal text-neutral-600"> · {header.customerPhone}</span>
          ) : null}
        </div>
      )}
      {header.address && <div className="text-neutral-700">{header.address}</div>}
      {promised && <div className="text-neutral-600">Promete: {promised}</div>}
      {header.courierName && (
        <div className="text-neutral-600">Cadete: {header.courierName}</div>
      )}
      <div className="text-neutral-600">{printedAtLabel}</div>
    </>
  );
}
