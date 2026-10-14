// Agenda editable de la sincronización automática del catálogo (ADR-113).
//
// La configuración vive en catalog_sync_config (fila única). El job de
// pg_cron `catalog-sync-continue` corre cada minuto y llama a
// catalog_sync_tick(), que con las MISMAS reglas que este archivo decide si
// toca abrir una corrida (todo en hora Argentina). Acá: validación del
// formulario, próxima ejecución, equivalente UTC y textos del panel.
//
// Reglas de cron (iguales en SQL, catalog_sync_cron_set): 5 campos
// (minuto hora día-del-mes mes día-de-la-semana), números, "*", listas con
// coma, rangos "a-b" y pasos "/n" ("*/n", "a-b/n", "a/n"). Día de la semana
// 0-7 (0 y 7 = domingo). Sin nombres (MON, JAN). Si día-del-mes y
// día-de-la-semana están los dos restringidos, alcanza con que coincida uno
// (como cron clásico).

export type SyncFrequency = "daily" | "weekly" | "interval" | "cron";
export type SyncRunKind = "incremental" | "full";

export interface SyncScheduleConfig {
  enabled: boolean;
  frequency: SyncFrequency;
  /** 0 = domingo … 6 = sábado. */
  weekdays: number[];
  /** Cada N días (frequency = "interval"). */
  intervalDays: number | null;
  /** Día (AR, YYYY-MM-DD) desde el que se cuentan los N días. */
  anchorDate: string | null;
  /** Hora Argentina. */
  hour: number;
  minute: number;
  /** Cron avanzado en hora Argentina. */
  cronExpr: string | null;
  runKind: SyncRunKind;
  /** Cada cuántas corridas automáticas una es completa (null = nunca forzar). */
  fullEvery: number | null;
  autoRunsSinceFull: number;
  lastAutoAt: string | null;
  lastAutoNote: string | null;
  updatedAt: string | null;
}

/** Lo mismo que hacía el job fijo `catalog-sync-weekly`: sábado 06:00 AR, incremental. */
export const DEFAULT_SYNC_CONFIG: SyncScheduleConfig = {
  enabled: true,
  frequency: "weekly",
  weekdays: [6],
  intervalDays: null,
  anchorDate: null,
  hour: 6,
  minute: 0,
  cronExpr: null,
  runKind: "incremental",
  fullEvery: null,
  autoRunsSinceFull: 0,
  lastAutoAt: null,
  lastAutoNote: null,
  updatedAt: null,
};

export const WEEKDAY_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;
const WEEKDAY_PLURAL = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"] as const;
export const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 90;
export const FULL_EVERY_MIN = 2;
export const FULL_EVERY_MAX = 52;

const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 todo el año
const DAY_MS = 24 * 60 * 60 * 1000;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/** Expande un campo de cron al conjunto de valores (ordenado). null = inválido. */
export function parseCronField(field: string, lo: number, hi: number): number[] | null {
  if (!field || !/^[0-9*,\-/]+$/.test(field)) return null;
  const out = new Set<number>();
  for (const token of field.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(token);
    if (!m) return null;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (step < 1) return null;
    let a: number;
    let b: number;
    if (m[1] === "*") {
      a = lo;
      b = hi;
    } else {
      a = Number(m[2]);
      // "a/n" = desde a hasta el máximo de a n.
      b = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : a;
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export interface CronSpec {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  /** 0-6 (el 7 ya convertido a 0). */
  dows: number[];
  domStar: boolean;
  dowStar: boolean;
}

export function parseCron(expr: string | null | undefined): CronSpec | null {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi = "", ho = "", dom = "", mo = "", dow = ""] = parts;
  const minutes = parseCronField(mi, 0, 59);
  const hours = parseCronField(ho, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const months = parseCronField(mo, 1, 12);
  const dowsRaw = parseCronField(dow, 0, 7);
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = [...new Set(dowsRaw.map((d) => (d === 7 ? 0 : d)))].sort((x, y) => x - y);
  return { minutes, hours, doms, months, dows, domStar: dom.startsWith("*"), dowStar: dow.startsWith("*") };
}

export const isValidCron = (expr: string | null | undefined) => parseCron(expr) !== null;

/** Cron (hora AR) que representa la agenda. "interval" filtra además por días. */
export function scheduleCron(c: SyncScheduleConfig): string {
  switch (c.frequency) {
    case "daily":
    case "interval":
      return `${c.minute} ${c.hour} * * *`;
    case "weekly":
      return `${c.minute} ${c.hour} * * ${[...new Set(c.weekdays)].sort((a, b) => a - b).join(",")}`;
    case "cron":
      return String(c.cronExpr ?? "").trim();
  }
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

export type SyncConfigErrors = Partial<Record<"hour" | "weekdays" | "intervalDays" | "cronExpr" | "fullEvery", string>>;

export function validateSyncConfig(c: SyncScheduleConfig): SyncConfigErrors {
  const e: SyncConfigErrors = {};
  if (c.frequency !== "cron") {
    if (!isInt(c.hour) || c.hour < 0 || c.hour > 23 || !isInt(c.minute) || c.minute < 0 || c.minute > 59) {
      e.hour = "Elegí una hora válida (00:00 a 23:59).";
    }
  }
  if (c.frequency === "weekly") {
    if (!c.weekdays.length) e.weekdays = "Elegí al menos un día.";
    else if (c.weekdays.some((d) => !isInt(d) || d < 0 || d > 6)) e.weekdays = "Hay un día inválido.";
  }
  if (c.frequency === "interval") {
    if (!isInt(c.intervalDays) || c.intervalDays < INTERVAL_MIN || c.intervalDays > INTERVAL_MAX) {
      e.intervalDays = `Elegí cada cuántos días (${INTERVAL_MIN} a ${INTERVAL_MAX}).`;
    }
  }
  if (c.frequency === "cron" && !isValidCron(c.cronExpr)) {
    e.cronExpr = "Expresión inválida. Usá 5 campos: minuto hora día mes día-de-la-semana (ej.: 0 6 * * 6).";
  }
  if (c.fullEvery !== null && (!isInt(c.fullEvery) || c.fullEvery < FULL_EVERY_MIN || c.fullEvery > FULL_EVERY_MAX)) {
    e.fullEvery = `Elegí un número entre ${FULL_EVERY_MIN} y ${FULL_EVERY_MAX}.`;
  }
  return e;
}

// ---------------------------------------------------------------------------
// Próxima ejecución
// ---------------------------------------------------------------------------

/** Fecha AR (YYYY-MM-DD) de un instante. */
export function arDate(d: Date): string {
  return new Date(d.getTime() - AR_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(ymd: string): number {
  return Math.floor(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / DAY_MS);
}

/** ¿El día (reloj AR en campos UTC de `wall`) entra en la agenda? */
function dayMatches(c: SyncScheduleConfig, spec: CronSpec, wall: Date, anchorDay: number): boolean {
  if (!spec.months.includes(wall.getUTCMonth() + 1)) return false;
  const domOk = spec.doms.includes(wall.getUTCDate());
  const dowOk = spec.dows.includes(wall.getUTCDay());
  const ok = spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
  if (!ok) return false;
  if (c.frequency === "interval") {
    const n = c.intervalDays ?? 1;
    const diff = Math.floor(wall.getTime() / DAY_MS) - anchorDay;
    return diff >= 0 && diff % n === 0;
  }
  return true;
}

/**
 * Próxima corrida automática estrictamente después del minuto de `now`
 * (el tick del minuto actual ya pasó). null si está apagada, la agenda es
 * inválida o no hay ninguna en los próximos 4 años (p. ej. "0 6 30 2 *").
 */
export function nextScheduledRun(c: SyncScheduleConfig, now: Date = new Date()): Date | null {
  if (!c.enabled) return null;
  if (Object.keys(validateSyncConfig(c)).length) return null;
  const spec = parseCron(scheduleCron(c));
  if (!spec) return null;
  const anchorDay = dayNumber(c.anchorDate ?? arDate(now));
  // Reloj de pared AR en campos UTC, desde el minuto siguiente.
  const start = new Date(Math.floor((now.getTime() - AR_OFFSET_MS) / 60_000) * 60_000 + 60_000);
  const startDay = Math.floor(start.getTime() / DAY_MS);
  for (let d = 0; d <= 366 * 4; d++) {
    const dayStart = (startDay + d) * DAY_MS;
    const wall = new Date(dayStart);
    if (!dayMatches(c, spec, wall, anchorDay)) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const t = dayStart + h * 3_600_000 + m * 60_000;
        if (t >= start.getTime()) return new Date(t + AR_OFFSET_MS);
      }
    }
  }
  return null;
}

/** ¿La próxima corrida automática será completa? */
export function nextRunIsFull(c: SyncScheduleConfig): boolean {
  return c.runKind === "full" || (c.fullEvery !== null && c.autoRunsSinceFull + 1 >= c.fullEvery);
}

/**
 * Equivalente en UTC (como lo escribiría pg_cron) para diaria y semanal.
 * Argentina es UTC-3 fijo: +3 h, y si pasa de las 23 el día corre uno.
 * null para "cada N días" y cron avanzado (se evalúan en hora AR).
 */
export function utcCronEquivalent(c: SyncScheduleConfig): string | null {
  if (c.frequency !== "daily" && c.frequency !== "weekly") return null;
  const h = c.hour + 3;
  const wraps = h >= 24;
  const hour = wraps ? h - 24 : h;
  if (c.frequency === "daily") return `${c.minute} ${hour} * * *`;
  const days = [...new Set(c.weekdays.map((d) => (wraps ? (d + 1) % 7 : d)))].sort((a, b) => a - b);
  return `${c.minute} ${hour} * * ${days.join(",")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function describeSchedule(c: SyncScheduleConfig): string {
  if (!c.enabled) return "Sincronización automática apagada.";
  const at = `a las ${pad(c.hour)}:${pad(c.minute)} (hora Argentina)`;
  let when: string;
  switch (c.frequency) {
    case "daily":
      when = `Todos los días ${at}`;
      break;
    case "weekly": {
      const days = [...new Set(c.weekdays)].sort((a, b) => a - b).map((d) => WEEKDAY_PLURAL[d]);
      const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} y ${days[days.length - 1]}` : days[0] ?? "";
      when = `Los ${list} ${at}`;
      break;
    }
    case "interval":
      when = c.intervalDays === 1 ? `Todos los días ${at}` : `Cada ${c.intervalDays} días ${at}`;
      break;
    case "cron":
      when = `Según el cron "${String(c.cronExpr ?? "").trim()}" (hora Argentina)`;
      break;
  }
  const kind =
    c.runKind === "full"
      ? "siempre lectura completa"
      : c.fullEvery
        ? `sólo cambios, y una completa cada ${c.fullEvery} corridas`
        : "sólo cambios";
  return `${when}, ${kind}.`;
}

// ---------------------------------------------------------------------------
// Fila de la base ↔ config
// ---------------------------------------------------------------------------

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function parseSyncConfig(row: Record<string, unknown> | null | undefined): SyncScheduleConfig {
  if (!row) return { ...DEFAULT_SYNC_CONFIG };
  const freq = String(row.frequency ?? "weekly");
  return {
    enabled: row.enabled !== false,
    frequency: (["daily", "weekly", "interval", "cron"].includes(freq) ? freq : "weekly") as SyncFrequency,
    weekdays: Array.isArray(row.weekdays) ? (row.weekdays as unknown[]).map((d) => Number(d)) : [6],
    intervalDays: numOrNull(row.interval_days),
    anchorDate: row.anchor_date ? String(row.anchor_date).slice(0, 10) : null,
    hour: num(row.hour, 6),
    minute: num(row.minute, 0),
    cronExpr: (row.cron_expr as string) ?? null,
    runKind: row.run_kind === "full" ? "full" : "incremental",
    fullEvery: numOrNull(row.full_every),
    autoRunsSinceFull: num(row.auto_runs_since_full, 0),
    lastAutoAt: (row.last_auto_at as string) ?? null,
    lastAutoNote: (row.last_auto_note as string) ?? null,
    updatedAt: (row.updated_at as string) ?? null,
  };
}

/** Payload de internal_catalog_sync_config_save (sólo lo editable). */
export function toConfigPayload(c: SyncScheduleConfig) {
  return {
    enabled: c.enabled,
    frequency: c.frequency,
    weekdays: [...new Set(c.weekdays)].sort((a, b) => a - b),
    interval_days: c.frequency === "interval" ? c.intervalDays : null,
    hour: c.hour,
    minute: c.minute,
    cron_expr: c.frequency === "cron" ? String(c.cronExpr ?? "").trim().replace(/\s+/g, " ") : null,
    run_kind: c.runKind,
    full_every: c.runKind === "full" ? null : c.fullEvery,
  };
}

/** Duración legible de una corrida ("1 h 05 min", "3 min", "40 s"). */
export function formatDuration(startIso: string, endIso: string | null, now: Date = new Date()): string {
  const ms = Math.max(0, (endIso ? new Date(endIso).getTime() : now.getTime()) - new Date(startIso).getTime());
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
