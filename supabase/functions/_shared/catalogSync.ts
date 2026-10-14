// =============================================================================
// Lógica pura de la sync del catálogo Tiendita desde el feed del scraper.
// ADR-107 (feed por tienda) → ADR-109 (catálogo maestro por EAN: un ítem por
// producto con la ficha fusionada y TODAS sus ofertas, GET /api/feed/catalog).
// Sin imports: la usan la Edge `catalog_sync` (Deno) y los tests (Vitest).
// Contrato del feed: README del scraper, "Catálogo maestro".
// =============================================================================

/** Oferta de un ítem de GET /api/feed/catalog. */
export interface FeedOffer {
  tienda: string;
  vendedor_id?: string | null;
  vendedor?: string | null;
  principal?: boolean;
  ean_origen?: string | null;
  id_origen?: string | null;
  precio: number | null;
  precio_lista?: number | null;
  disponible: boolean;
  estado?: string | null;
  url?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
}

/** Ítem de GET /api/feed/catalog (producto maestro). */
export interface FeedCatalogItem {
  key: string;
  ean: string | null;
  scope: string | null;
  /** Sin código de barras (ADR-118): código propio de la tienda (referencia/SKU). */
  codigo_tienda?: string | null;
  titulo: string;
  descripcion?: string | null;
  marca?: string | null;
  categoria?: string | null;
  atributos?: { key: string; value: string }[] | string | null;
  medidas?: Record<string, unknown> | null;
  foto?: string | null;
  fotos?: string[] | null;
  fuentes?: Record<string, unknown> | null;
  ofertas?: FeedOffer[] | null;
  updated_at?: string | null;
}

/** Ítem de GET /api/feed/stores. */
export interface FeedStore {
  id: string;
  label: string;
  logo: string | null;
  productCount: number;
  lastRunAt: string | null;
}

export interface FeedCatalogPage {
  items: FeedCatalogItem[];
  nextCursor: string | null;
}

/** Oferta para catalog_sync_upsert_catalog. */
export interface OfferRow {
  store_key: string;
  vendedor_key: string;
  vendedor: string | null;
  ean_origen: string | null;
  id_origen: string | null;
  precio: number | null;
  precio_lista: number | null;
  disponible: boolean;
  estado: string | null;
  url: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

/**
 * Producto maestro para catalog_sync_upsert_catalog (columnas de catalog_items + ofertas).
 * ADR-118: sin EAN → ean null, scope = la tienda y codigo_tienda = su código propio.
 */
export interface CatalogItemRow {
  ean: string | null;
  scope: string;
  codigo_tienda: string | null;
  titulo: string;
  descripcion: string | null;
  marca: string | null;
  categoria_path: string | null;
  atributos: { key: string; value: string }[] | null;
  medidas: Record<string, unknown> | null;
  foto_url: string | null;
  fotos: string[] | null;
  fuentes: Record<string, unknown> | null;
  feed_updated_at: string | null;
  ofertas: OfferRow[];
}

/** Estado de la lectura del feed maestro (catalog_sync_runs.feed). */
export interface FeedState {
  since: string | null;
  full: boolean;
  cursor: string | null;
  done: boolean;
  pages: number;
  recibidos: number;
  errores: number;
  error: string | null;
}

/** Resultado por tienda (catalog_sync_runs.stores): ofertas, no filas por tienda. */
export interface StoreState {
  label: string;
  nuevos: number;
  actualizados: number;
  faltantes: number;
  marcados: number;
  done: boolean;
  error: string | null;
  /** ADR-118: avance del cierre por lotes (última oferta procesada). */
  cursor?: CloseCursor | null;
  /** Publicaciones de tienda contadas hasta acá en el cierre. */
  contadas?: number;
  /** Lotes seguidos que fallaron (se reintenta hasta MAX_CLOSE_RETRIES). */
  intentos?: number;
}

/** Cursor del cierre de una tienda: keyset (item_id, vendedor_key) del índice único. */
export interface CloseCursor {
  item: number;
  vendor: string;
}

export type StoresState = Record<string, StoreState>;

/** Corrida previa (para calcular el `since` incremental). */
export interface PreviousRun {
  status: string;
  started_at: string;
  feed: Partial<FeedState> | null;
}

/** Resultado de catalog_sync_upsert_catalog. */
export interface UpsertResult {
  recibidos: number;
  nuevos: number;
  actualizados: number;
  ofertas: number;
  ofertas_nuevas: number;
  ofertas_actualizadas: number;
  faltantes: number;
  por_tienda: Record<string, { nuevas?: number; actualizadas?: number; faltantes?: number }>;
}

/**
 * Productos por llamada a catalog_sync_upsert_catalog. La RPC corre bajo el
 * statement_timeout de PostgREST (8 s); con el catálogo grande una página de
 * 250 fichas con sus ofertas lo superaba. Se guarda la página en lotes.
 */
export const UPSERT_CHUNK = 50;

/** ¿El error es un corte por statement_timeout (PostgREST 8 s)? */
export function isStatementTimeout(message: string | null | undefined): boolean {
  return /statement timeout|canceling statement/i.test(message ?? "");
}

/**
 * Guarda un lote resistiendo picos de lentitud: si se corta por tiempo, lo parte
 * en dos y guarda cada mitad; con lotes chicos reintenta con pausa. Sólo después
 * de eso el error sube (y cuenta como falla de la página).
 */
export async function upsertResilient<T>(
  rows: T[],
  save: (chunk: T[]) => Promise<{ data: UpsertResult | null; error: { message: string } | null }>,
  opts: { minChunk?: number; retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<UpsertResult> {
  const minChunk = opts.minChunk ?? 5;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const empty: UpsertResult = { recibidos: 0, nuevos: 0, actualizados: 0, ofertas: 0, ofertas_nuevas: 0, ofertas_actualizadas: 0, faltantes: 0, por_tienda: {} };
  if (!rows.length) return empty;
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await save(rows);
    if (!error) return mergeUpsertResults(empty, (data ?? empty) as UpsertResult);
    if (!isStatementTimeout(error.message)) throw new Error(`upsert: ${error.message}`);
    if (rows.length > minChunk) {
      const mid = Math.ceil(rows.length / 2);
      const a = await upsertResilient(rows.slice(0, mid), save, opts);
      const b = await upsertResilient(rows.slice(mid), save, opts);
      return mergeUpsertResults(a, b);
    }
    if (attempt >= retries) throw new Error(`upsert: ${error.message}`);
    await sleep(1000 * (attempt + 1));
  }
}

/** Suma los resultados de varios lotes de upsert. *//** Suma los resultados de varios lotes de upsert. */
export function mergeUpsertResults(a: UpsertResult, b: UpsertResult): UpsertResult {
  const por_tienda: UpsertResult["por_tienda"] = { ...a.por_tienda };
  for (const [k, r] of Object.entries(b.por_tienda ?? {})) {
    const prev = por_tienda[k] ?? {};
    por_tienda[k] = {
      nuevas: (prev.nuevas ?? 0) + (r.nuevas ?? 0),
      actualizadas: (prev.actualizadas ?? 0) + (r.actualizadas ?? 0),
      faltantes: (prev.faltantes ?? 0) + (r.faltantes ?? 0),
    };
  }
  return {
    recibidos: a.recibidos + (b.recibidos ?? 0),
    nuevos: a.nuevos + (b.nuevos ?? 0),
    actualizados: a.actualizados + (b.actualizados ?? 0),
    ofertas: a.ofertas + (b.ofertas ?? 0),
    ofertas_nuevas: a.ofertas_nuevas + (b.ofertas_nuevas ?? 0),
    ofertas_actualizadas: a.ofertas_actualizadas + (b.ofertas_actualizadas ?? 0),
    faltantes: a.faltantes + (b.faltantes ?? 0),
    por_tienda,
  };
}

/** Productos por página pedidos al feed (el feed acepta hasta 500). */
export const FEED_PAGE_LIMIT = 250;
/** Presupuesto de una invocación de la Edge. */
export const SLICE_BUDGET_MS = 100_000;
/** Margen para no arrancar una página que no llegue a guardarse. */
export const SLICE_RESERVE_MS = 15_000;
/** Lease de la corrida (> presupuesto + reserva). */
export const LEASE_SECONDS = 170;
/** Errores seguidos del feed antes de cerrar la lectura con error. */
export const MAX_FEED_ERRORS = 5;
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

/** "Contenido: 500 g | Origen: AR" o [{key, value}] → [{key, value}] limpio. */
export function parseAtributos(raw: unknown): { key: string; value: string }[] | null {
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  const push = (k: unknown, v: unknown) => {
    const key = cleanText(k);
    const value = cleanText(v);
    if (!key || !value) return;
    const nk = key.toLowerCase();
    if (seen.has(nk)) return;
    seen.add(nk);
    out.push({ key, value });
  };
  if (Array.isArray(raw)) {
    for (const a of raw) if (a && typeof a === "object") push((a as { key?: unknown }).key, (a as { value?: unknown }).value);
  } else {
    const text = cleanText(raw);
    if (!text) return null;
    for (const part of text.split(" | ")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      push(part.slice(0, idx), part.slice(idx + 1));
    }
  }
  return out.length ? out : null;
}

const isoOrNull = (v: unknown): string | null => {
  const t = cleanText(v);
  if (!t) return null;
  return Number.isFinite(Date.parse(t)) ? t : null;
};

export function mapOffer(o: FeedOffer): OfferRow | null {
  const store = cleanText(o?.tienda)?.toUpperCase();
  if (!store) return null;
  const vendedorKey = cleanText(o.vendedor_id) ?? "";
  return {
    store_key: store,
    vendedor_key: vendedorKey,
    // El nombre sólo importa para otros vendedores; la tienda ya tiene el suyo.
    vendedor: vendedorKey ? cleanText(o.vendedor) ?? vendedorKey : null,
    ean_origen: cleanText(o.ean_origen),
    id_origen: cleanText(o.id_origen),
    precio: toPrice(o.precio),
    precio_lista: toPrice(o.precio_lista),
    disponible: o.disponible === true,
    estado: cleanText(o.estado),
    url: cleanText(o.url),
    first_seen_at: isoOrNull(o.first_seen_at),
    last_seen_at: isoOrNull(o.last_seen_at),
  };
}

/**
 * Ítem del feed maestro → fila de catalog_items + ofertas. Sin título no hay
 * producto. scope null/"" = EAN global (la base vuelve a normalizar el código
 * con catalog_normalize_gtin). ADR-118: sin EAN entra como producto de la
 * tienda (scope) con su código propio (codigo_tienda); sin EAN y sin tienda o
 * sin código no se puede identificar y no entra.
 */
export function mapFeedCatalogItem(item: FeedCatalogItem): CatalogItemRow | null {
  if (!item) return null;
  const ean = cleanText(item.ean);
  const titulo = cleanText(item.titulo);
  const scope = cleanText(item.scope)?.toUpperCase() ?? "";
  const codigo = ean ? null : cleanText(item.codigo_tienda);
  if (!titulo) return null;
  if (!ean && (!scope || !codigo)) return null;
  const fotos = Array.isArray(item.fotos) ? [...new Set(item.fotos.map(cleanText).filter((f): f is string => Boolean(f)))] : [];
  const foto = cleanText(item.foto) ?? fotos[0] ?? null;
  const medidas = item.medidas && typeof item.medidas === "object" && Object.keys(item.medidas).length ? item.medidas : null;
  const ofertas: OfferRow[] = [];
  const seen = new Set<string>();
  for (const o of item.ofertas ?? []) {
    const row = mapOffer(o);
    if (!row) continue;
    const k = `${row.store_key}|${row.vendedor_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ofertas.push(row);
  }
  return {
    ean,
    scope,
    codigo_tienda: codigo,
    titulo: titulo.slice(0, 160),
    descripcion: cleanText(item.descripcion),
    marca: cleanText(item.marca),
    categoria_path: cleanText(item.categoria),
    atributos: parseAtributos(item.atributos),
    medidas,
    foto_url: foto,
    fotos: fotos.length ? fotos : foto ? [foto] : null,
    fuentes: item.fuentes && typeof item.fuentes === "object" ? item.fuentes : null,
    feed_updated_at: isoOrNull(item.updated_at),
    ofertas,
  };
}

/** Una fila por producto dentro de una página (Postgres no toca dos veces la misma fila en un upsert). */
export function mapCatalogPage(items: FeedCatalogItem[]): CatalogItemRow[] {
  const byKey = new Map<string, CatalogItemRow>();
  for (const it of items ?? []) {
    const r = mapFeedCatalogItem(it);
    // El último gana (el feed ordena por updated_at). Sin EAN: clave por código de la tienda.
    if (r) byKey.set(r.ean === null ? `${r.scope}|#${r.codigo_tienda}` : `${r.scope}|${r.ean}`, r);
  }
  return [...byKey.values()];
}

/**
 * `since` incremental: inicio de la última corrida terminada en la que el feed
 * maestro se leyó completo y sin error, menos un margen por reloj. Sin una así
 * (p. ej. la primera después de ADR-109) → null: lectura completa.
 */
export function feedSince(previous: PreviousRun[], marginMs = SINCE_MARGIN_MS): string | null {
  let best: number | null = null;
  for (const run of previous ?? []) {
    if (run.status !== "ok" && run.status !== "partial") continue;
    if (!run.feed || run.feed.done !== true || run.feed.error) continue;
    const t = Date.parse(run.started_at);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best - marginMs).toISOString();
}

export function initFeedState(previous: PreviousRun[], forceFull = false): FeedState {
  const since = forceFull ? null : feedSince(previous);
  return { since, full: since === null, cursor: null, done: false, pages: 0, recibidos: 0, errores: 0, error: null };
}

export function emptyStoreState(label: string): StoreState {
  return { label, nuevos: 0, actualizados: 0, faltantes: 0, marcados: 0, done: false, error: null };
}

/** Todas las tiendas del feed (ADR-109: se sincronizan todas, estén o no en un catálogo). */
export function initStores(feedStores: FeedStore[]): StoresState {
  const out: StoresState = {};
  const sorted = [...(feedStores ?? [])]
    .filter((s) => cleanText(s?.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const s of sorted) {
    const key = s.id.trim().toUpperCase();
    out[key] = emptyStoreState(cleanText(s.label) ?? key);
  }
  return out;
}

export function runMode(feed: FeedState | null): "full" | "incremental" | null {
  if (!feed) return null;
  return feed.full ? "full" : "incremental";
}

/** Próxima tienda a cerrar (faltantes + conteo), en orden alfabético estable. */
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

export function feedCatalogUrl(base: string, since: string | null, cursor: string | null, limit = FEED_PAGE_LIMIT): string {
  const u = new URL(`${base.replace(/\/+$/, "")}/api/feed/catalog`);
  u.searchParams.set("limit", String(limit));
  if (since) u.searchParams.set("since", since);
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

export function feedStoresUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/api/feed/stores`;
}

/** Totales de productos únicos y ofertas acumulados en la corrida. */
export interface RunTotals {
  nuevos: number;
  actualizados: number;
  ofertas_nuevas: number;
  ofertas_actualizadas: number;
}

/** Aplica una página: cursor, contadores por tienda y totales. */
export function applyPage(
  feed: FeedState,
  stores: StoresState,
  totalsIn: RunTotals,
  page: FeedCatalogPage,
  result: UpsertResult,
): { feed: FeedState; stores: StoresState; totals: RunTotals } {
  const nextStores: StoresState = { ...stores };
  for (const [key, r] of Object.entries(result?.por_tienda ?? {})) {
    const st = nextStores[key] ?? emptyStoreState(key);
    nextStores[key] = {
      ...st,
      nuevos: st.nuevos + Number(r.nuevas ?? 0),
      actualizados: st.actualizados + Number(r.actualizadas ?? 0),
      faltantes: st.faltantes + Number(r.faltantes ?? 0),
    };
  }
  return {
    feed: {
      ...feed,
      pages: feed.pages + 1,
      recibidos: feed.recibidos + Number(result?.recibidos ?? 0),
      cursor: page.nextCursor,
      done: !page.nextCursor,
      errores: 0,
      error: null,
    },
    stores: nextStores,
    totals: {
      nuevos: totalsIn.nuevos + Number(result?.nuevos ?? 0),
      actualizados: totalsIn.actualizados + Number(result?.actualizados ?? 0),
      ofertas_nuevas: totalsIn.ofertas_nuevas + Number(result?.ofertas_nuevas ?? 0),
      ofertas_actualizadas: totalsIn.ofertas_actualizadas + Number(result?.ofertas_actualizadas ?? 0),
    },
  };
}

/** Error del feed: se reintenta en la próxima invocación hasta MAX_FEED_ERRORS; después la lectura cierra con error. */
export function applyFeedError(feed: FeedState, message: string, max = MAX_FEED_ERRORS): FeedState {
  const errores = feed.errores + 1;
  return { ...feed, errores, error: message.slice(0, 500), done: errores >= max };
}

/** Faltantes por tienda (los que vinieron marcados + los que no vinieron en una completa). */
export function storeFaltantes(stores: StoresState): number {
  return Object.values(stores).reduce((a, s) => a + s.faltantes + s.marcados, 0);
}

/** Productos únicos vs ofertas: ahorro de filas de ficha por deduplicación. */
export function dedupeSavings(items: number, storeOffers: number): { saved: number; pct: number } {
  if (!storeOffers || storeOffers <= 0 || items < 0) return { saved: 0, pct: 0 };
  const saved = Math.max(storeOffers - items, 0);
  return { saved, pct: Math.round((saved / storeOffers) * 1000) / 10 };
}

// =============================================================================
// Cierre por lotes (ADR-118)
//
// Antes cada tienda se cerraba con UNA RPC (marcar faltantes + contar) y la
// corrida con otra (recuento de cada catálogo, dos veces, + aviso). Con ~600k
// ofertas el cierre final superaba el statement_timeout de PostgREST (8 s).
// Ahora:
//   1. Por tienda: catalog_sync_close_store_batch procesa CLOSE_BATCH_ROWS
//      ofertas por llamada (keyset sobre el índice único) y devuelve el cursor.
//   2. Por catálogo afectado: catalog_recount_step cuenta un rango de
//      productos por llamada (el avance queda en catalogs.recount).
//   3. catalog_sync_finalize: sólo aviso y estado (ya no cuenta nada).
// El avance se guarda en la corrida después de cada lote: si se acaba el
// presupuesto de la invocación, la próxima sigue desde ahí. Un lote que falla
// se reintenta hasta MAX_CLOSE_RETRIES veces seguidas; después esa tienda (o
// catálogo, o el cierre) queda con error y la corrida termina "partial".
// =============================================================================

/** Ofertas por lote del cierre de una tienda (< 2 s por lote con ~1,3 M de ofertas). */
export const CLOSE_BATCH_ROWS = 20_000;
/** Rango de ids de producto por lote del recuento de un catálogo. */
export const RECOUNT_BATCH_ITEMS = 50_000;
/** Fallos seguidos de un lote (o del cierre final) antes de darlo por perdido. */
export const MAX_CLOSE_RETRIES = 3;

/** Resultado de catalog_sync_close_store_batch. */
export interface CloseBatchResult {
  filas: number;
  contadas: number;
  marcados: number;
  last_item: number | null;
  last_vendor: string | null;
  done: boolean;
}

/** Resultado de catalog_recount_step. */
export interface RecountStepResult {
  done: boolean;
  product_count?: number | null;
}

/** Estado del cierre de la corrida (catalog_sync_runs.closing). */
export interface ClosingState {
  /** Catálogos a recontar (null = todavía no se armó la lista). */
  catalogs: string[] | null;
  recounted: string[];
  /** Catálogo en curso (el primer lote de cada uno reinicia su recuento). */
  current: string | null;
  intentos: number;
  errors: Record<string, string>;
  finalize_intentos: number;
}

export function emptyClosing(): ClosingState {
  return { catalogs: null, recounted: [], current: null, intentos: 0, errors: {}, finalize_intentos: 0 };
}

const errText = (prefix: string, message: string) => `${prefix}: ${message}`.slice(0, 500);

/** Aplica un lote del cierre de una tienda. */
export function applyCloseBatch(s: StoreState, r: CloseBatchResult): StoreState {
  const moved = Number(r?.filas ?? 0) > 0 && r.last_item != null;
  return {
    ...s,
    cursor: moved ? { item: Number(r.last_item), vendor: String(r.last_vendor ?? "") } : (s.cursor ?? null),
    contadas: (s.contadas ?? 0) + Number(r?.contadas ?? 0),
    marcados: (s.marcados ?? 0) + Number(r?.marcados ?? 0),
    done: Boolean(r?.done),
    intentos: 0,
    error: null,
  };
}

/** Un lote del cierre falló: se reintenta; a los MAX_CLOSE_RETRIES la tienda queda con error. */
export function applyCloseError(s: StoreState, message: string, max = MAX_CLOSE_RETRIES): StoreState {
  const intentos = (s.intentos ?? 0) + 1;
  const giveUp = intentos >= max;
  return { ...s, intentos, done: giveUp, error: giveUp ? errText("cierre", message) : (s.error ?? null) };
}

/** Próximo catálogo a recontar (ni terminado ni con error). */
export function nextRecount(c: ClosingState): string | null {
  for (const id of c.catalogs ?? []) {
    if (!c.recounted.includes(id) && !c.errors[id]) return id;
  }
  return null;
}

export function applyRecountStep(c: ClosingState, catalogId: string, r: RecountStepResult): ClosingState {
  if (r?.done) return { ...c, current: null, intentos: 0, recounted: [...c.recounted, catalogId] };
  return { ...c, current: catalogId, intentos: 0 };
}

export function applyRecountError(
  c: ClosingState,
  catalogId: string,
  message: string,
  max = MAX_CLOSE_RETRIES,
): ClosingState {
  const intentos = c.intentos + 1;
  // `current` no cambia: si falló el primer paso (el que reinicia), el
  // reintento vuelve a reiniciar; si falló uno intermedio, sigue desde el avance.
  if (intentos < max) return { ...c, intentos };
  return { ...c, current: null, intentos: 0, errors: { ...c.errors, [catalogId]: errText("recuento", message) } };
}

/** ¿El cierre dejó algo con error? (la corrida termina "partial"). */
export function closingHasErrors(stores: StoresState, c: ClosingState | null): boolean {
  return Object.values(stores).some((s) => s.error) || Object.keys(c?.errors ?? {}).length > 0;
}

export interface ClosingProgress {
  stores: StoresState;
  closing: ClosingState;
}

/** Llamadas que hace el cierre (la Edge las implementa con RPC; los tests, con dobles). */
export interface ClosingDeps {
  /** Tira si la corrida se pausó o canceló (corta la tanda sin tocar nada). */
  assertActive(): Promise<void>;
  closeStoreBatch(store: string, cursor: CloseCursor | null, counted: number): Promise<CloseBatchResult>;
  listCatalogs(storeKeys: string[]): Promise<string[]>;
  recountStep(catalogId: string, restart: boolean): Promise<RecountStepResult>;
  /** catalog_sync_finalize: aviso a los negocios y estado final (ok / partial). */
  finalize(): Promise<void>;
  /** El cierre final falló MAX_CLOSE_RETRIES veces: la corrida termina "partial" igual. */
  markPartial(message: string): Promise<void>;
  save(p: ClosingProgress, extra?: Record<string, unknown>): Promise<void>;
}

/**
 * Cierre de la corrida por lotes mientras quede presupuesto (`hasTime`).
 * Devuelve el avance y si la corrida terminó (OK, partial o con el cierre
 * final perdido). Si no terminó, la próxima invocación sigue desde `progress`.
 */
export async function runClosing(
  start: ClosingProgress,
  deps: ClosingDeps,
  hasTime: () => boolean,
): Promise<{ progress: ClosingProgress; finished: boolean }> {
  let p: ClosingProgress = { stores: { ...start.stores }, closing: start.closing ?? emptyClosing() };
  while (hasTime()) {
    await deps.assertActive();

    // 1) Tiendas: faltantes + conteo, un lote por vuelta.
    const key = nextPendingStore(p.stores);
    if (key) {
      const s = p.stores[key] ?? emptyStoreState(key);
      let next: StoreState;
      try {
        next = applyCloseBatch(s, await deps.closeStoreBatch(key, s.cursor ?? null, s.contadas ?? 0));
      } catch (e) {
        next = applyCloseError(s, e instanceof Error ? e.message : String(e));
      }
      p = { ...p, stores: { ...p.stores, [key]: next } };
      await deps.save(p, { current_store: key });
      continue;
    }

    // 2) Catálogos afectados: recuento por lotes.
    if (p.closing.catalogs === null) {
      const ids = await deps.listCatalogs(Object.keys(p.stores));
      p = { ...p, closing: { ...p.closing, catalogs: [...new Set(ids)].sort() } };
      await deps.save(p, { current_store: null });
      continue;
    }
    const cid = nextRecount(p.closing);
    if (cid) {
      try {
        const r = await deps.recountStep(cid, p.closing.current !== cid);
        p = { ...p, closing: applyRecountStep(p.closing, cid, r) };
      } catch (e) {
        p = { ...p, closing: applyRecountError(p.closing, cid, e instanceof Error ? e.message : String(e)) };
      }
      await deps.save(p);
      continue;
    }

    // 3) Aviso y estado final.
    try {
      await deps.finalize();
      return { progress: p, finished: true };
    } catch (e) {
      const msg = errText("cierre", e instanceof Error ? e.message : String(e));
      const intentos = p.closing.finalize_intentos + 1;
      p = { ...p, closing: { ...p.closing, finalize_intentos: intentos } };
      if (intentos >= MAX_CLOSE_RETRIES) {
        await deps.markPartial(msg);
        return { progress: p, finished: true };
      }
      await deps.save(p, { last_error: msg });
    }
  }
  return { progress: p, finished: false };
}
