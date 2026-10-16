"use client";

// Logística › Mapa en vivo (ADR-164, R12, R13): los camiones del día con su
// última posición y antigüedad, la ruta planificada en gris, el recorrido
// real en el color del camión, las paradas por estado (entregada en verde,
// no entregada en rojo) y la llegada estimada a la próxima. Tocar una parada
// abre su detalle (remito, ubicación, foto, firma, camión y repartidor).
// Avisos de desvío y de paradas salteadas. Polling cada 15 s.

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route as NextRoute } from "next";
import { AlertTriangle, BatteryLow, BatteryMedium, ChevronLeft, ChevronRight, Clock, Gauge, Map as MapIcon, RefreshCw, Truck } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { LogisticsLocked } from "@/components/logistics/LogisticsLocked";
import { RouteMap, type MapRoute, type MapStop } from "@/components/logistics/map/RouteMap";
import { StopDetailSheet } from "@/components/logistics/map/StopDetailSheet";
import { cn } from "@/lib/utils/cn";
import { ROUTE_STATUS_LABEL, ROUTE_STATUS_TONE, arToday, formatDistance, logisticsErrorMessage, stopIsFinal } from "@/lib/logistics/logic";
import { truckColor } from "@/lib/logistics/planning";
import { DEFAULT_TRACKING, FRESHNESS_LABEL, ageLabel, clock, freshness, kmh, liveEta, skippedStops, type Freshness } from "@/lib/logistics/tracking";
import { useCan } from "@/modules/logistics/api";
import { useMapMutations, useRouteLive, useRouteTrack, useTrackingSettings, type LiveRoute } from "@/modules/logistics/map";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";

const FRESH_TONE: Record<Freshness, "success" | "warning" | "neutral"> = { vivo: "success", demorado: "warning", sin_senal: "neutral" };

function shiftDate(d: string, days: number): string {
  return new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Reloj que avanza cada 5 s (antigüedad de la posición y ETA). */
function useNow(stepMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

interface RouteView {
  route: LiveRoute;
  color: string;
  done: number;
  next: LiveRoute["stops"][number] | null;
  etas: Record<string, number>;
  fresh: Freshness | null;
  ageMs: number | null;
  skipped: number[];
}

function TruckCard({
  v,
  selected,
  onSelect,
  onAck,
  acking,
}: {
  v: RouteView;
  selected: boolean;
  onSelect: () => void;
  onAck: (id: string) => void;
  acking: boolean;
}) {
  const r = v.route;
  const total = r.stops.length;
  const pct = total ? Math.round((v.done / total) * 100) : 0;
  const speed = kmh(r.last?.speed_mps);
  return (
    <div className={cn("rounded-lg bg-card ring-1 transition", selected ? "ring-ninja-flameSoft" : "ring-border")}>
      <button type="button" onClick={onSelect} aria-pressed={selected} className="w-full p-4 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: v.color }} />
            <span className="truncate font-semibold">Hoja N° {r.number}</span>
          </span>
          <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {[r.vehicle ? `${r.vehicle.name}${r.vehicle.plate ? ` (${r.vehicle.plate})` : ""}` : "Sin vehículo", r.driver?.name ?? "Sin repartidor"].join(" · ")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {v.done}/{total}
          </span>
        </div>
        {r.status === "en_curso" && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {v.fresh ? (
              <Badge tone={FRESH_TONE[v.fresh]}>
                {FRESHNESS_LABEL[v.fresh]} · {ageLabel(v.ageMs ?? 0)}
              </Badge>
            ) : (
              <Badge tone="neutral">Sin posición todavía</Badge>
            )}
            {speed !== null && speed > 0 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Gauge size={13} aria-hidden /> {speed} km/h
              </span>
            )}
            {r.last?.battery != null && (
              <span className={cn("inline-flex items-center gap-1", r.last.battery <= 20 ? "text-danger" : "text-muted-foreground")}>
                {r.last.battery <= 20 ? <BatteryLow size={13} aria-hidden /> : <BatteryMedium size={13} aria-hidden />} {r.last.battery}%
              </span>
            )}
          </div>
        )}
        {v.next && r.status === "en_curso" && (
          <p className="mt-2 flex items-center gap-1.5 text-sm">
            <Clock size={14} className="text-muted-foreground" aria-hidden />
            Próxima: {v.next.seq}. {v.next.contact_name ?? "Parada"}
            {v.etas[v.next.id] ? <span className="text-muted-foreground"> · {clock(v.etas[v.next.id])} aprox.</span> : null}
          </p>
        )}
        {v.skipped.length > 0 && (
          <p className="mt-2 text-sm text-warning">
            {v.skipped.length === 1 ? `Salteó la parada ${v.skipped[0]}` : `Salteó las paradas ${v.skipped.join(", ")}`}
          </p>
        )}
      </button>
      {r.alert && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-b-lg bg-danger/10 px-4 py-2 text-sm text-danger">
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={15} aria-hidden />
            {r.alert.ended_at ? "Se desvió" : "Fuera de ruta"}
            {r.alert.max_distance_m ? ` a ${formatDistance(r.alert.max_distance_m)}` : ""} desde las {clock(r.alert.started_at)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onAck(r.alert!.id)} loading={acking}>
            Visto
          </Button>
        </div>
      )}
    </div>
  );
}

export function LiveMapPage() {
  const enabled = useFeature("reparto_propio");
  const canTrack = useCan("logistics.track");
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = arToday();
  const [date, setDate] = useState(params.get("dia") ?? today);
  const selected = params.get("hoja");
  const [stopId, setStopId] = useState<string | null>(null);
  const { filterStoreId } = useBranchContext();
  const live = useRouteLive(date, filterStoreId, enabled === true && canTrack);
  const { data: cfg = DEFAULT_TRACKING } = useTrackingSettings(enabled === true);
  const routes = useMemo(() => live.data ?? [], [live.data]);
  const sel = routes.find((r) => r.id === selected) ?? null;
  const { data: trail = [] } = useRouteTrack(sel && (sel.status === "en_curso" || sel.status === "cerrada") ? sel.id : null, sel?.status === "en_curso");
  const m = useMapMutations();
  const now = useNow();

  function select(id: string | null) {
    const q = new URLSearchParams(params.toString());
    if (id) q.set("hoja", id);
    else q.delete("hoja");
    router.replace(`${pathname}?${q.toString()}` as NextRoute, { scroll: false });
  }

  const views: RouteView[] = useMemo(
    () =>
      routes.map((r, i) => {
        const open = r.stops.filter((s) => !stopIsFinal(s.status));
        const from = r.last ? { lat: r.last.lat, lng: r.last.lng } : r.origin?.lat != null && r.origin.lng != null ? { lat: r.origin.lat, lng: r.origin.lng } : null;
        const ageMs = r.last ? now - Date.parse(r.last.recorded_at) : null;
        return {
          route: r,
          color: truckColor(i),
          done: r.stops.length - open.length,
          next: open.sort((a, b) => a.seq - b.seq)[0] ?? null,
          etas: r.status === "en_curso" ? liveEta(now, from, open, cfg) : {},
          fresh: ageMs === null ? null : freshness(ageMs),
          ageMs,
          skipped: r.status === "en_curso" ? skippedStops(r.stops) : [],
        };
      }),
    [routes, now, cfg],
  );

  const mapRoutes: MapRoute[] = useMemo(
    () =>
      views.map((v) => {
        const r = v.route;
        const planned =
          r.planned_path && r.planned_path.length >= 2
            ? r.planned_path
            : ([
                ...(r.origin?.lat != null && r.origin.lng != null ? [[r.origin.lat, r.origin.lng]] : []),
                ...r.stops.filter((s) => s.lat !== null && s.lng !== null).map((s) => [s.lat, s.lng]),
              ] as [number, number][]);
        const stale = v.fresh === "sin_senal";
        return {
          id: r.id,
          color: v.color,
          planned,
          actual: sel?.id === r.id ? trail : undefined,
          truck:
            r.last && (r.status === "en_curso" || sel?.id === r.id)
              ? {
                  lat: r.last.lat,
                  lng: r.last.lng,
                  label: `${r.vehicle?.name ?? `Hoja ${r.number}`} · ${ageLabel(v.ageMs ?? 0)}`,
                  stale,
                  alert: Boolean(r.alert && !r.alert.ended_at),
                }
              : null,
          dim: Boolean(sel && sel.id !== r.id),
        };
      }),
    [views, sel, trail],
  );

  const mapStops: MapStop[] = useMemo(
    () =>
      views.flatMap((v) =>
        sel && sel.id !== v.route.id
          ? []
          : v.route.stops.map((s) => ({ id: s.id, seq: s.seq, lat: s.lat, lng: s.lng, status: s.status, color: v.color, title: s.contact_name ?? undefined })),
      ),
    [views, sel],
  );

  const stopRoute = stopId ? (routes.find((r) => r.stops.some((s) => s.id === stopId)) ?? null) : null;
  const stopView = stopRoute ? views.find((v) => v.route.id === stopRoute.id) : null;
  const origin = (sel ?? routes[0])?.origin;

  async function ack(id: string) {
    try {
      await m.ackAlert.mutateAsync(id);
    } catch (e) {
      toast({ title: "No se pudo marcar", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Logística"
      title="Mapa en vivo"
      icon={MapIcon}
      description="Dónde está cada camión, qué entregó y cuándo llega a la próxima parada."
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <LogisticsLocked
          title="El reparto propio no está incluido en tu plan"
          description="Seguí tus camiones en el mapa, mirá cada entrega con su firma y su foto y enterate si alguno se desvía."
        />
      </PageContainer>
    );
  }
  if (!canTrack) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <EmptyState className="mt-8" icon={MapIcon} title="No tenés permiso para ver el seguimiento" description="Pedile al dueño el permiso Ver el seguimiento (Logística)." />
      </PageContainer>
    );
  }

  const updated = live.dataUpdatedAt ? ageLabel(now - live.dataUpdatedAt) : null;

  return (
    <PageContainer size="2xl">
      {header}
      <LogisticsNav className="mt-4" />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button size="icon" variant="secondary" aria-label="Día anterior" onClick={() => setDate((d) => shiftDate(d, -1))}>
          <ChevronLeft size={18} />
        </Button>
        <label>
          <span className="sr-only">Día</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm" />
        </label>
        <Button size="icon" variant="secondary" aria-label="Día siguiente" onClick={() => setDate((d) => shiftDate(d, 1))}>
          <ChevronRight size={18} />
        </Button>
        <span className="ml-1 text-sm font-semibold">{date === today ? "Hoy" : date.split("-").reverse().join("/")}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {updated && `Actualizado ${updated}`}
          <Button size="icon" variant="ghost" aria-label="Actualizar" onClick={() => void live.refetch()} loading={live.isFetching}>
            <RefreshCw size={16} />
          </Button>
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="order-2 space-y-2 lg:order-1">
          {live.isLoading ? (
            [0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)
          ) : live.error ? (
            <EmptyState compact icon={Truck} title="No se pudo cargar el mapa" description={logisticsErrorMessage(live.error)} />
          ) : views.length === 0 ? (
            <EmptyState compact icon={Truck} title="No hay hojas para este día" description="Cuando planifiques el reparto, los camiones aparecen acá." />
          ) : (
            <>
              {sel && (
                <Button size="sm" variant="ghost" onClick={() => select(null)}>
                  Ver todos los camiones
                </Button>
              )}
              {views.map((v) => (
                <TruckCard
                  key={v.route.id}
                  v={v}
                  selected={sel?.id === v.route.id}
                  onSelect={() => select(sel?.id === v.route.id ? null : v.route.id)}
                  onAck={ack}
                  acking={m.ackAlert.isPending}
                />
              ))}
            </>
          )}
        </div>
        <div className="order-1 lg:order-2">
          <RouteMap
            routes={mapRoutes}
            stops={mapStops}
            origin={origin?.lat != null && origin.lng != null ? [origin.lat, origin.lng] : null}
            selectedStopId={stopId}
            onStopClick={setStopId}
            onTruckClick={(id) => select(id)}
            fitKey={`${date}:${sel?.id ?? "todos"}:${routes.length}`}
            height="min(62dvh, 640px)"
            label="Mapa con los camiones y las paradas del día"
          />
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-success" /> Entregada
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-danger" /> No entregada
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-5 bg-muted-foreground" /> Ruta planificada
            </span>
            <span>Tocá una parada para ver la entrega.</span>
          </p>
        </div>
      </div>

      <StopDetailSheet route={stopRoute} stopId={stopId} eta={stopId && stopView ? (stopView.etas[stopId] ?? null) : null} onClose={() => setStopId(null)} />
    </PageContainer>
  );
}
LiveMapPage.displayName = "LiveMapPage";
