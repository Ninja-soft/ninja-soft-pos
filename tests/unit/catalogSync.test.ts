// ADR-107 / ADR-109: sync del catálogo Tiendita desde el feed maestro del
// scraper (un ítem por producto con la ficha fusionada y todas sus ofertas).
// Mapeo feed → fila de catalog_items + catalog_offers, since incremental,
// cursor, errores, presupuesto de tiempo, conteos por tienda y panel.
import { describe, it, expect } from "vitest";
import {
  applyFeedError,
  applyPage,
  dedupeSavings,
  emptyStoreState,
  feedCatalogUrl,
  feedSince,
  hasTime,
  initFeedState,
  initStores,
  mapCatalogPage,
  mapFeedCatalogItem,
  mapOffer,
  MAX_FEED_ERRORS,
  nextPendingStore,
  parseAtributos,
  runMode,
  SINCE_MARGIN_MS,
  storeFaltantes,
  toPrice,
  type FeedCatalogItem,
  type UpsertResult,
} from "@/supabase/functions/_shared/catalogSync";
import { nextWeeklySync, parseDedupeStats, parseSyncRun, syncProgress } from "@/modules/internal/catalogSync";

const item = (extra: Partial<FeedCatalogItem> = {}): FeedCatalogItem => ({
  key: "7790070012050",
  ean: "7790070012050",
  scope: null,
  titulo: "  Aceite de Girasol Cocinero 900 ml ",
  descripcion: "Aceite refinado.",
  marca: "Cocinero",
  categoria: "Almacén > Aceites",
  atributos: [
    { key: "Origen", value: "Argentina" },
    { key: "origen", value: "AR" },
    { key: "", value: "x" },
  ],
  medidas: { contenido: { valor: 900, unidad: "ml" }, peso_kg: 0.92 },
  foto: null,
  fotos: ["https://fb/1.webp", "https://fb/1.webp", " "],
  fuentes: { titulo: "JUMBO" },
  ofertas: [
    { tienda: "jumbo", vendedor_id: "", vendedor: "Jumbo", precio: 1800, precio_lista: 1900, disponible: true, estado: "ACTIVO", url: "https://j/1" },
    { tienda: "BNA", vendedor_id: "55", vendedor: "Electro Sur", precio: "1500,5" as unknown as number, disponible: true },
    { tienda: "BNA", vendedor_id: "55", vendedor: "Repetida", precio: 1, disponible: true },
    { tienda: "", precio: 1, disponible: true },
  ],
  updated_at: "2026-10-11T00:00:00.000Z",
  ...extra,
});

describe("mapFeedCatalogItem: feed maestro → catalog_items + catalog_offers", () => {
  it("ficha limpia, fotos sin repetir, atributos sin claves repetidas", () => {
    const r = mapFeedCatalogItem(item())!;
    expect(r.ean).toBe("7790070012050");
    expect(r.scope).toBe("");
    expect(r.titulo).toBe("Aceite de Girasol Cocinero 900 ml");
    expect(r.categoria_path).toBe("Almacén > Aceites");
    expect(r.atributos).toEqual([{ key: "Origen", value: "Argentina" }]);
    expect(r.fotos).toEqual(["https://fb/1.webp"]);
    expect(r.foto_url).toBe("https://fb/1.webp");
    expect(r.medidas).toEqual({ contenido: { valor: 900, unidad: "ml" }, peso_kg: 0.92 });
    expect(r.feed_updated_at).toBe("2026-10-11T00:00:00.000Z");
  });

  it("ofertas: tienda en mayúsculas, una por (tienda, vendedor), sin tienda no entra", () => {
    const r = mapFeedCatalogItem(item())!;
    expect(r.ofertas.map((o) => [o.store_key, o.vendedor_key, o.vendedor, o.precio])).toEqual([
      ["JUMBO", "", null, 1800],
      ["BNA", "55", "Electro Sur", 1500.5],
    ]);
    expect(r.ofertas[0]!.url).toBe("https://j/1");
  });

  it("sin código o sin título no hay producto; código de tienda conserva el scope", () => {
    expect(mapFeedCatalogItem(item({ ean: "" }))).toBeNull();
    expect(mapFeedCatalogItem(item({ titulo: "  " }))).toBeNull();
    expect(mapFeedCatalogItem(item({ ean: "2900001000005", scope: "coto" }))!.scope).toBe("COTO");
  });

  it("atributos en texto del feed viejo y precios inválidos", () => {
    expect(parseAtributos("Contenido: 500 g | Origen: AR | sin dos puntos")).toEqual([
      { key: "Contenido", value: "500 g" },
      { key: "Origen", value: "AR" },
    ]);
    expect(parseAtributos(null)).toBeNull();
    expect(toPrice(-1)).toBeNull();
    expect(toPrice(1e11)).toBeNull();
    expect(toPrice("12,345")).toBe(12.35);
    expect(mapOffer({ tienda: "COTO", precio: null, disponible: false })!.precio).toBeNull();
  });

  it("una fila por producto en la página (gana la última)", () => {
    const rows = mapCatalogPage([item({ titulo: "A" }), item({ titulo: "B" }), item({ ean: "X", scope: "EASY" })]);
    expect(rows.map((r) => [r.ean, r.scope, r.titulo])).toEqual([
      ["7790070012050", "", "B"],
      ["X", "EASY", "Aceite de Girasol Cocinero 900 ml"],
    ]);
  });
});

describe("corrida: since, páginas, errores y cierre por tienda", () => {
  const prev = [
    { status: "ok", started_at: "2026-10-10T09:00:00Z", feed: { done: true, error: null } },
    { status: "ok", started_at: "2026-10-17T09:00:00Z", feed: { done: true, error: "feed caído" } },
    { status: "partial", started_at: "2026-10-03T09:00:00Z", feed: { done: true } },
    { status: "error", started_at: "2026-10-18T09:00:00Z", feed: { done: true } },
    // corrida de ADR-107 (sin feed maestro): no cuenta
    { status: "ok", started_at: "2026-10-24T09:00:00Z", feed: null },
  ];

  it("since = última lectura completa y sin error, menos el margen", () => {
    expect(feedSince(prev)).toBe(new Date(Date.parse("2026-10-10T09:00:00Z") - SINCE_MARGIN_MS).toISOString());
    expect(feedSince([])).toBeNull();
    const st = initFeedState(prev);
    expect(st.full).toBe(false);
    expect(initFeedState(prev, true)).toMatchObject({ since: null, full: true });
    expect(runMode(st)).toBe("incremental");
    expect(runMode(null)).toBeNull();
  });

  it("todas las tiendas del feed, en orden estable", () => {
    const stores = initStores([
      { id: "dia", label: "Día", logo: null, productCount: 1, lastRunAt: null },
      { id: "COTO", label: "", logo: null, productCount: 1, lastRunAt: null },
      { id: " ", label: "x", logo: null, productCount: 0, lastRunAt: null },
    ]);
    expect(Object.keys(stores)).toEqual(["COTO", "DIA"]);
    expect(stores.COTO!.label).toBe("COTO");
    expect(nextPendingStore(stores)).toBe("COTO");
    expect(nextPendingStore({ ...stores, COTO: { ...stores.COTO!, done: true } })).toBe("DIA");
  });

  it("applyPage suma por tienda y totales, y avanza el cursor", () => {
    const feed = initFeedState([]);
    const stores = initStores([{ id: "COTO", label: "Coto", logo: null, productCount: 0, lastRunAt: null }]);
    const result: UpsertResult = {
      recibidos: 3, nuevos: 2, actualizados: 1, ofertas: 5, ofertas_nuevas: 4, ofertas_actualizadas: 1, faltantes: 1,
      por_tienda: { COTO: { nuevas: 3, actualizadas: 1, faltantes: 1 }, BNA: { nuevas: 1 } },
    };
    const t0 = { nuevos: 0, actualizados: 0, ofertas_nuevas: 0, ofertas_actualizadas: 0 };
    const a = applyPage(feed, stores, t0, { items: [], nextCursor: "c1" }, result);
    expect(a.feed).toMatchObject({ cursor: "c1", done: false, pages: 1, recibidos: 3 });
    expect(a.stores.COTO).toMatchObject({ nuevos: 3, actualizados: 1, faltantes: 1 });
    expect(a.stores.BNA).toMatchObject({ label: "BNA", nuevos: 1 });
    expect(a.totals).toEqual({ nuevos: 2, actualizados: 1, ofertas_nuevas: 4, ofertas_actualizadas: 1 });
    const b = applyPage(a.feed, a.stores, a.totals, { items: [], nextCursor: null }, result);
    expect(b.feed.done).toBe(true);
    expect(storeFaltantes({ ...b.stores, COTO: { ...b.stores.COTO!, marcados: 4 } })).toBe(6);
  });

  it("errores del feed: reintenta y después cierra la lectura con error", () => {
    let st = initFeedState([]);
    for (let i = 1; i < MAX_FEED_ERRORS; i++) {
      st = applyFeedError(st, "feed respondió 503");
      expect(st.done).toBe(false);
    }
    st = applyFeedError(st, "feed respondió 503");
    expect(st).toMatchObject({ done: true, error: "feed respondió 503", errores: MAX_FEED_ERRORS });
    // Una página buena resetea los errores.
    const ok = applyPage({ ...st, done: false }, {}, { nuevos: 0, actualizados: 0, ofertas_nuevas: 0, ofertas_actualizadas: 0 }, { items: [], nextCursor: "x" }, {
      recibidos: 0, nuevos: 0, actualizados: 0, ofertas: 0, ofertas_nuevas: 0, ofertas_actualizadas: 0, faltantes: 0, por_tienda: {},
    });
    expect(ok.feed).toMatchObject({ errores: 0, error: null });
  });

  it("hasTime deja una reserva antes del presupuesto", () => {
    expect(hasTime(0, 50_000, 100_000, 15_000)).toBe(true);
    expect(hasTime(0, 85_000, 100_000, 15_000)).toBe(false);
  });

  it("URL del feed maestro con since y cursor", () => {
    const u = new URL(feedCatalogUrl("https://x.up.railway.app/", "2026-10-10T08:00:00.000Z", "abc"));
    expect(u.pathname).toBe("/api/feed/catalog");
    expect(u.searchParams.get("since")).toBe("2026-10-10T08:00:00.000Z");
    expect(u.searchParams.get("cursor")).toBe("abc");
    expect(u.searchParams.get("limit")).toBe("250");
    expect(new URL(feedCatalogUrl("https://x", null, null)).searchParams.has("since")).toBe(false);
  });

  it("ahorro por deduplicación", () => {
    expect(dedupeSavings(285_356, 350_848)).toEqual({ saved: 65_492, pct: 18.7 });
    expect(dedupeSavings(10, 0)).toEqual({ saved: 0, pct: 0 });
    expect(emptyStoreState("X").done).toBe(false);
  });
});

describe("panel: próxima sync, progreso y estadísticas", () => {
  it("próxima: sábado 06:00 AR (09:00 UTC)", () => {
    expect(nextWeeklySync(new Date("2026-10-13T15:00:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
    expect(nextWeeklySync(new Date("2026-10-17T08:00:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
    expect(nextWeeklySync(new Date("2026-10-17T09:00:00Z")).toISOString()).toBe("2026-10-24T09:00:00.000Z");
    expect(nextWeeklySync(new Date("2026-10-17T02:30:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  it("parseSyncRun y progreso: lectura del feed y después cierre por tienda", () => {
    const base = {
      id: "r1",
      trigger: "cron",
      status: "running",
      mode: "full",
      nuevos: 10,
      ofertas_nuevas: 25,
      stores: {
        DIA: { label: "Día", done: false, nuevos: 1, faltantes: 1, marcados: 2 },
        COTO: { label: "Coto", done: true },
      },
      started_at: "2026-10-17T09:00:00Z",
    };
    const reading = parseSyncRun({ ...base, feed: { full: true, done: false, pages: 200, recibidos: 50_000 } });
    expect(reading.stores.map((s) => s.key)).toEqual(["COTO", "DIA"]);
    expect(reading.stores[1]!.faltantes).toBe(3);
    expect(reading.ofertasNuevas).toBe(25);
    expect(reading.feed).toMatchObject({ pages: 200, recibidos: 50_000 });
    const p1 = syncProgress(reading);
    expect(p1.phase).toBe("feed");
    expect(p1.pct).toBeGreaterThan(0);
    expect(p1.pct).toBeLessThan(80);
    const closing = parseSyncRun({ ...base, feed: { done: true, pages: 400 } });
    expect(syncProgress(closing)).toEqual({ phase: "stores", done: 1, total: 2, pct: 90 });
    expect(syncProgress(parseSyncRun({ ...base, feed: null })).phase).toBe("feed");
  });

  it("estadísticas de deduplicación", () => {
    const s = parseDedupeStats({
      items: 285_356,
      items_globales: 246_926,
      items_por_tienda: 38_430,
      ofertas: 360_000,
      ofertas_tienda: 350_848,
      ofertas_vendedores: 9_152,
      tiendas: [{ key: "COTO", name: "Coto", ofertas_tienda: 57_907, en_catalogo: true }],
    });
    expect(s.ahorro).toBe(65_492);
    expect(s.ahorroPct).toBe(18.7);
    expect(s.tiendas[0]).toMatchObject({ key: "COTO", ofertasTienda: 57_907, enCatalogo: true, ofertasVendedores: 0 });
    expect(parseDedupeStats(null)).toMatchObject({ items: 0, ahorroPct: 0, tiendas: [] });
  });
});
