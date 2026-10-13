"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  CircleAlert,
  Clock,
  Hourglass,
  Info,
  MonitorDot,
  PackageX,
  Receipt,
  Settings2,
  Smartphone,
  Users,
} from "lucide-react";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { EYEBROW, FLAT_PANEL } from "@/components/security/styles";
import { useBranchOverview } from "@/modules/cash/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import {
  branchAlerts,
  DEFAULT_THRESHOLDS,
  isWithinOpeningHours,
  worstSeverity,
  type AlertSeverity,
  type BranchOverview,
  type MonitorThresholds,
} from "@/lib/branches/monitorAlerts";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { deviceSummary, registerSignal, SIGNAL_LABEL } from "@/lib/branches/heartbeat";
import { cn } from "@/lib/utils/cn";

// =============================================================================
// Vista general de sucursales (F17 · H99 primer corte · ADR-057). Una tarjeta
// por sucursal: cajas, ventas de hoy, personal, faltantes, cobros en espera,
// terminales y último Z, con alertas calculadas en lib/branches/monitorAlerts.
// Dueño y encargado (la RPC lo exige). Umbrales recordados en este equipo.
// =============================================================================

const PREFS_KEY = "ninja.monitor.thresholds.v1";

function loadThresholds(): MonitorThresholds {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_THRESHOLDS;
    const v = JSON.parse(raw) as Partial<MonitorThresholds>;
    return {
      longShiftHours: Number(v.longShiftHours) > 0 ? Number(v.longShiftHours) : DEFAULT_THRESHOLDS.longShiftHours,
      terminalStaleMinutes:
        Number(v.terminalStaleMinutes) > 0 ? Number(v.terminalStaleMinutes) : DEFAULT_THRESHOLDS.terminalStaleMinutes,
      noSaleMinutes: Number(v.noSaleMinutes) >= 0 ? Number(v.noSaleMinutes) : DEFAULT_THRESHOLDS.noSaleMinutes,
      registerStaleMinutes:
        Number(v.registerStaleMinutes) > 0 ? Number(v.registerStaleMinutes) : DEFAULT_THRESHOLDS.registerStaleMinutes,
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

const EDGE: Record<AlertSeverity, string> = {
  // Franja de color arriba (nunca al costado) y esquinas de arriba rectas.
  danger: "rounded-t-none border-t-2 border-t-danger",
  warning: "rounded-t-none border-t-2 border-t-warning",
  info: "",
};
const ALERT_TONE: Record<AlertSeverity, string> = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-muted-foreground",
};
const ALERT_ICON: Record<AlertSeverity, React.ElementType> = {
  danger: CircleAlert,
  warning: AlertTriangle,
  info: Info,
};

// `compact` = Panel del dueño: sólo las sucursales con alertas. `storeId`
// pisa el filtro del chip (undefined = el del chip; null = todas).
export function BranchOverviewGrid({ compact = false, storeId }: { compact?: boolean; storeId?: string | null }) {
  const ctx = useBranchContext();
  const filter = storeId !== undefined ? storeId : ctx.filterStoreId;
  const { data, isLoading } = useBranchOverview();
  const [thresholds, setThresholds] = useState<MonitorThresholds>(DEFAULT_THRESHOLDS);
  useEffect(() => setThresholds(loadThresholds()), []);
  const [editing, setEditing] = useState(false);
  // Se recalcula con cada refresco (30 s): suficiente para las alertas.
  const now = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(
    () => (data ?? []).filter((r) => !filter || r.store_id === filter),
    [data, filter],
  );
  const withAlerts = useMemo(
    () => rows.map((r) => ({ row: r, alerts: branchAlerts(r, now, thresholds) })),
    [rows, now, thresholds],
  );

  if (isLoading || rows.length === 0) return null;
  const visible = compact ? withAlerts.filter((x) => x.alerts.length > 0) : withAlerts;
  if (compact && visible.length === 0) return null;

  const save = (t: MonitorThresholds) => {
    setThresholds(t);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(t));
    } catch {
      // Sin storage: quedan en memoria.
    }
  };

  return (
    <section aria-label="Sucursales" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={EYEBROW}>Sucursales</h2>
        {!compact && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Settings2 size={13} aria-hidden /> Umbrales de alerta
          </button>
        )}
      </div>

      {editing && !compact && <ThresholdsEditor value={thresholds} onChange={save} />}

      <div className={cn("grid gap-3", compact ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3")}>
        {visible.map(({ row, alerts }) => (
          <BranchCard key={row.store_id} row={row} alerts={alerts} now={now} thresholds={thresholds} compact={compact} />
        ))}
      </div>
    </section>
  );
}
BranchOverviewGrid.displayName = "BranchOverviewGrid";

function ThresholdsEditor({ value, onChange }: { value: MonitorThresholds; onChange: (t: MonitorThresholds) => void }) {
  const field = (key: keyof MonitorThresholds, label: string, unit: string, hint: string) => (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          min={key === "noSaleMinutes" ? 0 : 1}
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: Math.max(0, Number(e.target.value) || 0) })}
          className="h-9 w-24 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums outline-none focus:border-ninja-flameSoft"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
  return (
    <div className={cn(FLAT_PANEL, "grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4")}>
      {field("longShiftHours", "Caja abierta hace más de", "horas", "Avisa turnos que quedaron abiertos.")}
      {field("terminalStaleMinutes", "Terminal sin señal hace más de", "minutos", "Sólo en el horario de la sucursal.")}
      {field("noSaleMinutes", "Sin ventas hace más de", "minutos", "En horario y con caja abierta. 0 = no avisar.")}
      {field("registerStaleMinutes", "Caja sin señal hace más de", "minutos", "Cajas con turno abierto que dejaron de reportar.")}
    </div>
  );
}

function BranchCard({
  row,
  alerts,
  now,
  thresholds,
  compact,
}: {
  row: BranchOverview;
  alerts: ReturnType<typeof branchAlerts>;
  now: Date;
  thresholds: MonitorThresholds;
  compact: boolean;
}) {
  const sev = worstSeverity(alerts);
  const inHours = isWithinOpeningHours(row.opening_hours, now);
  const staleCutoff = now.getTime() - thresholds.terminalStaleMinutes * 60_000;
  return (
    <article className={cn(FLAT_PANEL, "flex flex-col gap-3 p-4", sev && EDGE[sev])}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BranchDot branch={row} className="h-3 w-3" />
          <h3 className="truncate font-display text-base font-semibold">{row.name}</h3>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {inHours === null ? "Sin horario" : inHours ? "En horario" : "Fuera de horario"}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <Stat icon={MonitorDot} label="Cajas abiertas" value={`${row.registers_open} de ${row.registers_total}`} />
        <Stat
          icon={Receipt}
          label="Ventas de hoy"
          value={formatCurrency(row.sales_today_total)}
          sub={`${row.sales_today_count} ${row.sales_today_count === 1 ? "venta" : "ventas"}${
            row.last_sale_at ? ` · última ${formatRelative(row.last_sale_at)}` : ""
          }`}
        />
        <Stat icon={Users} label="Personal" value={`${row.staff_on_shift} en turno`} sub={`${row.staff_assigned} asignados hoy`} />
        <Stat
          icon={Hourglass}
          label="Cobros en espera"
          value={String(row.pending_waiting)}
          sub={row.pending_waiting > 0 ? formatCurrency(row.pending_waiting_amount) : undefined}
          href={row.pending_waiting + row.pending_paid_unsold > 0 ? "/cobros-en-espera" : undefined}
        />
        {!compact && (
          <Stat
            icon={PackageX}
            label="Faltantes"
            value={String(row.low_stock_count)}
            href={row.low_stock_count > 0 ? "/productos" : undefined}
          />
        )}
        {!compact && (
          <Stat
            icon={Clock}
            label="Último Z"
            value={row.last_z ? formatCurrency(row.last_z.difference) : "Sin cierres"}
            sub={
              row.last_z
                ? `N° ${row.last_z.store_z_number ?? row.last_z.z_number} · ${formatRelative(row.last_z.closed_at)}`
                : undefined
            }
          />
        )}
      </dl>

      {!compact && row.open_shifts.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {row.open_shifts.map((s) => (
            <li key={s.shift_id} className="flex justify-between gap-2">
              <span className="truncate">
                <span className="text-foreground">{s.register_name}</span> · {s.opened_by_name}
              </span>
              <span className="shrink-0">desde {new Date(s.opened_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</span>
            </li>
          ))}
        </ul>
      )}

      {!compact && (row.registers ?? []).length > 0 && (
        <ul aria-label="Señal de las cajas" className="space-y-1 border-t border-border pt-2 text-xs">
          {(row.registers ?? []).map((r) => {
            const signal = registerSignal(r.last_ping_at, now, thresholds.registerStaleMinutes);
            const device = [
              r.last_sale_at ? `última venta ${formatRelative(r.last_sale_at)}` : null,
              deviceSummary(r.info, r.app_version) || null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={r.id} className="flex items-start justify-between gap-2">
                <span className="flex min-w-0 items-start gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1 h-2 w-2 shrink-0 rounded-full",
                      signal === "online" ? "bg-success" : signal === "stale" && r.shift_open ? "bg-warning" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">
                      {r.name}
                      {r.user_name ? <span className="text-muted-foreground"> · {r.user_name}</span> : null}
                    </span>
                    {device && <span className="block truncate text-muted-foreground">{device}</span>}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0",
                    signal === "stale" && r.shift_open ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {r.last_ping_at ? formatRelative(r.last_ping_at) : SIGNAL_LABEL.never}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!compact && row.terminals.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-2 text-xs">
          {row.terminals.map((t) => {
            const stale = !t.last_seen_at || new Date(t.last_seen_at).getTime() < staleCutoff;
            return (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <Smartphone size={12} aria-hidden className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{t.label}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className={cn(stale && inHours ? "text-warning" : "text-muted-foreground")}>
                    {t.last_seen_at ? formatRelative(t.last_seen_at) : "sin señal"}
                  </span>
                  {t.last_charge && (
                    <span className={t.last_charge.status === "rejected" ? "text-danger" : "text-muted-foreground"}>
                      {t.last_charge.status === "rejected" ? "Rechazado" : "Aprobado"}{" "}
                      {formatRelative(t.last_charge.at)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {alerts.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-2 text-xs">
          {alerts.map((a) => {
            const Icon = ALERT_ICON[a.severity];
            return (
              <li key={a.kind} className={cn("flex items-start gap-1.5", ALERT_TONE[a.severity])}>
                <Icon size={13} aria-hidden className="mt-px shrink-0" />
                <span>{a.message}</span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  href,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const body = (
    <>
      <dt className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon size={12} aria-hidden /> {label}
      </dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="truncate text-[11px] text-muted-foreground">{sub}</dd>}
    </>
  );
  return href ? (
    <Link href={href as Route} className="-m-1 min-w-0 rounded-md p-1 hover:bg-muted">
      {body}
    </Link>
  ) : (
    <div className="min-w-0">{body}</div>
  );
}
