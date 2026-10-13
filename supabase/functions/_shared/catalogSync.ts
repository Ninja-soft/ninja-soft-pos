// =============================================================================
// Lógica pura de la sync del catálogo Tiendita desde el feed del scraper
// (ADR-107). Sin imports: la usan la Edge `catalog_sync` (Deno) y los tests
// (Vitest). Contrato del feed: README del scraper, "Feed para NinjaSoft POS".
// =============================================================================

/** Ítem de GET /api/feed/products. */
export interface FeedItem {
  key: string;
  ean: string | null;
  id_origen: string | null;
  oferta_principal?: boolean;
  vendedor?: string | null;
  titulo: string;
  descripcion?: string | null;
  atributos?: string | null;
  marca?: string | null;
  categoria?: string | null;
  precio: number | null;
  precio_lista: number | null;
  disponible: boolean;
  estado: string | null;
  foto: string | null;
  url_producto?: string | null;
  updated_at: string;
}

/** Ítem de GET /api/feed/stores. */
export interface FeedStore {
  id: string;
  label: string;
  logo: string | null;
  productCount: number;
  lastRunAt: string | null;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

/** Fila para catalog_sync_upsert_products (columnas de catalog_products). */
export interface CatalogRow {
  ean: string;
  titulo: string;
  precio: number | null;
  precio_lista: number | null;
  marca: string | null;
  categoria_path: string | null;
  foto_url: string | null;
  disponible: boolean;
  estado: string | null;
  id_origen: string | null;
  descripcion: string | null;
  atributos: { key: string; value: string }[] | null;
}

/** Estado por tienda dentro de catalog_sync_runs.stores. */
export interface StoreState {
  label: string;
  since: string | null;
  full: boolean;
  cursor: string | null;
  done: boolean;
  pages: number;
  nuevos: number;
  actualizados: number;
  faltantes: number;
  marcados: number;
  errores: number;
  error: string | null;
}

export type StoresState = Record<string, StoreState>;

/** Corrida previa (para calcular el `since` incremental). */
export interface PreviousRun {
  status: string;
  started_at: string;
  stores: Record<string, Partial<StoreState>> | null;
}

/** Tamaño de página pedido al feed (el feed acepta hasta 2000). */
export const FEED_PAGE_LIMIT = 1000;
/** Presupuesto de una invocación de la Edge. */
export const SLICE_BUDGET_MS = 100_000;
/** Margen para no arrancar una página que no llegue a guardarse. */
export const SLICE_RESERVE_MS = 15_000;
/** Lease de la corrida (> presupuesto + reserva). */
export const LEASE_SECONDS = 170;
/** Errores seguidos de una tienda antes de darla por terminada con error. */
export const MAX_STORE_ERRORS = 5;
/** Margen del `since` incremental contra diferencias de reloj POS/Railway. */
export const SINCE_MARGIN_MS = 60 * 60 * 1000;

const MAX_PRICE = 1e10; // numeric(12,2)

const cleanText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};

export function toPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n >= MAX_PRICE) return null;
  return Math.round(n * 100) / 100;
}

/** "Contenido: 500 g | Origen: AR" → [{key, value}] (formato de catalog_products.atributos). */
export function parseAtributos(raw: unknown): { key: string; value: string }[] | null {
  const text = cleanText(raw);
  if (!text) return null;
  const out: { key: string; value: string }[] = [];
  for (const part of text.split(" | ")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && value) out.push({ key, value });
  }
  return out.length ? out : null;
}

/**
 * Ítem del feed → fila de catalog_products, con la semántica de
 * scripts/import_catalog.cjs: sin EAN o sin título no hay producto; DISPONIBLE
 * "SI" → true (el feed ya lo manda booleano); CATEGORIA → categoria_path; la
 * foto es la mejor que manda el feed. Las publicaciones de otros vendedores del
 * mismo producto (oferta_principal = false) no entran: el maestro tiene una
 * fila por (tienda, EAN).
 */
export function mapFeedItem(item: FeedItem): CatalogRow | null {
  if (!item || item.oferta_principal === false) return null;
  const ean = cleanText(item.ean);
  const titulo = cleanText(item.titulo);
  if (!ean || !titulo) return null;
  return {
    ean,
    titulo,
    precio: toPrice(item.precio),
    precio_lista: toPrice(item.precio_lista),
    marca: cleanText(item.marca),
    categoria_path: cleanText(item.categoria),
    foto_url: cleanText(item.foto),
    disponible: item.disponible === true,
    estado: cleanText(item.estado),
    id_origen: cleanText(item.id_origen),
    descripcion: cleanText(item.descripcion),
    atributos: parseAtributos(item.atributos),
  };
}

const priceRank = (p: number | null) => (p && p > 0 ? p : Number.POSITIVE_INFINITY);

/** ¿`a` es mejor publicación que `b` para el mismo EAN? Disponible primero, después la más barata. */
export function isBetter(a: CatalogRow, b: CatalogRow): boolean {
  if (a.disponible !== b.disponible) return a.disponible;
  return priceRank(a.precio) < priceRank(b.precio);
}

/** Una fila por EAN dentro de una tanda (Postgres no deja tocar la misma fila dos veces en un upsert). */
export function dedupeByEan(rows: CatalogRow[]): CatalogRow[] {
  const best = new Map<string, CatalogRow>();
  for (const r of rows) {
    const cur = best.get(r.ean);
    if (!cur || isBetter(r, cur)) best.set(r.ean, r);
  }
  return [...best.values()];
}

export function mapFeedPage(items: FeedItem[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const it of items ?? []) {
    const r = mapFeedItem(it);
    if (r) rows.push(r);
  }
  return dedupeByEan(rows);
}

/**
 * `since` incremental de una tienda: inicio de la última corrida terminada en
 * la que esa tienda se leyó completa y sin error, menos un margen por reloj.
 * Sin corrida previa → null (lectura completa).
 */
export function storeSince(previous: PreviousRun[], key: string, marginMs = SINCE_MARGIN_MS): string | null {
  let best: number | null = null;
  for (const run of previous ?? []) {
    if (run.status !== "ok" && run.status !== "partial") continue;
    const st = run.stores?.[key];
    if (!st || st.done !== true || st.error) continue;
    const t = Date.parse(run.started_at);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best - marginMs).toISOString();
}

export function emptyStoreState(label: string, since: string | null): StoreState {
  return {
    label,
    since,
    full: since === null,
    cursor: null,
    done: false,
    pages: 0,
    nuevos: 0,
    actualizados: 0,
    faltantes: 0,
    marcados: 0,
    errores: 0,
    error: null,
  };
}

/** Estado inicial por tienda a partir del feed y las corridas anteriores. */
export function initStores(feedStores: FeedStore[], previous: PreviousRun[], forceFull = false): StoresState {
  const out: StoresState = {};
  const sorted = [...(feedStores ?? [])]
    .filter((s) => cleanText(s?.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const s of sorted) {
    const key = s.id.trim().toUpperCase();
    out[key] = emptyStoreState(cleanText(s.label) ?? key, forceFull ? null : storeSince(previous, key));
  }
  return out;
}

export function runMode(stores: StoresState): "full" | "incremental" | "mixed" | null {
  const vals = Object.values(stores);
  if (!vals.length) return null;
  const full = vals.filter((s) => s.full).length;
  if (full === vals.length) return "full";
  if (full === 0) return "incremental";
  return "mixed";
}

/** Próxima tienda pendiente (orden alfabético estable). */
export function nextPendingStore(stores: StoresState): string | null {
  for (const key of Object.keys(stores).sort()) {
    if (!stores[key]?.done) return key;
  }
  return null;
}

/** ¿Alcanza el tiempo para otra página? */
export function hasTime(startedMs: number, nowMs: number, budgetMs = SLICE_BUDGET_MS, reserveMs = SLICE_RESERVE_MS): boolean {
  return nowMs - startedMs < budgetMs - reserveMs;
}

export function feedProductsUrl(base: string, store: string, since: string | null, cursor: string | null, limit = FEED_PAGE_LIMIT): string {
  const u = new URL(`${base.replace(/\/+$/, "")}/api/feed/products`);
  u.searchParams.set("super", store);
  u.searchParams.set("limit", String(limit));
  if (since) u.searchParams.set("since", since);
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

export function feedStoresUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/api/feed/stores`;
}

export interface UpsertResult {
  nuevos: number;
  actualizados: number;
  faltantes: number;
}

/** Aplica una página procesada: suma contadores, avanza el cursor y resetea errores. */
export function applyPage(st: StoreState, page: FeedPage, result: UpsertResult): StoreState {
  return {
    ...st,
    pages: st.pages + 1,
    nuevos: st.nuevos + (result.nuevos || 0),
    actualizados: st.actualizados + (result.actualizados || 0),
    faltantes: st.faltantes + (result.faltantes || 0),
    cursor: page.nextCursor,
    errores: 0,
    error: null,
  };
}

/** Error en una tienda: se reintenta en la próxima invocación hasta MAX_STORE_ERRORS. */
export function applyError(st: StoreState, message: string, max = MAX_STORE_ERRORS): StoreState {
  const errores = st.errores + 1;
  return { ...st, errores, error: message.slice(0, 500), done: errores >= max };
}

export function totals(stores: StoresState) {
  const t = { nuevos: 0, actualizados: 0, faltantes: 0, errores: 0 };
  for (const s of Object.values(stores)) {
    t.nuevos += s.nuevos;
    t.actualizados += s.actualizados;
    t.faltantes += s.faltantes + s.marcados;
    t.errores += s.error ? 1 : 0;
  }
  return t;
}
