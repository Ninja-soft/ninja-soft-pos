"use client";

// Logística › Planificar reparto (ADR-164, R9, R19, doc 45 §7.4): las
// entregas listas de la sucursal se reparten entre los camiones elegidos por
// localidad y capacidad, cada hoja ordenada por cercanía con km, horas y
// llegada estimada. Con OpenRouteService (si NinjaSoft cargó la clave) el
// reparto y el recorrido salen por calles; si no, con la heurística local.
// Se ajusta a mano (subir, bajar, pasar a otro camión) y al confirmar se
// crean todas las hojas de una vez.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route as NextRoute } from "next";
import { ArrowDown, ArrowUp, CheckCircle2, MapPinOff, Route as RouteIcon, Sparkles, Truck, Wand2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { LogisticsLocked } from "@/components/logistics/LogisticsLocked";
import { RouteMap, type MapRoute, type MapStop } from "@/components/logistics/map/RouteMap";
import { selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import { arToday, capacityUse, formatDistance, logisticsErrorMessage, type LatLng } from "@/lib/logistics/logic";
import {
  DEFAULT_PLAN_OPTIONS,
  formatDuration,
  groupStops,
  moveStop,
  planProblems,
  planRoutes,
  planToConfirm,
  shiftStop,
  truckColor,
  withOrder,
  type PlanDispatch,
  type PlanOptions,
  type PlanResult,
  type PlanRoute,
  type PlanStop,
  type PlanVehicle,
} from "@/lib/logistics/planning";
import { DEFAULT_TRACKING } from "@/lib/logistics/tracking";
import { useCan, useDrivers, useOrigins, useVehicles } from "@/modules/logistics/api";
import { mapApi, useMapMutations, usePlanCandidates, useRoutingAvailable, useTrackingSettings, type PlanCandidate } from "@/modules/logistics/map";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";

function toPlanDispatch(d: PlanCandidate): PlanDispatch {
  const lat = typeof d.ship_to?.lat === "number" ? d.ship_to.lat : null;
  const lng = typeof d.ship_to?.lng === "number" ? d.ship_to.lng : null;
  const qty = d.items.reduce((a, i) => a + (Number.isFinite(i.qty) ? i.qty : 0), 0);
  return {
    id: d.id,
    customerId: d.sale?.customer_id ?? null,
    addressKey: d.address_id ?? (d.ship_address ?? "").trim().toLowerCase(),
    lat: lat !== null && lng !== null ? lat : null,
    lng: lat !== null && lng !== null ? lng : null,
    locality: d.ship_to?.locality ?? null,
    packages: Math.max(1, Math.ceil(qty)),
    label: d.ship_to?.contact_name ?? d.customer_name ?? `Entrega ${d.number}`,
    address: d.ship_address ?? "",
  };
}

/** Las paradas sin ubicación (ORS no las puede ubicar): al final de la hoja con su localidad o de la más liviana. */
function addNoGeo(plan: PlanResult, noGeo: PlanStop[], stops: PlanStop[]): PlanResult {
  const byKey = new Map(stops.map((s) => [s.key, s]));
  let routes = [...plan.routes];
  for (const s of noGeo) {
    const loc = (s.locality ?? "").trim().toLowerCase();
    let target = loc ? routes.find((r) => r.stopIds.some((k) => (byKey.get(k)?.locality ?? "").trim().toLowerCase() === loc)) : undefined;
    target ??= [...routes].sort((a, b) => a.packages - b.packages)[0];
    if (!target) continue;
    const t = target;
    routes = routes.map((r) => (r === t ? { ...r, stopIds: [...r.stopIds, s.key], packages: r.packages + s.packages } : r));
  }
  return { ...plan, routes };
}

export function PlanPage() {
  const enabled = useFeature("reparto_propio");
  const canManage = useCan("logistics.route.manage");
  const { toast } = useToast();
  const router = useRouter();
  const { filterStoreId, posStoreId, branchName } = useBranchContext();
  const storeId = filterStoreId ?? posStoreId;
  const [date, setDate] = useState(arToday());
  const on = enabled === true && canManage;
  // Sin datos todavía: arrays estables (los efectos de abajo dependen de ellos).
  const candidatesQ = usePlanCandidates(storeId, on);
  const vehiclesQ = useVehicles(on);
  const originsQ = useOrigins(on);
  const { data: drivers = [] } = useDrivers(on);
  const isLoading = candidatesQ.isLoading;
  const candidates = useMemo(() => candidatesQ.data ?? [], [candidatesQ.data]);
  const vehicles = useMemo(() => vehiclesQ.data ?? [], [vehiclesQ.data]);
  const origins = useMemo(() => originsQ.data ?? [], [originsQ.data]);
  const { data: cfg = DEFAULT_TRACKING } = useTrackingSettings(on);
  const { data: ors = false } = useRoutingAvailable(on);
  const m = useMapMutations();

  const storeOrigins = useMemo(() => origins.filter((o) => o.store_id === storeId), [origins, storeId]);
  const [originId, setOriginId] = useState<string | null>(null);
  useEffect(() => {
    setOriginId(storeOrigins.find((o) => o.is_default)?.id ?? storeOrigins[0]?.id ?? null);
  }, [storeOrigins]);
  const originRow = storeOrigins.find((o) => o.id === originId) ?? null;
  const origin: LatLng | null = originRow?.lat != null && originRow.lng != null ? { lat: originRow.lat, lng: originRow.lng } : null;

  const active = useMemo(() => vehicles.filter((v) => v.status === "activo"), [vehicles]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [driverOf, setDriverOf] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setChosen((c) => {
      const next = c.length ? c.filter((id) => active.some((v) => v.id === id)) : active.slice(0, 3).map((v) => v.id);
      return next.length === c.length && next.every((x, i) => x === c[i]) ? c : next;
    });
    setDriverOf((d) => {
      const missing = active.filter((v) => !(v.id in d));
      if (!missing.length) return d;
      const next = { ...d };
      for (const v of missing) next[v.id] = v.default_driver_user_id;
      return next;
    });
  }, [active]);
  const deliverers = drivers.filter((d) => d.is_driver_role || d.profile || d.base_role === "manager" || d.base_role === "owner");

  const stops = useMemo(() => groupStops(candidates.map(toPlanDispatch)), [candidates]);
  const noGeo = stops.filter((s) => s.lat === null);
  const planVehicles: PlanVehicle[] = useMemo(
    () =>
      chosen
        .map((id) => active.find((v) => v.id === id))
        .filter((v): v is NonNullable<typeof v> => Boolean(v))
        .map((v) => ({ id: v.id, name: v.name, kind: v.kind, capacityPackages: v.capacity_packages, maxStops: v.max_stops })),
    [chosen, active],
  );
  const opts: PlanOptions = { avgSpeedKmh: cfg.avg_speed_kmh, serviceMinutes: cfg.service_minutes, returnToOrigin: DEFAULT_PLAN_OPTIONS.returnToOrigin };

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [mode, setMode] = useState<"heuristica" | "ors">("heuristica");
  const [running, setRunning] = useState(false);
  const [selectedStop, setSelectedStop] = useState<string | null>(null);
  // Cambió la sucursal, los camiones o las entregas: el plan viejo ya no vale.
  const planKey = `${storeId}|${chosen.join(",")}|${candidates.length}`;
  useEffect(() => setPlan(null), [planKey]);

  const colorOf = (vehicleId: string) => truckColor(Math.max(0, chosen.indexOf(vehicleId)));
  const vehicleOf = (id: string) => active.find((v) => v.id === id);
  const byKey = useMemo(() => new Map(stops.map((s) => [s.key, s])), [stops]);

  async function build() {
    if (!planVehicles.length || !stops.length) return;
    setRunning(true);
    try {
      const geo = stops.filter((s) => s.lat !== null && s.lng !== null);
      if (ors && origin && geo.length) {
        const res = await mapApi.optimize({
          origin,
          stops: geo.map((s) => ({ id: s.key, lat: s.lat!, lng: s.lng!, packages: s.packages })),
          vehicles: planVehicles.map((v) => ({ id: v.id, kind: v.kind ?? null, capacityPackages: v.capacityPackages, maxStops: v.maxStops })),
          serviceS: opts.serviceMinutes * 60,
          returnToOrigin: opts.returnToOrigin,
        });
        if (res.provider === "ors") {
          const routes: PlanRoute[] = res.routes.map((r) => ({
            ...r,
            packages: r.stopIds.reduce((a, k) => a + (byKey.get(k)?.packages ?? 0), 0),
            path: r.path.length >= 2 ? r.path : withOrder(r.vehicleId, origin, r.stopIds.map((k) => byKey.get(k)!), opts).path,
          }));
          const ordered = planVehicles.map((v) => routes.find((r) => r.vehicleId === v.id)).filter((r): r is PlanRoute => Boolean(r));
          setPlan(addNoGeo({ routes: ordered, unassigned: res.unassigned.map((key) => ({ key, reason: "capacidad" })), ms: 0 }, noGeo, stops));
          setMode("ors");
          return;
        }
      }
      setPlan(planRoutes(origin, stops, planVehicles, opts));
      setMode("heuristica");
    } finally {
      setRunning(false);
    }
  }

  function edit(next: PlanResult) {
    setPlan(next);
    setMode("heuristica");
  }

  async function confirm() {
    if (!plan || !storeId) return;
    try {
      const res = await m.confirmPlan.mutateAsync({
        store_id: storeId,
        origin_id: originId,
        service_date: date,
        mode,
        params: { avg_speed_kmh: opts.avgSpeedKmh, service_minutes: opts.serviceMinutes, vehicles: chosen.length, stops: stops.length },
        routes: planToConfirm(plan, stops, driverOf),
      });
      toast({
        title: res.routes.length === 1 ? "Se creó 1 hoja de ruta" : `Se crearon ${res.routes.length} hojas de ruta`,
        description: res.routes.map((r) => `N° ${r.number}`).join(", "),
        variant: "success",
      });
      router.push(`/logistica/reparto?dia=${date}` as NextRoute);
    } catch (e) {
      toast({ title: "No se pudo confirmar el reparto", description: logisticsErrorMessage(e), variant: "error" });
    }
  }

  const problems = plan ? planProblems(plan, planVehicles, driverOf) : [];
  const assigned = plan ? plan.routes.reduce((a, r) => a + r.stopIds.length, 0) : 0;

  const mapRoutes: MapRoute[] = (plan?.routes ?? []).map((r) => ({ id: r.vehicleId, color: colorOf(r.vehicleId), planned: r.path, plannedInColor: true }));
  const mapStops: MapStop[] = plan
    ? plan.routes.flatMap((r) =>
        r.stopIds.map((k, i) => {
          const s = byKey.get(k)!;
          return { id: k, seq: i + 1, lat: s.lat, lng: s.lng, status: "pendiente" as const, color: colorOf(r.vehicleId), title: s.label };
        }),
      )
    : stops.map((s, i) => ({ id: s.key, seq: i + 1, lat: s.lat, lng: s.lng, status: "pendiente" as const, color: "#64748b", title: s.label }));

  const header = (
    <PageHeader
      eyebrow="Logística"
      title="Planificar reparto"
      icon={RouteIcon}
      description="Repartí las entregas del día entre tus camiones por zona y capacidad, en segundos."
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <LogisticsLocked title="El reparto propio no está incluido en tu plan" description="Armá las hojas de todos tus camiones de una vez, por zona y capacidad." />
      </PageContainer>
    );
  }
  if (!canManage) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <EmptyState className="mt-8" icon={RouteIcon} title="No tenés permiso para armar hojas de ruta" description="Pedile al dueño el permiso Armar hojas de ruta (Logística)." />
      </PageContainer>
    );
  }

  return (
    <PageContainer size="2xl">
      {header}
      <LogisticsNav className="mt-4" />

      <section aria-label="Qué se reparte" className="mt-6 grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Día</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Sale de</span>
          <select className={selectCls} value={originId ?? ""} onChange={(e) => setOriginId(e.target.value || null)}>
            {storeOrigins.length === 0 && <option value="">{branchName(storeId) ?? "La sucursal"} (sin origen cargado)</option>}
            {storeOrigins.map((o) => (
              <option key={o.id} value={o.id} className="bg-popover text-popover-foreground">
                {o.name}
                {o.lat == null ? " (sin ubicación)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1 text-sm">
          <span className="font-medium">Entregas listas</span>
          <p className="flex h-11 items-center gap-2">
            {isLoading ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <>
                <span className="text-lg font-semibold tabular-nums">{candidates.length}</span>
                <span className="text-muted-foreground">en {stops.length === 1 ? "1 parada" : `${stops.length} paradas`}</span>
              </>
            )}
          </p>
        </div>
      </section>
      {!origin && (
        <p className="mt-2 text-sm text-warning">
          El origen no tiene ubicación: el orden arranca por la primera parada.{" "}
          <Link href={"/configuracion?seccion=logistica" as NextRoute} className="font-semibold underline-offset-2 hover:underline">
            Cargalo en Configuración
          </Link>
          .
        </p>
      )}
      {noGeo.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-warning">
          <MapPinOff size={15} aria-hidden />
          {noGeo.length === 1 ? "1 parada no tiene ubicación" : `${noGeo.length} paradas no tienen ubicación`}: van al final, agrupadas por localidad. Revisá la dirección en el cliente.
        </p>
      )}

      <section aria-label="Camiones" className="mt-6">
        <h2 className="text-sm font-semibold">Camiones que salen</h2>
        {active.length === 0 ? (
          <EmptyState
            compact
            icon={Truck}
            title="No hay vehículos activos"
            description="Cargalos en Flota con su capacidad en bultos."
            action={
              <Link href={"/logistica/flota" as NextRoute} className={buttonVariants({ size: "sm" })}>
                Ir a Flota
              </Link>
            }
          />
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((v) => {
              const on = chosen.includes(v.id);
              return (
                <div key={v.id} className={cn("rounded-lg p-3 ring-1", on ? "bg-card ring-ninja-flameSoft" : "bg-muted/30 ring-border")}>
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setChosen((c) => (on ? c.filter((x) => x !== v.id) : [...c, v.id]))}
                      className="h-5 w-5"
                    />
                    {on && <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: colorOf(v.id) }} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{v.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[v.plate, v.capacity_packages ? `${v.capacity_packages} bultos` : "Sin tope de bultos", v.max_stops ? `hasta ${v.max_stops} paradas` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                  {on && (
                    <label className="mt-2 block text-xs">
                      <span className="sr-only">Repartidor de {v.name}</span>
                      <select
                        className={selectCls}
                        value={driverOf[v.id] ?? ""}
                        onChange={(e) => setDriverOf((d) => ({ ...d, [v.id]: e.target.value || null }))}
                      >
                        <option value="">Sin repartidor (queda en borrador)</option>
                        {deliverers.map((d) => (
                          <option key={d.user_id} value={d.user_id} className="bg-popover text-popover-foreground">
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => void build()} loading={running} disabled={!planVehicles.length || !stops.length}>
            <Wand2 size={16} /> {plan ? "Volver a armar" : "Armar el reparto"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {ors ? "Por calles con OpenRouteService; si no responde, con la heurística." : "Por zona y cercanía, sin internet (heurística local)."}
          </span>
        </div>
      </section>

      {stops.length === 0 && !isLoading && (
        <EmptyState
          className="mt-6"
          icon={CheckCircle2}
          title="No hay entregas para repartir"
          description="Aparecen acá las entregas por envío propio de la sucursal que todavía no están en una hoja."
        />
      )}

      {stops.length > 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <RouteMap
            routes={mapRoutes}
            stops={mapStops}
            origin={origin ? [origin.lat, origin.lng] : null}
            selectedStopId={selectedStop}
            onStopClick={setSelectedStop}
            fitKey={plan ? `plan:${plan.routes.length}:${assigned}` : `stops:${stops.length}`}
            height="min(60dvh, 600px)"
            label="Mapa del reparto planificado"
          />

          <div className="space-y-3">
            {!plan ? (
              <p className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground">
                Elegí los camiones y tocá <span className="font-semibold text-foreground">Armar el reparto</span>. Lo podés ajustar antes de confirmar.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={mode === "ors" ? "info" : "neutral"}>{mode === "ors" ? "Por calles (ORS)" : "Heurística local"}</Badge>
                  <span className="text-muted-foreground">
                    {assigned} de {stops.length} paradas en {plan.routes.length === 1 ? "1 camión" : `${plan.routes.length} camiones`}
                    {plan.ms ? ` · ${plan.ms} ms` : ""}
                  </span>
                </div>
                {plan.routes.map((r) => {
                  const v = vehicleOf(r.vehicleId);
                  const use = capacityUse(r.packages, v?.capacity_packages);
                  return (
                    <section key={r.vehicleId} aria-label={v?.name ?? "Camión"} className="rounded-lg bg-card p-3 ring-1 ring-border">
                      <header className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorOf(r.vehicleId) }} />
                          <span className="truncate font-semibold">{v?.name ?? "Camión"}</span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatDistance(r.distanceM)} · {formatDuration(r.durationS)}
                        </span>
                      </header>
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn("h-full rounded-full", use !== null && use > 100 ? "bg-danger" : use !== null && use > 85 ? "bg-warning" : "bg-success")}
                            style={{ width: `${Math.min(100, use ?? 0)}%` }}
                          />
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                          {r.packages}
                          {v?.capacity_packages ? `/${v.capacity_packages}` : ""} bultos · {r.stopIds.length}
                          {v?.max_stops ? `/${v.max_stops}` : ""} paradas
                        </span>
                      </div>
                      <ol className="mt-2 divide-y divide-border">
                        {r.stopIds.map((k, i) => {
                          const s = byKey.get(k)!;
                          return (
                            <li key={k} className={cn("flex items-center gap-2 py-2", selectedStop === k && "bg-muted/40")}>
                              <button type="button" onClick={() => setSelectedStop(k)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-xs font-bold tabular-nums">{i + 1}</span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">{s.label}</span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {s.address || s.locality || "Sin dirección"}
                                    {r.offsets[k] !== undefined ? ` · llega en ${formatDuration(r.offsets[k])}` : ""}
                                    {s.dispatchIds.length > 1 ? ` · ${s.dispatchIds.length} entregas` : ""}
                                  </span>
                                </span>
                              </button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-9 w-9"
                                aria-label="Subir"
                                disabled={i === 0}
                                onClick={() => edit(shiftStop(plan, r.vehicleId, k, -1, stops, origin, opts))}
                              >
                                <ArrowUp size={15} />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-9 w-9"
                                aria-label="Bajar"
                                disabled={i === r.stopIds.length - 1}
                                onClick={() => edit(shiftStop(plan, r.vehicleId, k, 1, stops, origin, opts))}
                              >
                                <ArrowDown size={15} />
                              </Button>
                              <label>
                                <span className="sr-only">Pasar la parada {i + 1} a otro camión</span>
                                <select
                                  value={r.vehicleId}
                                  onChange={(e) => edit(moveStop(plan, k, e.target.value === "-" ? null : e.target.value, stops, origin, opts))}
                                  className="h-9 max-w-[7.5rem] rounded-lg border border-input bg-background px-2 text-xs"
                                >
                                  {planVehicles.map((pv) => (
                                    <option key={pv.id} value={pv.id} className="bg-popover text-popover-foreground">
                                      {pv.id === r.vehicleId ? pv.name : `Pasar a ${pv.name}`}
                                    </option>
                                  ))}
                                  <option value="-" className="bg-popover text-popover-foreground">
                                    Sacar del reparto
                                  </option>
                                </select>
                              </label>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  );
                })}
                {plan.unassigned.length > 0 && (
                  <section aria-label="Sin camión" className="rounded-lg bg-warning/10 p-3">
                    <h3 className="text-sm font-semibold text-warning">
                      {plan.unassigned.length === 1 ? "1 parada sin camión" : `${plan.unassigned.length} paradas sin camión`}
                    </h3>
                    <ul className="mt-2 space-y-1">
                      {plan.unassigned.map((u) => {
                        const s = byKey.get(u.key);
                        if (!s) return null;
                        return (
                          <li key={u.key} className="flex items-center justify-between gap-2 text-sm">
                            <span className="min-w-0 truncate">
                              {s.label} <span className="text-muted-foreground">· {u.reason === "capacidad" ? "no entra" : "la sacaste"}</span>
                            </span>
                            <select
                              value=""
                              onChange={(e) => e.target.value && edit(moveStop(plan, u.key, e.target.value, stops, origin, opts))}
                              className="h-9 max-w-[8rem] rounded-lg border border-input bg-background px-2 text-xs"
                              aria-label={`Sumar ${s.label} a un camión`}
                            >
                              <option value="">Sumar a…</option>
                              {planVehicles.map((pv) => (
                                <option key={pv.id} value={pv.id} className="bg-popover text-popover-foreground">
                                  {pv.name}
                                </option>
                              ))}
                            </select>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                {problems.length > 0 && (
                  <ul className="space-y-1 text-sm text-warning">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                <Button className="w-full" onClick={() => void confirm()} loading={m.confirmPlan.isPending} disabled={!plan.routes.length}>
                  <Sparkles size={16} /> Confirmar y crear {plan.routes.length === 1 ? "la hoja" : `las ${plan.routes.length} hojas`}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
PlanPage.displayName = "PlanPage";
