// ADR-113: agenda editable de la sync automática del catálogo. Cron (mismas
// reglas que catalog_sync_cron_set en SQL), validación del formulario,
// próxima ejecución en hora Argentina, equivalente UTC y payload de la RPC.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SYNC_CONFIG,
  describeSchedule,
  formatDuration,
  isValidCron,
  nextRunIsFull,
  nextScheduledRun,
  parseCron,
  parseCronField,
  parseSyncConfig,
  toConfigPayload,
  utcCronEquivalent,
  validateSyncConfig,
  type SyncScheduleConfig,
} from "@/modules/internal/catalogSyncSchedule";
import { nextWeeklySync, parseSyncRun } from "@/modules/internal/catalogSync";

const cfg = (patch: Partial<SyncScheduleConfig> = {}): SyncScheduleConfig => ({ ...DEFAULT_SYNC_CONFIG, ...patch });
const next = (c: SyncScheduleConfig, now: string) => nextScheduledRun(c, new Date(now))?.toISOString() ?? null;

describe("cron", () => {
  it("expande campos: *, listas, rangos y pasos", () => {
    expect(parseCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
    expect(parseCronField("1-5,0", 0, 7)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parseCronField("10/20", 0, 59)).toEqual([10, 30, 50]);
    expect(parseCronField("1-10/3", 1, 31)).toEqual([1, 4, 7, 10]);
  });

  it("rechaza lo inválido (igual que SQL)", () => {
    for (const bad of ["", "0 6 * *", "60 6 * * *", "0 24 * * *", "0 6 * * MON", "0 6 0 * *", "0 6 * * 8", "0 6 1-5/0 * *", "0 6 5-1 * *", "005 6 * * *", "0 6 * * * *"]) {
      expect(isValidCron(bad), bad).toBe(false);
    }
    for (const good of ["0 6 * * 6", "*/5 * * * *", "0 6 * * 7", " 30  5 * * 1-5 ", "0 0 1,15 * *"]) {
      expect(isValidCron(good), good).toBe(true);
    }
  });

  it("7 es domingo y se marca si día del mes o de la semana están restringidos", () => {
    const s = parseCron("0 6 13 * 7")!;
    expect(s.dows).toEqual([0]);
    expect(s.domStar).toBe(false);
    expect(s.dowStar).toBe(false);
    expect(parseCron("0 6 * * 1")!.domStar).toBe(true);
  });
});

describe("validación del formulario", () => {
  it("la config por defecto (sábado 06:00) es válida", () => {
    expect(validateSyncConfig(DEFAULT_SYNC_CONFIG)).toEqual({});
  });

  it("hora inválida", () => {
    expect(validateSyncConfig(cfg({ hour: 24 })).hour).toBeTruthy();
    expect(validateSyncConfig(cfg({ minute: 60 })).hour).toBeTruthy();
    expect(validateSyncConfig(cfg({ hour: -1 })).hour).toBeTruthy();
    expect(validateSyncConfig(cfg({ hour: 23, minute: 59 })).hour).toBeUndefined();
  });

  it("semanal necesita al menos un día", () => {
    expect(validateSyncConfig(cfg({ weekdays: [] })).weekdays).toBeTruthy();
    expect(validateSyncConfig(cfg({ weekdays: [7] })).weekdays).toBeTruthy();
    // Diaria no mira los días.
    expect(validateSyncConfig(cfg({ frequency: "daily", weekdays: [] }))).toEqual({});
  });

  it("cada N días entre 1 y 90", () => {
    expect(validateSyncConfig(cfg({ frequency: "interval", intervalDays: null })).intervalDays).toBeTruthy();
    expect(validateSyncConfig(cfg({ frequency: "interval", intervalDays: 0 })).intervalDays).toBeTruthy();
    expect(validateSyncConfig(cfg({ frequency: "interval", intervalDays: 91 })).intervalDays).toBeTruthy();
    expect(validateSyncConfig(cfg({ frequency: "interval", intervalDays: 3 }))).toEqual({});
  });

  it("cron válido (la hora del formulario no aplica)", () => {
    expect(validateSyncConfig(cfg({ frequency: "cron", cronExpr: "0 6 * *" })).cronExpr).toBeTruthy();
    expect(validateSyncConfig(cfg({ frequency: "cron", cronExpr: "0 6 * * 6", hour: 99 }))).toEqual({});
  });

  it("completa cada K: entre 2 y 52 o nada", () => {
    expect(validateSyncConfig(cfg({ fullEvery: 1 })).fullEvery).toBeTruthy();
    expect(validateSyncConfig(cfg({ fullEvery: Number.NaN })).fullEvery).toBeTruthy();
    expect(validateSyncConfig(cfg({ fullEvery: 4 }))).toEqual({});
  });
});

describe("próxima ejecución (hora Argentina, UTC-3)", () => {
  it("por defecto coincide con el job fijo de ADR-107", () => {
    for (const now of ["2026-10-13T15:00:00Z", "2026-10-17T08:00:00Z", "2026-10-17T09:00:00Z", "2026-10-17T02:30:00Z"]) {
      expect(next(DEFAULT_SYNC_CONFIG, now)).toBe(nextWeeklySync(new Date(now)).toISOString());
    }
  });

  it("el minuto actual ya pasó: va a la siguiente", () => {
    expect(next(cfg({ frequency: "daily", hour: 6 }), "2026-10-13T09:00:30Z")).toBe("2026-10-14T09:00:00.000Z");
    expect(next(cfg({ frequency: "daily", hour: 6 }), "2026-10-13T08:59:59Z")).toBe("2026-10-13T09:00:00.000Z");
  });

  it("diaria a la noche cruza el día en UTC", () => {
    // 22:30 AR = 01:30 UTC del día siguiente.
    expect(next(cfg({ frequency: "daily", hour: 22, minute: 30 }), "2026-10-13T15:00:00Z")).toBe("2026-10-14T01:30:00.000Z");
  });

  it("semanal con varios días", () => {
    // Martes 13/10 12:00 AR; lunes y jueves 05:00 → jueves 15/10.
    const c = cfg({ weekdays: [1, 4], hour: 5 });
    expect(next(c, "2026-10-13T15:00:00Z")).toBe("2026-10-15T08:00:00.000Z");
    expect(next(c, "2026-10-15T08:00:00Z")).toBe("2026-10-19T08:00:00.000Z");
  });

  it("cada N días desde el ancla", () => {
    const c = cfg({ frequency: "interval", intervalDays: 3, anchorDate: "2026-10-13", hour: 6 });
    expect(next(c, "2026-10-13T08:00:00Z")).toBe("2026-10-13T09:00:00.000Z");
    expect(next(c, "2026-10-13T10:00:00Z")).toBe("2026-10-16T09:00:00.000Z");
    // Antes del ancla no corre.
    expect(next(c, "2026-10-10T10:00:00Z")).toBe("2026-10-13T09:00:00.000Z");
  });

  it("cron avanzado en hora AR", () => {
    // Lunes a viernes 05:30 AR. Viernes 16/10 10:00 AR → lunes 19/10.
    expect(next(cfg({ frequency: "cron", cronExpr: "30 5 * * 1-5" }), "2026-10-16T13:00:00Z")).toBe("2026-10-19T08:30:00.000Z");
    // Cada 15 min.
    expect(next(cfg({ frequency: "cron", cronExpr: "*/15 * * * *" }), "2026-10-13T15:07:00Z")).toBe("2026-10-13T15:15:00.000Z");
    // Día 1 o domingo (OR clásico): martes 13/10 → domingo 18/10 06:00.
    expect(next(cfg({ frequency: "cron", cronExpr: "0 6 1 * 0" }), "2026-10-13T15:00:00Z")).toBe("2026-10-18T09:00:00.000Z");
  });

  it("sin próxima: apagada, inválida o imposible", () => {
    expect(next(cfg({ enabled: false }), "2026-10-13T15:00:00Z")).toBeNull();
    expect(next(cfg({ weekdays: [] }), "2026-10-13T15:00:00Z")).toBeNull();
    expect(next(cfg({ frequency: "cron", cronExpr: "0 6 30 2 *" }), "2026-10-13T15:00:00Z")).toBeNull();
  });
});

describe("tipo de corrida y textos", () => {
  it("completa cada K corridas", () => {
    expect(nextRunIsFull(cfg())).toBe(false);
    expect(nextRunIsFull(cfg({ runKind: "full" }))).toBe(true);
    expect(nextRunIsFull(cfg({ fullEvery: 4, autoRunsSinceFull: 2 }))).toBe(false);
    expect(nextRunIsFull(cfg({ fullEvery: 4, autoRunsSinceFull: 3 }))).toBe(true);
  });

  it("equivalente UTC para pg_cron", () => {
    expect(utcCronEquivalent(DEFAULT_SYNC_CONFIG)).toBe("0 9 * * 6");
    expect(utcCronEquivalent(cfg({ frequency: "daily", hour: 22, minute: 30 }))).toBe("30 1 * * *");
    // Sábado 22:00 AR = domingo 01:00 UTC.
    expect(utcCronEquivalent(cfg({ weekdays: [6, 1], hour: 22 }))).toBe("0 1 * * 0,2");
    expect(utcCronEquivalent(cfg({ frequency: "interval", intervalDays: 2 }))).toBeNull();
  });

  it("describe la agenda sin rayas largas", () => {
    expect(describeSchedule(DEFAULT_SYNC_CONFIG)).toBe("Los sábados a las 06:00 (hora Argentina), sólo cambios.");
    expect(describeSchedule(cfg({ weekdays: [1, 3, 5], fullEvery: 4 }))).toBe(
      "Los lunes, miércoles y viernes a las 06:00 (hora Argentina), sólo cambios, y una completa cada 4 corridas.",
    );
    expect(describeSchedule(cfg({ enabled: false }))).toBe("Sincronización automática apagada.");
    expect(describeSchedule(cfg({ frequency: "interval", intervalDays: 3, runKind: "full" }))).toContain("Cada 3 días");
    expect(describeSchedule(cfg({ frequency: "cron", cronExpr: "0 6 * * 6" }))).not.toContain("—");
  });

  it("fila de la base ↔ payload de la RPC", () => {
    const c = parseSyncConfig({
      enabled: true,
      frequency: "weekly",
      weekdays: [3, 1],
      hour: 2,
      minute: 30,
      run_kind: "incremental",
      full_every: 4,
      interval_days: null,
      cron_expr: null,
      auto_runs_since_full: 1,
    });
    expect(c).toMatchObject({ weekdays: [3, 1], hour: 2, minute: 30, fullEvery: 4, autoRunsSinceFull: 1 });
    expect(toConfigPayload({ ...c, weekdays: [3, 1, 1] })).toEqual({
      enabled: true,
      frequency: "weekly",
      weekdays: [1, 3],
      interval_days: null,
      hour: 2,
      minute: 30,
      cron_expr: null,
      run_kind: "incremental",
      full_every: 4,
    });
    expect(toConfigPayload(cfg({ frequency: "cron", cronExpr: "  0   6 * *  6 ", runKind: "full", fullEvery: 4 }))).toMatchObject({
      cron_expr: "0 6 * * 6",
      full_every: null,
    });
    expect(parseSyncConfig(null)).toEqual(DEFAULT_SYNC_CONFIG);
  });

  it("duración legible", () => {
    expect(formatDuration("2026-10-13T09:00:00Z", "2026-10-13T09:00:40Z")).toBe("40 s");
    expect(formatDuration("2026-10-13T09:00:00Z", "2026-10-13T09:25:10Z")).toBe("25 min");
    expect(formatDuration("2026-10-13T09:00:00Z", "2026-10-13T12:05:00Z")).toBe("3 h 05 min");
    expect(formatDuration("2026-10-13T09:00:00Z", null, new Date("2026-10-13T09:02:00Z"))).toBe("2 min");
  });

  it("parseSyncRun: cancelada y pausada", () => {
    const base = { id: "r", trigger: "cron", started_at: "2026-10-13T09:00:00Z", stores: {} };
    expect(parseSyncRun({ ...base, status: "cancelled" }).status).toBe("cancelled");
    const p = parseSyncRun({ ...base, status: "running", paused_at: "2026-10-13T09:10:00Z", force_full: true });
    expect(p.pausedAt).toBe("2026-10-13T09:10:00Z");
    expect(p.forceFull).toBe(true);
  });
});
