"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChefHat,
  CircleDot,
  Clock,
  Flame,
  Printer,
  RefreshCw,
  Undo2,
  Utensils,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  useDiningEnabled,
  useKdsTickets,
  useKdsMutations,
} from "@/modules/dining/hooks";
import { ComandaModal } from "@/components/dining/ComandaModal";
import {
  KDS_STATIONS,
  KDS_STATION_LABELS,
  KDS_STATUS_LABELS,
  KDS_NEXT_STATUS,
  type KdsStatus,
  type KdsTicketItem,
} from "@/modules/dining/api";
import { modifiersSummary } from "@/modules/products/modifiers";
import { formatQty } from "@/lib/utils/format";

// Umbrales de demora (min) para alertar visualmente en la tarjeta y el timer.
// >10 min = rojo (demorado), >5 min = ámbar (atención). SLA configurable: H46+.
const WARN_MIN = 5;
const LATE_MIN = 10;

// mm:ss desde un instante ISO hasta `now` (epoch ms). No baja de 0.
function elapsed(fromISO: string, now: number): { mins: number; label: string } {
  const start = new Date(fromISO).getTime();
  const secs = Math.max(0, Math.floor((now - start) / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return { mins, label: `${mins}:${String(rem).padStart(2, "0")}` };
}

// Tono de la tarjeta/timer según demora y estado. "Listo" se ve en verde calmo
// (ya no corre el tiempo de espera de preparación).
function tone(mins: number, status: KdsStatus) {
  if (status === "listo") {
    return {
      card: "border-emerald-400/50 bg-emerald-400/[0.08]",
      timer: "text-emerald-300",
    };
  }
  if (mins >= LATE_MIN) {
    return {
      card: "border-red-500/60 bg-red-500/[0.10] animate-pulse",
      timer: "text-red-300",
    };
  }
  if (mins >= WARN_MIN) {
    return {
      card: "border-amber-400/50 bg-amber-400/[0.08]",
      timer: "text-amber-300",
    };
  }
  return { card: "border-border bg-card", timer: "text-muted-foreground" };
}

const STATION_ICON: Record<string, typeof ChefHat> = {
  cocina: ChefHat,
  parrilla: Flame,
  barra: Utensils,
  cafeteria: Utensils,
  postres: Utensils,
  despacho: Utensils,
};

function stationLabel(s: string | null): string {
  if (!s) return "Sin estación";
  return KDS_STATION_LABELS[s as keyof typeof KDS_STATION_LABELS] ?? s;
}

// Tarjeta de un ítem del pedido en la pantalla de preparación.
function TicketCard({
  item,
  now,
  showStation,
  onAdvance,
  onBack,
  busy,
}: {
  item: KdsTicketItem;
  now: number;
  showStation: boolean;
  onAdvance: (item: KdsTicketItem) => void;
  onBack: (item: KdsTicketItem) => void;
  busy: boolean;
}) {
  const { mins, label } = elapsed(item.created_at, now);
  const t = tone(mins, item.kds_status);
  const mods = modifiersSummary(item.modifiers ?? []);
  const next = KDS_NEXT_STATUS[item.kds_status];

  return (
    <div className={`flex flex-col gap-2 rounded-xl border p-3 transition ${t.card}`}>
      {/* Encabezado: cantidad + nombre, y timer a la derecha */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-extrabold tabular-nums text-ninja-flameSoft">
              {formatQty(item.qty)}×
            </span>
            <span className="text-lg font-bold leading-tight text-foreground">
              {item.name}
            </span>
          </div>
          {showStation && (
            <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {stationLabel(item.station)}
            </span>
          )}
        </div>
        <span
          className={`flex shrink-0 items-center gap-1 text-sm font-bold tabular-nums ${t.timer}`}
          title="Tiempo desde que se cargó el ítem"
        >
          <Clock size={14} /> {label}
        </span>
      </div>

      {/* Modificadores y notas: lo que cocina/barra necesita ver */}
      {mods && (
        <p className="text-sm font-medium text-foreground/90">{mods}</p>
      )}
      {item.notes && (
        <p className="rounded-md bg-amber-400/10 px-2 py-1 text-sm font-medium text-amber-200">
          {item.notes}
        </p>
      )}

      {/* Estado + acciones */}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <CircleDot size={12} /> {KDS_STATUS_LABELS[item.kds_status]}
        </span>
        <div className="flex items-center gap-1.5">
          {item.kds_status !== "pendiente" && (
            <button
              type="button"
              onClick={() => onBack(item)}
              disabled={busy}
              className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
              aria-label="Volver atrás"
              title="Volver al estado anterior"
            >
              <Undo2 size={16} />
            </button>
          )}
          {next && (
            <button
              type="button"
              onClick={() => onAdvance(item)}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-ninja-flame px-3 text-sm font-semibold text-ninja-voidViolet shadow-ninjaGlow transition hover:brightness-110 disabled:opacity-50"
            >
              {next === "preparando" && <ChefHat size={15} />}
              {next === "listo" && <Check size={15} />}
              {next === "entregado" && <Check size={15} />}
              {next === "preparando"
                ? "Preparar"
                : next === "listo"
                  ? "Listo"
                  : "Entregar"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function KdsInner() {
  const router = useRouter();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const { data: diningEnabled, isLoading: loadingFlag } = useDiningEnabled();

  // Estación activa: ?station=<x>. Vacío / "all" = todas las estaciones.
  const stationParam = searchParams.get("station");
  const activeStation =
    stationParam && stationParam !== "all" ? stationParam : null;

  const { data: items, isFetching, refetch } = useKdsTickets(activeStation);
  const { setStatus } = useKdsMutations();

  // Comanda impresa (H45) desde el KDS: reimprime la comanda de una mesa. Si hay
  // estación activa, la comanda arranca filtrada a esa estación.
  const [comandaOrderId, setComandaOrderId] = useState<string | null>(null);

  // Tick local de 1s para que los timers avancen sin depender del refetch (~4s).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  function setStation(s: string | null) {
    router.replace((s ? `/kds?station=${s}` : "/kds") as Route);
  }

  async function advance(item: KdsTicketItem) {
    const next = KDS_NEXT_STATUS[item.kds_status];
    if (!next) return;
    try {
      await setStatus.mutateAsync({ itemId: item.item_id, status: next });
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function back(item: KdsTicketItem) {
    const prev: KdsStatus =
      item.kds_status === "listo"
        ? "preparando"
        : item.kds_status === "preparando"
          ? "pendiente"
          : "pendiente";
    try {
      await setStatus.mutateAsync({ itemId: item.item_id, status: prev });
    } catch (e) {
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  // Agrupa los ítems por mesa/pedido (encabezado de columna). Conserva el orden
  // FIFO que ya trae la RPC: la primera vez que aparece una mesa fija su posición.
  const groups = useMemo(() => {
    const byOrder = new Map<
      string,
      { tableLabel: string; areaName: string | null; items: KdsTicketItem[] }
    >();
    for (const it of items ?? []) {
      const g = byOrder.get(it.order_id);
      if (g) {
        g.items.push(it);
      } else {
        byOrder.set(it.order_id, {
          tableLabel: it.table_label,
          areaName: it.area_name,
          items: [it],
        });
      }
    }
    return [...byOrder.entries()];
  }, [items]);

  // Modo gastronómico apagado → aviso (mismo criterio que /salon).
  if (!loadingFlag && !diningEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Utensils size={36} className="mx-auto text-ninja-flameSoft" />
        <h1 className="mt-4 text-2xl font-bold">Modo gastronómico desactivado</h1>
        <p className="mt-2 text-muted-foreground">
          Activá el modo gastronómico para usar la pantalla de cocina (KDS).
        </p>
        <Link
          href={"/configuracion?seccion=operacion" as Route}
          className="mt-6 inline-block rounded-lg bg-ninja-flame px-4 py-2 text-sm font-semibold text-ninja-voidViolet"
        >
          Ir a Configuración
        </Link>
      </div>
    );
  }

  const totalActive = (items ?? []).length;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Barra superior fija: volver, título, tabs de estación, estado de refresco */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-3">
          <Link
            href={"/salon" as Route}
            className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Volver al salón"
            title="Volver al salón"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <ChefHat size={20} className="text-ninja-flameSoft" /> Cocina
            <span className="rounded-full bg-ninja-flame/15 px-2 py-0.5 text-sm font-semibold text-ninja-flameSoft tabular-nums">
              {totalActive}
            </span>
          </h1>
          <button
            type="button"
            onClick={() => refetch()}
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Actualizar ahora"
            title="Actualizar ahora"
          >
            <RefreshCw size={16} className={isFetching ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Tabs de estación */}
        <div className="slim-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
          <StationTab
            label="Todas"
            active={activeStation === null}
            onClick={() => setStation(null)}
          />
          {KDS_STATIONS.map((s) => {
            const Icon = STATION_ICON[s] ?? Utensils;
            return (
              <StationTab
                key={s}
                label={KDS_STATION_LABELS[s]}
                icon={<Icon size={14} />}
                active={activeStation === s}
                onClick={() => setStation(s)}
              />
            );
          })}
        </div>
      </header>

      {/* Tablero de tickets */}
      <main className="flex-1 p-4">
        {totalActive === 0 ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
            <Check size={34} className="text-emerald-400" />
            <p className="text-sm text-muted-foreground">
              {activeStation
                ? `No hay pedidos pendientes en ${KDS_STATION_LABELS[activeStation as keyof typeof KDS_STATION_LABELS] ?? activeStation}.`
                : "No hay pedidos pendientes. Todo al día."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {groups.map(([orderId, g]) => (
              <section
                key={orderId}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/20 p-2.5"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-base font-bold">
                    <Utensils size={15} className="text-ninja-flameSoft" />
                    Mesa {g.tableLabel}
                  </span>
                  <div className="flex items-center gap-2">
                    {g.areaName && (
                      <span className="text-xs text-muted-foreground">
                        {g.areaName}
                      </span>
                    )}
                    {/* Imprimir comanda de esta mesa (H45). Reusa el modal de
                        comanda; si hay estación activa, arranca filtrada a ella. */}
                    <button
                      type="button"
                      onClick={() => setComandaOrderId(orderId)}
                      className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      aria-label="Imprimir comanda"
                      title="Imprimir comanda"
                    >
                      <Printer size={14} />
                    </button>
                  </div>
                </div>
                {g.items.map((it) => (
                  <TicketCard
                    key={it.item_id}
                    item={it}
                    now={now}
                    showStation={activeStation === null}
                    onAdvance={advance}
                    onBack={back}
                    busy={setStatus.isPending}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </main>

      {/* Comanda impresa por estación (H45) de la mesa elegida */}
      <ComandaModal
        open={comandaOrderId !== null}
        onOpenChange={(o) => {
          if (!o) setComandaOrderId(null);
        }}
        orderId={comandaOrderId}
        initialStation={activeStation}
      />
    </div>
  );
}

function StationTab({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex shrink-0 items-center gap-1.5 rounded-lg bg-ninja-flame/15 px-3 py-1.5 text-sm font-semibold text-ninja-flameSoft"
          : "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      }
    >
      {icon}
      {label}
    </button>
  );
}

export default function KdsPage() {
  return (
    <Suspense fallback={null}>
      <KdsInner />
    </Suspense>
  );
}
