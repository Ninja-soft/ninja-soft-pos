// Tiendita: estado de la sincronización con el feed del scraper (ADR-107,
// ADR-109: catálogo maestro por EAN + ofertas de todas las tiendas y
// vendedores). Lee catalog_sync_runs (RLS: sólo staff interno en /internal),
// las estadísticas de deduplicación (catalog_dedupe_stats) y el comparador de
// precios (catalog_price_compare), y dispara la Edge catalog_sync. catalog_sync_runs no está en types/database.ts (no se
// regenera): cliente "destipado" sólo para esta tabla, como catalogs.ts.
import { createClient } from "@/lib/supabase/client";
import { parseMarketOffer, type MarketOffer } from "@/modules/catalog/priceReference";
import { parseSyncConfig, toConfigPayload, type SyncScheduleConfig } from "./catalogSyncSchedule";

export type SyncControlAction = "pause" | "resume" | "cancel";

export type SyncStatus = "running" | "ok" | "partial" | "error" | "cancelled";

/** Resultado por tienda: ofertas (de la tienda y de otros vendedores). */
export interface SyncStoreState {
  key: string;
  label: string;
  done: boolean;
  nuevos: number;
  actualizados: number;
  faltantes: number;
  error: string | null;
}

/** Lectura del feed maestro (catalog_sync_runs.feed). */
export interface SyncFeedState {
  full: boolean;
  done: boolean;
  pages: number;
  recibidos: number;
  error: string | null;
}

export interface SyncRun {
  id: string;
  trigger: "manual" | "cron";
  status: SyncStatus;
  /** ADR-113: pausada por el staff (sigue abierta). */
  pausedAt: string | null;
  forceFull: boolean;
  mode: "full" | "incremental" | "mixed" | null;
  currentStore: string | null;
  /** Productos únicos (catalog_items) nuevos / actualizados. */
  nuevos: number;
  actualizados: number;
  ofertasNuevas: number;
  ofertasActualizadas: number;
  feed: SyncFeedState | null;
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
        done: s.done === true,
        nuevos: num(s.nuevos),
        actualizados: num(s.actualizados),
        faltantes: num(s.faltantes) + num(s.marcados),
        error: s.error ? String(s.error) : null,
      };
    });
  return {
    id: String(row.id),
    trigger: row.trigger === "cron" ? "cron" : "manual",
    status: (["running", "ok", "partial", "error", "cancelled"].includes(String(row.status))
      ? row.status
      : "error") as SyncStatus,
    pausedAt: (row.paused_at as string) ?? null,
    forceFull: row.force_full === true,
    mode: (row.mode as SyncRun["mode"]) ?? null,
    currentStore: (row.current_store as string) ?? null,
    nuevos: num(row.nuevos),
    actualizados: num(row.actualizados),
    ofertasNuevas: num(row.ofertas_nuevas),
    ofertasActualizadas: num(row.ofertas_actualizadas),
    feed: parseFeed(row.feed),
    faltantes: num(row.faltantes),
    errores: num(row.errores),
    lastError: (row.last_error as string) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string) ?? null,
    heartbeatAt: (row.heartbeat_at as string) ?? null,
    stores,
  };
}

function parseFeed(raw: unknown): SyncFeedState | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  return {
    full: f.full === true,
    done: f.done === true,
    pages: num(f.pages),
    recibidos: num(f.recibidos),
    error: f.error ? String(f.error) : null,
  };
}

/**
 * Avance: la lectura del feed (sin total conocido) pesa 80 % y el cierre por
 * tienda el 20 % restante. Mientras se lee, el % crece con las páginas sin
 * llegar nunca al tramo de cierre.
 */
export function syncProgress(run: SyncRun): { phase: "feed" | "stores"; done: number; total: number; pct: number } {
  const total = run.stores.length;
  const done = run.stores.filter((s) => s.done).length;
  if (!run.feed || !run.feed.done) {
    const pages = run.feed?.pages ?? 0;
    return { phase: "feed", done: pages, total: 0, pct: Math.min(79, Math.round(80 * (1 - 1 / (1 + pages / 200)))) };
  }
  return { phase: "stores", done, total, pct: 80 + (total ? Math.round((done / total) * 20) : 20) };
}

export type StoreRowState = "pending" | "running" | "ok" | "error";

/**
 * Estado de una tienda dentro de la corrida (tabla del panel). El feed
 * maestro trae todas las tiendas a la vez: mientras se lee, todas están "en
 * curso" sin porcentaje propio (pct null = barra indeterminada). En el cierre,
 * la tienda que se está cerrando está en curso, las cerradas OK (o Error) y
 * el resto pendiente. Una corrida terminada sin cerrar la tienda (cancelada)
 * la deja pendiente.
 */
export function storeRowState(run: SyncRun, store: SyncStoreState): { state: StoreRowState; pct: number | null } {
  if (store.error && store.done) return { state: "error", pct: 100 };
  if (store.done) return { state: "ok", pct: 100 };
  const open = run.status === "running";
  if (!open) return { state: "pending", pct: 0 };
  if (!run.feed || !run.feed.done) return { state: run.pausedAt ? "pending" : "running", pct: null };
  if (run.currentStore === store.key && !run.pausedAt) return { state: "running", pct: null };
  return { state: store.error ? "error" : "pending", pct: 0 };
}

/** ¿La corrida fue (o es) una lectura completa? */
export function runIsFull(run: SyncRun): boolean {
  return run.feed ? run.feed.full : run.mode === "full" || run.forceFull;
}

/**
 * Tiempo transcurrido y estimación de lo que falta para la corrida abierta,
 * según la duración de la última corrida terminada (ok o con errores) del
 * mismo tipo (completa o sólo cambios). Sin una así, no hay estimación.
 * Pausada: no se estima (el reloj no corre igual).
 */
export function estimateEta(
  run: SyncRun,
  history: SyncRun[],
  now: Date = new Date(),
): { elapsedMs: number; etaMs: number | null; basis: "full" | "incremental" | null } {
  const elapsedMs = Math.max(0, now.getTime() - new Date(run.startedAt).getTime());
  if (run.status !== "running" || run.pausedAt) return { elapsedMs, etaMs: null, basis: null };
  const full = runIsFull(run);
  const prev = history.find(
    (r) =>
      r.id !== run.id &&
      (r.status === "ok" || r.status === "partial") &&
      r.finishedAt &&
      runIsFull(r) === full,
  );
  if (!prev?.finishedAt) return { elapsedMs, etaMs: null, basis: null };
  const prevMs = new Date(prev.finishedAt).getTime() - new Date(prev.startedAt).getTime();
  return { elapsedMs, etaMs: Math.max(prevMs - elapsedMs, 0), basis: full ? "full" : "incremental" };
}

/** Estadísticas de deduplicación (catalog_dedupe_stats). */
export interface DedupeStoreStats {
  key: string;
  name: string;
  ofertasTienda: number;
  ofertasVendedores: number;
  disponibles: number;
  enCatalogo: boolean;
}

export interface DedupeStats {
  /** Todavía no hay cálculo guardado (lo hace un cron cada 30 min). */
  pending: boolean;
  /** Cuándo se calcularon los números (caché de catalog_stats_cache). */
  computedAt: string | null;
  items: number;
  itemsGlobales: number;
  itemsPorTienda: number;
  itemsConVariasTiendas: number;
  ofertas: number;
  ofertasTienda: number;
  ofertasVendedores: number;
  /** Filas de ficha que ahorra el maestro contra una por (tienda, producto). */
  ahorro: number;
  ahorroPct: number;
  tiendas: DedupeStoreStats[];
}

export function parseDedupeStats(raw: unknown): DedupeStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = num(r.items);
  const ofertasTienda = num(r.ofertas_tienda);
  const ahorro = Math.max(ofertasTienda - items, 0);
  return {
    pending: r.pending === true,
    computedAt: typeof r.computed_at === "string" ? r.computed_at : null,
    items,
    itemsGlobales: num(r.items_globales),
    itemsPorTienda: num(r.items_por_tienda),
    itemsConVariasTiendas: num(r.items_con_varias_tiendas),
    ofertas: num(r.ofertas),
    ofertasTienda,
    ofertasVendedores: num(r.ofertas_vendedores),
    ahorro,
    ahorroPct: ofertasTienda ? Math.round((ahorro / ofertasTienda) * 1000) / 10 : 0,
    tiendas: (Array.isArray(r.tiendas) ? (r.tiendas as Record<string, unknown>[]) : []).map((t) => ({
      key: String(t.key ?? ""),
      name: String(t.name ?? t.key ?? ""),
      ofertasTienda: num(t.ofertas_tienda),
      ofertasVendedores: num(t.ofertas_vendedores),
      disponibles: num(t.disponibles),
      enCatalogo: t.en_catalogo === true,
    })),
  };
}

const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 todo el año

/**
 * Próxima sync automática con la agenda fija de ADR-107 (sábado 06:00 hora
 * Argentina, 09:00 UTC). Desde ADR-113 la agenda es editable: el panel usa
 * nextScheduledRun (catalogSyncSchedule.ts); esto queda como referencia.
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
        "id, trigger, status, paused_at, force_full, mode, current_store, nuevos, actualizados, ofertas_nuevas, ofertas_actualizadas, faltantes, errores, last_error, started_at, finished_at, heartbeat_at, stores, feed",
      )
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(parseSyncRun);
  },

  dedupeStats: async (): Promise<DedupeStats> => {
    const { data, error } = await db().rpc("catalog_dedupe_stats");
    if (error) throw error;
    return parseDedupeStats(data);
  },

  // Comparador interno: todas las tiendas y vendedores (internal_scope).
  compare: async (ean: string): Promise<MarketOffer[]> => {
    const { data, error } = await db().rpc("catalog_price_compare", { p_ean: ean.trim() });
    if (error) throw error;
    return ((data ?? []) as Record<string, unknown>[]).map(parseMarketOffer);
  },

  // ADR-113: agenda editable (fila única, RLS sólo staff interno).
  getConfig: async (): Promise<SyncScheduleConfig> => {
    const { data, error } = await db().from("catalog_sync_config").select("*").maybeSingle();
    if (error) throw error;
    return parseSyncConfig(data as Record<string, unknown> | null);
  },

  saveConfig: async (config: SyncScheduleConfig): Promise<SyncScheduleConfig> => {
    const { data, error } = await db().rpc("internal_catalog_sync_config_save", { p_config: toConfigPayload(config) });
    if (error) throw error;
    return parseSyncConfig(data as Record<string, unknown>);
  },

  control: async (runId: string, action: SyncControlAction): Promise<void> => {
    const { error } = await db().rpc("internal_catalog_sync_control", { p_run: runId, p_action: action });
    if (error) throw error;
  },

  start: async (full = false): Promise<string> => {
    const { data, error } = await createClient().functions.invoke("catalog_sync", {
      body: { action: "start", full },
    });
    if (error) throw error;
    return String((data as { run_id?: string } | null)?.run_id ?? "");
  },
};
