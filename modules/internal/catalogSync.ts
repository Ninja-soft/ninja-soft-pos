// Tiendita: estado de la sincronización con el feed del scraper (ADR-107,
// ADR-109: catálogo maestro por EAN + ofertas de todas las tiendas y
// vendedores). Lee catalog_sync_runs (RLS: sólo staff interno en /internal),
// las estadísticas de deduplicación (catalog_dedupe_stats) y el comparador de
// precios (catalog_price_compare), y dispara la Edge catalog_sync. catalog_sync_runs no está en types/database.ts (no se
// regenera): cliente "destipado" sólo para esta tabla, como catalogs.ts.
import { createClient } from "@/lib/supabase/client";
import { parseMarketOffer, type MarketOffer } from "@/modules/catalog/priceReference";

export type SyncStatus = "running" | "ok" | "partial" | "error";

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
    status: (["running", "ok", "partial", "error"].includes(String(row.status)) ? row.status : "error") as SyncStatus,
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
        "id, trigger, status, mode, current_store, nuevos, actualizados, ofertas_nuevas, ofertas_actualizadas, faltantes, errores, last_error, started_at, finished_at, heartbeat_at, stores, feed",
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

  start: async (full = false): Promise<string> => {
    const { data, error } = await createClient().functions.invoke("catalog_sync", {
      body: { action: "start", full },
    });
    if (error) throw error;
    return String((data as { run_id?: string } | null)?.run_id ?? "");
  },
};
