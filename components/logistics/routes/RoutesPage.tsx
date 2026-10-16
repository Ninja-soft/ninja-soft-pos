"use client";

// Logística › Reparto (ADR-161, R7, R10, R19): las hojas de ruta del día por
// sucursal (varios camiones a la vez), cada una con su avance, y el detalle
// de la elegida. En el teléfono la lista va arriba y el detalle abajo.

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route as NextRoute } from "next";
import { ChevronLeft, ChevronRight, Plus, Route as RouteIcon, Truck, Wand2 } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { LogisticsLocked } from "@/components/logistics/LogisticsLocked";
import { RouteDetailPanel } from "@/components/logistics/routes/RouteDetailPanel";
import { RouteFormModal } from "@/components/logistics/routes/RouteFormModal";
import { cn } from "@/lib/utils/cn";
import { ROUTE_STATUS_LABEL, ROUTE_STATUS_TONE, arToday, stopIsFinal } from "@/lib/logistics/logic";
import { useCan, useDrivers, useRoutes } from "@/modules/logistics/api";
import { useBranchContext } from "@/modules/branches/hooks";
import { useFeature } from "@/modules/saas/gating";

function shiftDate(d: string, days: number): string {
  const t = Date.parse(`${d}T12:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function dayLabel(d: string, today: string): string {
  if (d === today) return "Hoy";
  if (d === shiftDate(today, 1)) return "Mañana";
  if (d === shiftDate(today, -1)) return "Ayer";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export function RoutesPage() {
  const enabled = useFeature("reparto_propio");
  const canManage = useCan("logistics.route.manage");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = arToday();
  const [date, setDate] = useState(params.get("dia") ?? today);
  const [creating, setCreating] = useState(false);
  const { filterStoreId, posStoreId, branchName } = useBranchContext();
  const { data: routes = [], isLoading } = useRoutes({ from: date, to: date, storeId: filterStoreId }, enabled === true);
  const { data: drivers = [] } = useDrivers(enabled === true);
  const selected = params.get("hoja");
  const driverName = useMemo(() => new Map(drivers.map((d) => [d.user_id, d.name])), [drivers]);

  function open(id: string | null) {
    const q = new URLSearchParams(params.toString());
    if (id) q.set("hoja", id);
    else q.delete("hoja");
    router.replace(`${pathname}?${q.toString()}` as NextRoute, { scroll: false });
  }

  const header = (
    <PageHeader
      eyebrow="Logística"
      title="Reparto"
      icon={RouteIcon}
      description="Hojas de ruta por camión: qué lleva, en qué orden y cómo le fue a cada entrega."
      actions={
        enabled && canManage ? (
          <>
            {/* ADR-164 (L3): varias hojas de una vez, por zona y capacidad. */}
            <Link href={"/logistica/planificar" as NextRoute} className={buttonVariants({ variant: "secondary" })}>
              <Wand2 size={16} /> Planificar reparto
            </Link>
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} /> Nueva hoja de ruta
            </Button>
          </>
        ) : undefined
      }
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <LogisticsNav className="mt-4" />
        <LogisticsLocked
          title="El reparto propio no está incluido en tu plan"
          description="Armá hojas de ruta con tus camiones, ordenalas por cercanía, imprimilas y seguí cada entrega con firma, foto y ubicación."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer size="2xl">
      {header}
      <LogisticsNav className="mt-4" />

      <div className="mt-6 flex items-center gap-2">
        <Button size="icon" variant="secondary" aria-label="Día anterior" onClick={() => setDate((d) => shiftDate(d, -1))}>
          <ChevronLeft size={18} />
        </Button>
        <label className="relative">
          <span className="sr-only">Día</span>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-11 rounded-lg border border-input bg-background px-3 text-sm"
          />
        </label>
        <Button size="icon" variant="secondary" aria-label="Día siguiente" onClick={() => setDate((d) => shiftDate(d, 1))}>
          <ChevronRight size={18} />
        </Button>
        <span className="ml-1 text-sm font-semibold">{dayLabel(date, today)}</span>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-2">
          {isLoading ? (
            [0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)
          ) : routes.length === 0 ? (
            <EmptyState
              compact
              icon={Truck}
              title="No hay hojas para este día"
              description="Creá una hoja por camión y sumale los envíos que salen."
              action={canManage ? <Button size="sm" onClick={() => setCreating(true)}>Nueva hoja de ruta</Button> : undefined}
            />
          ) : (
            routes.map((r) => {
              const done = r.stops.filter((s) => stopIsFinal(s.status)).length;
              const pct = r.stops.length ? Math.round((done / r.stops.length) * 100) : 0;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => open(r.id)}
                  className={cn(
                    "w-full rounded-lg bg-card p-4 text-left ring-1 transition",
                    selected === r.id ? "ring-ninja-flameSoft" : "ring-border hover:ring-foreground/20",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">Hoja N° {r.number}</span>
                    <Badge tone={ROUTE_STATUS_TONE[r.status]}>{ROUTE_STATUS_LABEL[r.status]}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {[r.vehicle ? `${r.vehicle.name}${r.vehicle.plate ? ` (${r.vehicle.plate})` : ""}` : "Sin vehículo", r.driver_user_id ? driverName.get(r.driver_user_id) : "Sin repartidor"]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {done}/{r.stops.length}
                    </span>
                  </div>
                  {!filterStoreId && branchName(r.store_id) && <p className="mt-2 text-xs text-muted-foreground">{branchName(r.store_id)}</p>}
                </button>
              );
            })
          )}
        </div>
        <div>
          {selected ? (
            <RouteDetailPanel key={selected} routeId={selected} onClosed={() => open(null)} />
          ) : (
            <div className="hidden rounded-lg bg-muted/30 p-10 text-center text-sm text-muted-foreground lg:block">Elegí una hoja para ver sus paradas.</div>
          )}
        </div>
      </div>

      <RouteFormModal
        open={creating}
        route={null}
        defaultStoreId={filterStoreId ?? posStoreId}
        defaultDate={date}
        onClose={() => setCreating(false)}
        onSaved={(id) => open(id)}
      />
    </PageContainer>
  );
}
RoutesPage.displayName = "RoutesPage";
