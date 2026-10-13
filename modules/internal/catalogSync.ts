// Tiendita: estado de la sincronización con el feed del scraper (ADR-106).
// Lee catalog_sync_runs (RLS: sólo staff interno en /internal) y dispara la
// Edge catalog_sync. catalog_sync_runs no está en types/database.ts (no se
// regenera): cliente "destipado" sólo para esta tabla, como catalogs.ts.
import { createClient } from "@/lib/supabase/client";

export type SyncStatus = "running" | "ok" | "partial" | "error";

export interface SyncStoreState {
  key: string;
  label: string;
  full: boolean;
  done: boolean;
  pages: number;
  nuevos: number;
  actualizados: number;
  faltantes: number;
  error: string | null;
}

export interface SyncRun {
  id: string;
  trigger: "manual" | "cron";
  status: SyncStatus;
  mode: "full" | "incremental" | "mixed" | null;
  currentStore: string | null;
  nuevos: number;
  actualizados: number;
  faltantes: number;
  errores: number;
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
  heartbeatAt: string | null;
  stores: SyncStoreState[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function parseSyncRun(row: Record<string, unknown>): SyncRun {
  const raw = (row.stores ?? {}) as Record<string, Record<string, unknown>>;
  const stores = Object.keys(raw)
    .sort()
    .map((key) => {
      const s = raw[key] ?? {};
      return {
        key,
        label: String(s.label ?? key),
        full: s.full === true,
        done: s.done === true,
        pages: num(s.pages),
        nuevos: num(s.nuevos),
        actualizados: num(s.actualizados),
        faltantes: num(s.faltantes) + num(s.marcados),
        error: s.error ? String(s.error) : null,
      };
    });
  return {
    id: String(row.id),
    trigger: row.trigger === "cron" ? "cron" : "manual",
    status: (["running", "ok", "partial", "error"].includes(String(row.status)) ? row.status : "error") as SyncStatus,
    mode: (row.mode as SyncRun["mode"]) ?? null,
    currentStore: (row.current_store as string) ?? null,
    nuevos: num(row.nuevos),
    actualizados: num(row.actualizados),
    faltantes: num(row.faltantes),
    errores: num(row.errores),
    lastError: (row.last_error as string) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string) ?? null,
    heartbeatAt: (row.heartbeat_at as string) ?? null,
    stores,
  };
}

/** Tiendas terminadas sobre el total (para la barra de progreso). */
export function syncProgress(run: SyncRun): { done: number; total: number; pct: number } {
  const total = run.stores.length;
  const done = run.stores.filter((s) => s.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 todo el año

/**
 * Próxima sync automática: sábado 06:00 hora Argentina (09:00 UTC), el job
 * `catalog-sync-weekly` de la migración 20261110500000.
 */
export function nextWeeklySync(now: Date = new Date()): Date {
  const ar = new Date(now.getTime() - AR_OFFSET_MS); // reloj de pared AR en campos UTC
  const target = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate(), 6, 0, 0, 0));
  let add = (6 - ar.getUTCDay() + 7) % 7;
  if (add === 0 && ar.getTime() >= target.getTime()) add = 7;
  target.setUTCDate(target.getUTCDate() + add);
  return new Date(target.getTime() + AR_OFFSET_MS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
function db(): AnyDb {
  return createClient() as AnyDb;
}

export const catalogSyncApi = {
  listRuns: async (limit = 5): Promise<SyncRun[]> => {
    const { data, error } = await db()
      .from("catalog_sync_runs")
      .select(
        "id, trigger, status, mode, current_store, nuevos, actualizados, faltantes, errores, last_error, started_at, finished_at, heartbeat_at, stores",
      )
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(parseSyncRun);
  },

  start: async (full = false): Promise<string> => {
    const { data, error } = await createClient().functions.invoke("catalog_sync", {
      body: { action: "start", full },
    });
    if (error) throw error;
    return String((data as { run_id?: string } | null)?.run_id ?? "");
  },
};
