"use client";

import { useState } from "react";
import Link from "next/link";
import type { EChartsCoreOption } from "echarts/core";
import { Activity, MonitorDot, Receipt, TrendingDown, TrendingUp, Users } from "lucide-react";
import { EChart, type ChartContext } from "@/components/charts/EChart";
import { timeSeriesOption } from "@/components/charts/builders";
import { formatAxisValue, formatChartValue } from "@/components/charts/chartTheme";
import { Segmented } from "@/components/ui/Segmented";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Callout } from "@/components/ui/Callout";
import { buttonVariants } from "@/components/ui/Button";
import { CashMonitor } from "@/components/cash/CashMonitor";
import { BranchOverviewGrid } from "@/components/cash/BranchOverviewGrid";
import { EYEBROW, FLAT_PANEL, KPI } from "@/components/security/styles";
import { useBranchContext } from "@/modules/branches/hooks";
import { hourWindow, summarizeOwnerStats, useOwnerStats, type OwnerStats } from "@/modules/dashboard/ownerStats";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

// Hoy en el negocio (F17 · H118): ventas de hoy contra ayer (total, por hora y
// por sucursal), cajas abiertas con quién y desde cuándo, y el estado del
// personal. Con varias sucursales se mira "Todas" o una en particular.
export function OwnerLive() {
  const ctx = useBranchContext();
  const [storeId, setStoreId] = useState<string>("all");
  const selected = storeId === "all" ? null : storeId;
  const { data, isLoading, error } = useOwnerStats(selected);
  const sum = summarizeOwnerStats(data);

  return (
    <section aria-label="Hoy" className="mt-10">
      <SectionHeader
        title="Hoy en el negocio"
        icon={Activity}
        description="Se actualiza solo cada minuto. La comparación es contra todo el día de ayer."
        actions={
          ctx.isMulti && ctx.allowed.length > 1 ? (
            <Segmented
              size="sm"
              value={storeId}
              onChange={setStoreId}
              aria-label="Sucursal"
              options={[
                { value: "all", label: "Todas" },
                ...ctx.allowed.map((b) => ({ value: b.id, label: b.short_name || b.name })),
              ]}
            />
          ) : undefined
        }
      />

      {error ? (
        <Callout tone="neutral" className="mt-4">
          Los datos del día van a aparecer cuando se actualice la base del negocio.
        </Callout>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              icon={Activity}
              label="Vendido hoy"
              value={isLoading ? null : formatCurrency(sum.today)}
              delta={sum.delta}
              hint={`Ayer ${formatCurrency(sum.yesterday)}`}
            />
            <KpiCard
              icon={Receipt}
              label="Tickets"
              value={isLoading ? null : String(sum.tickets)}
              hint={sum.tickets ? `Promedio ${formatCurrency(sum.avgTicket)}` : "Sin ventas todavía"}
            />
            <KpiCard
              icon={MonitorDot}
              label="Cajas abiertas"
              value={isLoading ? null : String(data?.open_shifts ?? 0)}
              href="/caja/monitor"
              hint="Ver quién y desde cuándo"
            />
            <StaffKpi staff={data?.staff} loading={isLoading} />
          </div>

          <div className={cn("mt-3 grid gap-3", ctx.isMulti && !selected ? "lg:grid-cols-2" : "")}>
            <div className={cn(FLAT_PANEL, "p-4")}>
              <p className={EYEBROW}>Ventas por hora</p>
              <EChart
                className="mt-2"
                height={240}
                compactHeight={200}
                ariaLabel="Ventas por hora de hoy contra ayer"
                empty={!isLoading && sum.today === 0 && sum.yesterday === 0}
                emptyTitle="Todavía no hay ventas"
                emptyHint="El gráfico se arma con las ventas de hoy y de ayer."
                option={hourOption(data)}
              />
            </div>
            {ctx.isMulti && !selected && (
              <div className={cn(FLAT_PANEL, "p-4")}>
                <p className={EYEBROW}>Por sucursal</p>
                <EChart
                  className="mt-2"
                  height={240}
                  compactHeight={220}
                  ariaLabel="Ventas de hoy y de ayer por sucursal"
                  empty={!isLoading && (data?.by_store ?? []).length === 0}
                  emptyTitle="Sin sucursales"
                  option={storeOption(data)}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Sucursales con alertas (ADR-057): sólo aparecen si hay algo para mirar. */}
      <div className="mt-6 empty:hidden">
        <BranchOverviewGrid compact storeId={selected} />
      </div>

      <div className="mt-6">
        <p className={cn(EYEBROW, "mb-3")}>Cajas abiertas</p>
        <CashMonitor compact storeId={selected} />
      </div>
    </section>
  );
}
OwnerLive.displayName = "OwnerLive";

function KpiCard({
  icon: Icon,
  label,
  value,
  delta,
  hint,
  href,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null;
  delta?: number | null;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className={cn(EYEBROW, "flex items-center gap-1.5")}>
        <Icon size={13} aria-hidden /> {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        {value === null ? (
          <span className="h-7 w-24 animate-pulse rounded bg-muted" aria-hidden />
        ) : (
          <span className={cn(KPI, "text-xl sm:text-2xl")}>{value}</span>
        )}
        {delta != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums",
              delta >= 0 ? "text-success" : "text-danger",
            )}
          >
            {delta >= 0 ? <TrendingUp size={12} aria-hidden /> : <TrendingDown size={12} aria-hidden />}
            {Math.abs(delta).toLocaleString("es-AR", { maximumFractionDigits: 0 })} %
          </span>
        )}
      </div>
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href as never} className={cn(FLAT_PANEL, "block p-4 transition-colors hover:bg-muted/50")}>
      {body}
    </Link>
  ) : (
    <div className={cn(FLAT_PANEL, "p-4")}>{body}</div>
  );
}

function StaffKpi({ staff, loading }: { staff: OwnerStats["staff"] | undefined; loading: boolean }) {
  const s = staff ?? { active: 0, suspended: 0, on_leave: 0, terminated: 0 };
  const total = s.active + s.suspended + s.on_leave;
  const seg = [
    { k: "Activos", v: s.active, c: "bg-success" },
    { k: "Licencia", v: s.on_leave, c: "bg-info" },
    { k: "Suspendidos", v: s.suspended, c: "bg-danger" },
  ];
  return (
    <Link href={"/dashboard-team#equipo" as never} className={cn(FLAT_PANEL, "block p-4 transition-colors hover:bg-muted/50")}>
      <div className={cn(EYEBROW, "flex items-center gap-1.5")}>
        <Users size={13} aria-hidden /> Personal
      </div>
      {loading ? (
        <span className="mt-2 block h-7 w-16 animate-pulse rounded bg-muted" aria-hidden />
      ) : (
        <>
          <p className={cn(KPI, "mt-2 text-xl sm:text-2xl")}>
            {s.active}
            <span className="ml-1 text-sm font-medium text-muted-foreground">activos</span>
          </p>
          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            {total > 0 && seg.map((x) => <span key={x.k} className={x.c} style={{ width: `${(x.v / total) * 100}%` }} />)}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {s.on_leave} de licencia · {s.suspended} suspendidos
          </p>
        </>
      )}
    </Link>
  );
}

function hourOption(data: OwnerStats | undefined) {
  const rows = hourWindow(data?.by_hour ?? []);
  return timeSeriesOption({
    labels: rows.map((r) => `${String(r.hour).padStart(2, "0")}h`),
    tooltipLabels: rows.map((r) => `${String(r.hour).padStart(2, "0")}:00 a ${String(r.hour).padStart(2, "0")}:59`),
    values: rows.map((r) => r.today),
    name: "Hoy",
    format: "currency",
    kind: "bar",
    previous: { values: rows.map((r) => r.yesterday), labels: rows.map(() => ""), name: "Ayer" },
  });
}

// Barras agrupadas hoy / ayer por sucursal (ayer en el tono de comparación).
function storeOption(data: OwnerStats | undefined) {
  const rows = data?.by_store ?? [];
  return ({ theme: t, compact }: ChartContext): EChartsCoreOption => ({
    grid: { left: 4, right: 12, top: compact ? 8 : 32, bottom: compact ? 30 : 4, containLabel: true },
    legend: {
      show: true,
      top: compact ? undefined : 0,
      bottom: compact ? 0 : undefined,
      right: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: t.muted, fontSize: 11 },
      data: ["Ayer", "Hoy"],
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: t.tooltipBg,
      borderWidth: 0,
      textStyle: { color: t.tooltipFg, fontSize: 12 },
      valueFormatter: (v: unknown) => formatChartValue(Number(v) || 0, "currency"),
    },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.short_name || r.name),
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: t.border } },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => formatAxisValue(v, "currency") },
    },
    series: [
      {
        name: "Ayer",
        type: "bar",
        data: rows.map((r) => r.yesterday_total),
        barMaxWidth: 22,
        itemStyle: { color: t.comparison, borderRadius: [3, 3, 0, 0] },
      },
      {
        name: "Hoy",
        type: "bar",
        data: rows.map((r) => ({ value: r.today_total, itemStyle: { color: r.color || t.palette[0] } })),
        barMaxWidth: 22,
        itemStyle: { color: t.palette[0], borderRadius: [3, 3, 0, 0] },
      },
    ],
  });
}
