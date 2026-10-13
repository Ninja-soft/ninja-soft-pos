"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Bike,
  Check,
  ChefHat,
  CircleDot,
  Clock,
  Flame,
  Play,
  Printer,
  RefreshCw,
  Siren,
  Undo2,
  Utensils,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  useAckKdsVoid,
  useDiningEnabled,
  useKdsHeldCourses,
  useKdsRecentVoids,
  useKdsSla,
  useKdsTickets,
  useKdsMutations,
} from "@/modules/dining/hooks";
import { kdsTone, resolveKdsSla, type KdsSlaRule } from "@/lib/gastro/kdsSla";
import {
  courseColumns,
  groupByCourse,
  heldOnlyOrders,
  nextHeldCourse,
  orderColumns,
} from "@/lib/gastro/kdsGroups";
import { ComandaModal } from "@/components/dining/ComandaModal";
import {
  COURSE_LABELS,
  KDS_STATIONS,
  KDS_STATION_LABELS,
  KDS_STATUS_LABELS,
  KDS_NEXT_STATUS,
  type KdsHeldCourse,
  type KdsStatus,
  type KdsTicketItem,
} from "@/modules/dining/api";
import { modifiersSummary } from "@/modules/products/modifiers";
import { formatQty } from "@/lib/utils/format";

// Umbrales de demora: SLA por estación (pos_settings.kds_sla, Configuración →
// Salones y mesas). Sin configurar: ámbar a 5 min, rojo a 10 min.

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
function tone(mins: number, status: KdsStatus, rule: KdsSlaRule) {
  if (status === "listo") {
    return {
      card: "border-emerald-400/50 bg-emerald-400/[0.08]",
      timer: "text-success",
    };
  }
  const level = kdsTone(mins, rule);
  if (level === "late") {
    return {
      card: "border-red-500/60 bg-red-500/[0.10] animate-pulse",
      timer: "text-danger",
    };
  }
  if (level === "warn") {
    return {
      card: "border-amber-400/50 bg-amber-400/[0.08]",
      timer: "text-warning",
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
  sla,
  showOrder = false,
}: {
  item: KdsTicketItem;
  sla: KdsSlaRule;
  showOrder?: boolean;
  now: number;
  showStation: boolean;
  onAdvance: (item: KdsTicketItem) => void;
  onBack: (item: KdsTicketItem) => void;
  busy: boolean;
}) {
  const { mins, label } = elapsed(item.created_at, now);
  const t = tone(mins, item.kds_status, sla);
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
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {showOrder && (
              <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                {item.source_label}
              </span>
            )}
            {item.priority === "urgente" && (
              <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold uppercase text-danger">
                <Siren size={11} /> Urgente
              </span>
            )}
            {/* Tiempo (course): la cocina ve la secuencia entrada→principal→postre. */}
            <span
              className="inline-block rounded bg-ninja-flame/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ninja-flameSoft"
              title={`Tiempo ${item.course}`}
            >
              T{item.course}
              {COURSE_LABELS[item.course] ? ` · ${COURSE_LABELS[item.course]}` : ""}
            </span>
            {showStation && (
              <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {stationLabel(item.station)}
              </span>
            )}
          </div>
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
      {/* ALERGIA / intolerancia (F13 · H47): lo más visible de la tarjeta — rojo,
          en negrita y con ⚠. Es seguridad alimentaria, no una nota más. */}
      {item.allergens && (
        <p className="flex items-start gap-1.5 rounded-md border border-red-500/60 bg-red-500/15 px-2 py-1 text-sm font-bold uppercase tracking-wide text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>Alergia: {item.allergens}</span>
        </p>
      )}
      {item.notes && (
        <p className="rounded-md bg-amber-400/10 px-2 py-1 text-sm font-medium text-warning">
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
              className="flex h-9 items-center gap-1.5 rounded-lg bg-ninja-flame px-3 text-sm font-semibold text-ninja-voidViolet transition hover:brightness-110 disabled:opacity-50"
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

  // Vista: por pedido (default) o por curso (?vista=curso), ADR-097.
  const byCourse = searchParams.get("vista") === "curso";

  const { data: items, isFetching, refetch } = useKdsTickets(activeStation);
  const { setStatus, fireCourse } = useKdsMutations();
  // Tiempos en espera (no disparados) por pedido: "Marchar" el siguiente.
  const { data: held } = useKdsHeldCourses(activeStation);
  const { data: slaConfig } = useKdsSla();
  // Anulaciones recientes (H45): aviso a cocina hasta que tocan "Visto".
  const { data: voids } = useKdsRecentVoids(activeStation, Boolean(diningEnabled));
  const ackVoid = useAckKdsVoid();

  // Comanda impresa (H45) desde el KDS: reimprime la comanda de una mesa. Si hay
  // estación activa, la comanda arranca filtrada a esa estación.
  const [comandaOrderId, setComandaOrderId] = useState<string | null>(null);

  // Tick local de 1s para que los timers avancen sin depender del refetch (~4s).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  function go(station: string | null, course: boolean) {
    const q = new URLSearchParams();
    if (station) q.set("station", station);
    if (course) q.set("vista", "curso");
    const qs = q.toString();
    router.replace((qs ? `/kds?${qs}` : "/kds") as Route);
  }

  function setStation(s: string | null) {
    go(s, byCourse);
  }

  async function march(h: KdsHeldCourse) {
    try {
      const fired = await fireCourse.mutateAsync({ source: h.source, orderId: h.order_id, course: h.course });
      toast({
        title: fired > 0 ? `Marcha ${COURSE_LABELS[h.course] ?? `Tiempo ${h.course}`} · ${h.source_label}` : "No quedaba nada en espera",
        variant: fired > 0 ? "success" : "info",
      });
    } catch (e) {
      toast({
        title: "No se pudo marchar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
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

  // Agrupa los ítems por pedido (encabezado de columna). Conserva el orden FIFO
  // que ya trae la RPC: la primera vez que aparece un pedido fija su posición.
  // El pedido puede ser de MESA o de DELIVERY/TAKEAWAY (F13 · H49): `source` y
  // `source_label` ("Mesa 5" / "DELIVERY #1234") vienen de la RPC unificada.
  // Urgentes primero (ADR-097), después FIFO.
  const groups = useMemo(
    () =>
      orderColumns(items ?? []).map((c) => {
        const first = c.items[0]!;
        return {
          orderId: c.orderId,
          urgent: c.urgent,
          label: first.source_label,
          areaName: first.area_name,
          source: first.source,
          items: c.items,
        };
      }),
    [items],
  );
  const courseCols = useMemo(() => courseColumns(items ?? []), [items]);
  // Pedidos que sólo tienen tiempos en espera: la cocina ve qué viene.
  const waitingOnly = useMemo(
    () => heldOnlyOrders(held ?? [], new Set((items ?? []).map((i) => i.order_id))),
    [held, items],
  );

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
  const nothing = totalActive === 0 && waitingOnly.length === 0;

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
          <div className="ml-auto flex items-center rounded-md border border-border p-0.5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => go(activeStation, false)}
              aria-pressed={!byCourse}
              className={`min-h-8 rounded px-2.5 ${!byCourse ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            >
              Por pedido
            </button>
            <button
              type="button"
              onClick={() => go(activeStation, true)}
              aria-pressed={byCourse}
              className={`min-h-8 rounded px-2.5 ${byCourse ? "bg-muted text-foreground" : "text-muted-foreground"}`}
            >
              Por curso
            </button>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
        {/* Anulaciones (H45): el mozo anuló algo que ya estaba en cocina. */}
        {(voids ?? []).length > 0 && (
          <div className="mb-4 space-y-2" role="alert">
            {(voids ?? []).map((v) => (
              <div
                key={v.void_id}
                className="flex items-center gap-3 rounded-md border-t-2 border-red-500 bg-red-500/10 px-3 py-2"
              >
                <AlertTriangle size={18} className="shrink-0 text-danger" />
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-bold uppercase text-danger">Anulado</span>{" "}
                  <span className="font-semibold">
                    {formatQty(v.qty)}× {v.name}
                  </span>
                  {v.table_label
                    ? v.source === "delivery"
                      ? ` · ${v.table_label}`
                      : ` · Mesa ${v.table_label}`
                    : ""}
                  <span className="block truncate text-xs text-muted-foreground">
                    {v.reason}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => ackVoid.mutate(v.void_id)}
                  disabled={ackVoid.isPending}
                  className="h-10 shrink-0 rounded-md border border-border px-3 text-sm font-semibold hover:bg-muted"
                >
                  Visto
                </button>
              </div>
            ))}
          </div>
        )}
        {nothing ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
            <Check size={34} className="text-success" />
            <p className="text-sm text-muted-foreground">
              {activeStation
                ? `No hay pedidos pendientes en ${KDS_STATION_LABELS[activeStation as keyof typeof KDS_STATION_LABELS] ?? activeStation}.`
                : "No hay pedidos pendientes. Todo al día."}
            </p>
          </div>
        ) : (
          byCourse ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {courseCols.map((col) => (
              <section
                key={col.course}
                className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2.5"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="text-base font-bold">
                    T{col.course}
                    {COURSE_LABELS[col.course] ? ` · ${COURSE_LABELS[col.course]}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{col.items.length}</span>
                </div>
                {col.items.map((it) => (
                  <TicketCard
                    key={it.item_id}
                    item={it}
                    now={now}
                    showStation={activeStation === null}
                    showOrder
                    onAdvance={advance}
                    onBack={back}
                    busy={setStatus.isPending}
                    sla={resolveKdsSla(slaConfig, it.station)}
                  />
                ))}
              </section>
            ))}
            {waitingOnly.length > 0 && (
              <WaitingColumn held={waitingOnly} onMarch={march} busy={fireCourse.isPending} />
            )}
          </div>
          ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {groups.map((g) => {
              const orderId = g.orderId;
              const nextHeld = nextHeldCourse(held ?? [], orderId);
              const courses = groupByCourse(g.items);
              return (
              <section
                key={orderId}
                className={`flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5 ${
                  g.urgent ? "border-border border-t-2 border-t-red-500" : "border-border"
                }`}
              >
                <div className="flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-base font-bold">
                    {g.source === "delivery" ? (
                      <Bike size={15} className="text-info" />
                    ) : (
                      <Utensils size={15} className="text-ninja-flameSoft" />
                    )}
                    {g.label}
                    {g.urgent && (
                      <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-bold uppercase text-danger">
                        <Siren size={11} /> Urgente
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    {g.areaName && (
                      <span className="text-xs text-muted-foreground">
                        {g.areaName}
                      </span>
                    )}
                    {/* Imprimir comanda (H45): sólo para mesa (la comanda impresa
                        de delivery es follow-up). El KDS de delivery muestra el
                        pedido igual; sólo no ofrece el modal de comanda de mesa. */}
                    {g.source === "mesa" && (
                      <button
                        type="button"
                        onClick={() => setComandaOrderId(orderId)}
                        className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        aria-label="Imprimir comanda"
                        title="Imprimir comanda"
                      >
                        <Printer size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {courses.map((c) => (
                  <div key={c.course} className="flex flex-col gap-2">
                    {courses.length > 1 && (
                      <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        T{c.course}
                        {COURSE_LABELS[c.course] ? ` · ${COURSE_LABELS[c.course]}` : ""}
                      </span>
                    )}
                    {c.items.map((it) => (
                      <TicketCard
                        key={it.item_id}
                        item={it}
                        now={now}
                        showStation={activeStation === null}
                        onAdvance={advance}
                        onBack={back}
                        busy={setStatus.isPending}
                        sla={resolveKdsSla(slaConfig, it.station)}
                      />
                    ))}
                  </div>
                ))}
                {/* Próximo tiempo en espera: la cocina lo marcha cuando corresponde. */}
                {nextHeld && (
                  <MarchRow h={nextHeld} onMarch={march} busy={fireCourse.isPending} />
                )}
              </section>
              );
            })}
            {waitingOnly.length > 0 && (
              <WaitingColumn held={waitingOnly} onMarch={march} busy={fireCourse.isPending} />
            )}
          </div>
          )
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

// "En espera: T2 · Principal (3)" + Marchar.
function MarchRow({
  h,
  onMarch,
  busy,
  showLabel = false,
}: {
  h: KdsHeldCourse;
  onMarch: (h: KdsHeldCourse) => void;
  busy: boolean;
  showLabel?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-2.5 py-2">
      <span className="min-w-0 text-sm">
        {showLabel && <span className="block truncate font-semibold">{h.source_label}</span>}
        <span className="text-muted-foreground">
          En espera: T{h.course}
          {COURSE_LABELS[h.course] ? ` · ${COURSE_LABELS[h.course]}` : ""} ({h.held})
        </span>
      </span>
      <button
        type="button"
        onClick={() => onMarch(h)}
        disabled={busy}
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold hover:bg-muted disabled:opacity-50"
      >
        <Play size={14} /> Marchar
      </button>
    </div>
  );
}

// Pedidos sin nada en preparación pero con tiempos en espera.
function WaitingColumn({
  held,
  onMarch,
  busy,
}: {
  held: KdsHeldCourse[];
  onMarch: (h: KdsHeldCourse) => void;
  busy: boolean;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2.5">
      <span className="px-1 text-sm font-bold">Próximos tiempos</span>
      {held.map((h) => (
        <MarchRow key={`${h.order_id}-${h.course}`} h={h} onMarch={onMarch} busy={busy} showLabel />
      ))}
    </section>
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
