// =============================================================================
// Alertas del monitor de sucursales (F17 · H99 primer corte · ADR-057).
//
// branch_monitor_overview() devuelve hechos por sucursal; acá se decide qué es
// una alerta, con umbrales configurables en la pantalla. Puro y testeable.
// El horario de la sucursal (stores.opening_hours: {mon:[{from,to}], ...}) se
// evalúa en la hora de Argentina, no en la del navegador.
// =============================================================================

export type WeekDayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type OpeningHoursMap = Partial<Record<WeekDayKey, { from: string; to: string }[]>>;

export interface OverviewShift {
  shift_id: string;
  register_name: string;
  opened_at: string;
  opened_by_name: string;
}

export interface OverviewTerminal {
  id: string;
  label: string;
  provider_key: string;
  kind: string;
  last_seen_at: string | null;
  register_id: string | null;
}

export interface BranchOverview {
  store_id: string;
  name: string;
  short_name: string | null;
  color: string | null;
  is_default: boolean;
  is_active: boolean;
  opening_hours: OpeningHoursMap | null;
  registers_total: number;
  registers_open: number;
  open_shifts: OverviewShift[];
  sales_today_total: number;
  sales_today_count: number;
  last_sale_at: string | null;
  staff_on_shift: number;
  staff_assigned: number;
  low_stock_count: number;
  pending_waiting: number;
  pending_waiting_amount: number;
  pending_paid_unsold: number;
  terminals: OverviewTerminal[];
  last_z: { closed_at: string; difference: number; z_number: number } | null;
  close_tolerance: number;
}

export type AlertSeverity = "danger" | "warning" | "info";
export type AlertKind =
  | "long_shift"
  | "closed_in_hours"
  | "paid_unsold"
  | "terminal_stale"
  | "z_difference"
  | "no_sales_in_hours"
  | "low_stock";

export interface MonitorAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
}

export interface MonitorThresholds {
  /** Caja abierta hace más de N horas. */
  longShiftHours: number;
  /** Terminal sin señal hace más de N minutos (sólo en horario). */
  terminalStaleMinutes: number;
  /** Sin ventas hace más de N minutos estando en horario y con caja abierta (0 = no avisar). */
  noSaleMinutes: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  longShiftHours: 12,
  terminalStaleMinutes: 30,
  noSaleMinutes: 0,
};

const DAY_KEYS: WeekDayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TZ = "America/Argentina/Buenos_Aires";

/** Día de la semana y "HH:MM" en Argentina. */
export function argentinaClock(now: Date): { day: WeekDayKey; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday").toLowerCase().slice(0, 3);
  const day = (DAY_KEYS.find((d) => d === wd) ?? "mon") as WeekDayKey;
  const hour = get("hour").padStart(2, "0").replace("24", "00");
  return { day, hhmm: `${hour}:${get("minute").padStart(2, "0")}` };
}

/**
 * ¿La sucursal está en horario? null = no tiene horario cargado (no se puede
 * saber, y entonces no se alerta por horario).
 */
export function isWithinOpeningHours(hours: OpeningHoursMap | null | undefined, now: Date): boolean | null {
  if (!hours || typeof hours !== "object") return null;
  const anyDay = DAY_KEYS.some((d) => (hours[d] ?? []).length > 0);
  if (!anyDay) return null;
  const { day, hhmm } = argentinaClock(now);
  return (hours[day] ?? []).some((r) => r.from && r.to && hhmm >= r.from && hhmm < r.to);
}

const minutesSince = (iso: string | null | undefined, now: Date) =>
  iso ? (now.getTime() - new Date(iso).getTime()) / 60_000 : Number.POSITIVE_INFINITY;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Alertas de una sucursal, de la más grave a la más leve. */
export function branchAlerts(
  row: BranchOverview,
  now: Date,
  thresholds: Partial<MonitorThresholds> = {},
): MonitorAlert[] {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const out: MonitorAlert[] = [];
  const inHours = isWithinOpeningHours(row.opening_hours, now);

  const long = row.open_shifts.filter((s) => minutesSince(s.opened_at, now) > t.longShiftHours * 60);
  if (long.length > 0) {
    const names = long.map((s) => s.register_name).join(", ");
    out.push({
      kind: "long_shift",
      severity: "warning",
      message: `${long.length === 1 ? "Caja abierta" : "Cajas abiertas"} hace más de ${t.longShiftHours} h: ${names}`,
    });
  }

  if (inHours === true && row.registers_open === 0 && row.registers_total > 0) {
    out.push({ kind: "closed_in_hours", severity: "danger", message: "En horario y sin ninguna caja abierta" });
  }

  if (row.pending_paid_unsold > 0) {
    out.push({
      kind: "paid_unsold",
      severity: "danger",
      message: `${plural(row.pending_paid_unsold, "cobro pagado", "cobros pagados")} sin venta`,
    });
  }

  if (inHours === true) {
    const stale = row.terminals.filter((x) => minutesSince(x.last_seen_at, now) > t.terminalStaleMinutes);
    if (stale.length > 0) {
      out.push({
        kind: "terminal_stale",
        severity: "warning",
        message: `${stale.length === 1 ? "Terminal" : "Terminales"} sin señal hace más de ${t.terminalStaleMinutes} min: ${stale
          .map((x) => x.label)
          .join(", ")}`,
      });
    }
  }

  if (row.last_z && Math.abs(Number(row.last_z.difference) || 0) > Math.max(0, Number(row.close_tolerance) || 0)) {
    out.push({
      kind: "z_difference",
      severity: "warning",
      message: `Último cierre Z con diferencia fuera de la tolerancia`,
    });
  }

  if (
    t.noSaleMinutes > 0 &&
    inHours === true &&
    row.registers_open > 0 &&
    minutesSince(row.last_sale_at, now) > t.noSaleMinutes
  ) {
    out.push({
      kind: "no_sales_in_hours",
      severity: "info",
      message: `Sin ventas hace más de ${t.noSaleMinutes} min`,
    });
  }

  if (row.low_stock_count > 0) {
    out.push({
      kind: "low_stock",
      severity: "info",
      message: `${plural(row.low_stock_count, "producto", "productos")} con faltante`,
    });
  }

  const rank: Record<AlertSeverity, number> = { danger: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Peor severidad de la lista (para el borde de la tarjeta). */
export function worstSeverity(alerts: MonitorAlert[]): AlertSeverity | null {
  if (alerts.some((a) => a.severity === "danger")) return "danger";
  if (alerts.some((a) => a.severity === "warning")) return "warning";
  if (alerts.length > 0) return "info";
  return null;
}
