// ADR-106: sync del catálogo Tiendita desde el feed del scraper. Mapeo
// feed → fila de catalog_products (misma semántica que import_catalog.cjs),
// cursor por tienda, since incremental y presupuesto de tiempo.
import { describe, it, expect } from "vitest";
import {
  applyError,
  applyPage,
  dedupeByEan,
  emptyStoreState,
  feedProductsUrl,
  hasTime,
  initStores,
  mapFeedItem,
  mapFeedPage,
  MAX_STORE_ERRORS,
  nextPendingStore,
  parseAtributos,
  runMode,
  SINCE_MARGIN_MS,
  storeSince,
  toPrice,
  totals,
  type FeedItem,
  type PreviousRun,
  type StoreState,
} from "@/supabase/functions/_shared/catalogSync";
import { nextWeeklySync, parseSyncRun, syncProgress } from "@/modules/internal/catalogSync";

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  key: "k1",
  ean: "7790001",
  id_origen: "p1",
  oferta_principal: true,
  vendedor: null,
  titulo: "Yerba 1 kg",
  descripcion: "Yerba mate",
  atributos: "Contenido: 1 kg | Origen: Misiones",
  marca: "Marca",
  categoria: "Almacén > Infusiones",
  precio: 3500,
  precio_lista: 4000,
  disponible: true,
  estado: "ACTIVO",
  foto: "https://fb/7790001.webp",
  url_producto: "https://tienda/p1",
  updated_at: "2026-10-10T10:00:00.000Z",
  ...over,
});

describe("mapFeedItem: feed → catalog_products", () => {
  it("mapea con la semántica del import por Excel", () => {
    expect(mapFeedItem(item())).toEqual({
      ean: "7790001",
      titulo: "Yerba 1 kg",
      precio: 3500,
      precio_lista: 4000,
      marca: "Marca",
      categoria_path: "Almacén > Infusiones",
      foto_url: "https://fb/7790001.webp",
      disponible: true,
      estado: "ACTIVO",
      id_origen: "p1",
      descripcion: "Yerba mate",
      atributos: [
        { key: "Contenido", value: "1 kg" },
        { key: "Origen", value: "Misiones" },
      ],
    });
  });

  it("sin EAN o sin título no hay producto; otros vendedores tampoco", () => {
    expect(mapFeedItem(item({ ean: null }))).toBeNull();
    expect(mapFeedItem(item({ ean: "  " }))).toBeNull();
    expect(mapFeedItem(item({ titulo: "" }))).toBeNull();
    expect(mapFeedItem(item({ oferta_principal: false }))).toBeNull();
    // un feed viejo sin el campo se toma como principal
    expect(mapFeedItem(item({ oferta_principal: undefined }))).not.toBeNull();
  });

  it("faltante: no disponible y vacíos a null", () => {
    const r = mapFeedItem(
      item({ disponible: false, estado: "FALTANTE_EN_ULTIMA_CORRIDA", marca: "", foto: null, atributos: null }),
    )!;
    expect(r.disponible).toBe(false);
    expect(r.estado).toBe("FALTANTE_EN_ULTIMA_CORRIDA");
    expect(r.marca).toBeNull();
    expect(r.foto_url).toBeNull();
    expect(r.atributos).toBeNull();
  });

  it("precios: null si no es número, negativo o no entra en numeric(12,2)", () => {
    expect(toPrice(null)).toBeNull();
    expect(toPrice("")).toBeNull();
    expect(toPrice("12,5")).toBe(12.5);
    expect(toPrice(-1)).toBeNull();
    expect(toPrice(1e10)).toBeNull();
    expect(toPrice(10.555)).toBe(10.56);
  });

  it("atributos: pares clave: valor, ignora basura", () => {
    expect(parseAtributos("A: 1 | sin separador | B: x: y")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x: y" },
    ]);
    expect(parseAtributos("")).toBeNull();
  });

  it("una fila por EAN en la tanda: gana la disponible y después la más barata", () => {
    const rows = mapFeedPage([
      item({ key: "a", id_origen: "a", disponible: false, precio: 10 }),
      item({ key: "b", id_origen: "b", disponible: true, precio: 300 }),
      item({ key: "c", id_origen: "c", disponible: true, precio: 200 }),
      item({ key: "d", ean: "otro" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ean === "7790001")!.id_origen).toBe("c");
    // precio 0 cuenta como sin precio
    const d = dedupeByEan([mapFeedItem(item({ precio: 0, id_origen: "x" }))!, mapFeedItem(item({ precio: 50, id_origen: "y" }))!]);
    expect(d[0]!.id_origen).toBe("y");
  });
});

describe("since incremental por tienda", () => {
  const prev: PreviousRun[] = [
    { status: "ok", started_at: "2026-10-03T09:00:00.000Z", stores: { COTO: { done: true, error: null }, DIA: { done: true, error: null } } },
    { status: "partial", started_at: "2026-10-10T09:00:00.000Z", stores: { COTO: { done: true, error: null }, DIA: { done: true, error: "feed 500" } } },
    { status: "error", started_at: "2026-10-11T09:00:00.000Z", stores: { COTO: { done: true, error: null } } },
    { status: "running", started_at: "2026-10-12T09:00:00.000Z", stores: { COTO: { done: true, error: null } } },
  ];

  it("toma el inicio de la última corrida OK de ESA tienda, con margen", () => {
    const coto = Date.parse("2026-10-10T09:00:00.000Z") - SINCE_MARGIN_MS;
    expect(storeSince(prev, "COTO")).toBe(new Date(coto).toISOString());
    const dia = Date.parse("2026-10-03T09:00:00.000Z") - SINCE_MARGIN_MS;
    expect(storeSince(prev, "DIA")).toBe(new Date(dia).toISOString());
  });

  it("tienda nueva o primera corrida: completa", () => {
    expect(storeSince(prev, "MEGATONE")).toBeNull();
    expect(storeSince([], "COTO")).toBeNull();
  });

  it("initStores: claves en mayúscula, orden estable y forceFull", () => {
    const feed = [
      { id: "dia", label: "Día", logo: null, productCount: 1, lastRunAt: null },
      { id: "COTO", label: "Coto", logo: null, productCount: 1, lastRunAt: null },
      { id: "MEGATONE", label: "", logo: null, productCount: 0, lastRunAt: null },
    ];
    const st = initStores(feed, prev);
    expect(Object.keys(st)).toEqual(["COTO", "DIA", "MEGATONE"]);
    expect(st.COTO!.full).toBe(false);
    expect(st.MEGATONE!.full).toBe(true);
    expect(st.MEGATONE!.label).toBe("MEGATONE");
    expect(runMode(st)).toBe("mixed");
    const all = initStores(feed, prev, true);
    expect(Object.values(all).every((s) => s.full && s.since === null)).toBe(true);
    expect(runMode(all)).toBe("full");
  });
});

describe("cursor y presupuesto de tiempo", () => {
  it("avanza el cursor por página y termina la tienda sin nextCursor", () => {
    let st = emptyStoreState("Coto", null);
    st = applyPage(st, { items: [], nextCursor: "c1" }, { nuevos: 10, actualizados: 2, faltantes: 1 });
    expect(st.cursor).toBe("c1");
    st = applyPage(st, { items: [], nextCursor: null }, { nuevos: 1, actualizados: 0, faltantes: 0 });
    expect(st).toMatchObject({ cursor: null, pages: 2, nuevos: 11, actualizados: 2, faltantes: 1 });
  });

  it("un error conserva el cursor y se reintenta; tras el máximo la tienda termina con error", () => {
    let st: StoreState = { ...emptyStoreState("Coto", null), cursor: "c5" };
    st = applyError(st, "feed respondió 502");
    expect(st).toMatchObject({ cursor: "c5", done: false, errores: 1, error: "feed respondió 502" });
    // una página buena limpia el error
    expect(applyPage(st, { items: [], nextCursor: "c6" }, { nuevos: 0, actualizados: 0, faltantes: 0 }).error).toBeNull();
    for (let i = 1; i < MAX_STORE_ERRORS; i++) st = applyError(st, "x");
    expect(st.done).toBe(true);
  });

  it("nextPendingStore recorre en orden y termina en null", () => {
    const stores = { DIA: emptyStoreState("Día", null), COTO: { ...emptyStoreState("Coto", null), done: true } };
    expect(nextPendingStore(stores)).toBe("DIA");
    expect(nextPendingStore({ ...stores, DIA: { ...stores.DIA, done: true } })).toBeNull();
  });

  it("hasTime deja una reserva antes del presupuesto", () => {
    expect(hasTime(0, 50_000, 100_000, 15_000)).toBe(true);
    expect(hasTime(0, 85_000, 100_000, 15_000)).toBe(false);
  });

  it("URL del feed con since y cursor", () => {
    const u = new URL(feedProductsUrl("https://x.up.railway.app/", "COTO", "2026-10-10T08:00:00.000Z", "abc"));
    expect(u.pathname).toBe("/api/feed/products");
    expect(u.searchParams.get("super")).toBe("COTO");
    expect(u.searchParams.get("since")).toBe("2026-10-10T08:00:00.000Z");
    expect(u.searchParams.get("cursor")).toBe("abc");
    expect(u.searchParams.get("limit")).toBe("1000");
    expect(new URL(feedProductsUrl("https://x", "DIA", null, null)).searchParams.has("since")).toBe(false);
  });

  it("totales: faltantes suma los del feed y los marcados", () => {
    const t = totals({
      A: { ...emptyStoreState("A", null), nuevos: 2, faltantes: 1, marcados: 3 },
      B: { ...emptyStoreState("B", null), actualizados: 5, error: "x" },
    });
    expect(t).toEqual({ nuevos: 2, actualizados: 5, faltantes: 4, errores: 1 });
  });
});

describe("panel: próxima sync y progreso", () => {
  it("próxima: sábado 06:00 AR (09:00 UTC)", () => {
    // martes 13/10/2026 12:00 AR
    expect(nextWeeklySync(new Date("2026-10-13T15:00:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
    // sábado antes de las 6 AR: ese mismo día
    expect(nextWeeklySync(new Date("2026-10-17T08:00:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
    // sábado después de las 6 AR: el siguiente
    expect(nextWeeklySync(new Date("2026-10-17T09:00:00Z")).toISOString()).toBe("2026-10-24T09:00:00.000Z");
    // viernes 23:30 AR (ya sábado en UTC): mañana
    expect(nextWeeklySync(new Date("2026-10-17T02:30:00Z")).toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  it("parseSyncRun y progreso por tiendas", () => {
    const run = parseSyncRun({
      id: "r1",
      trigger: "cron",
      status: "running",
      mode: "incremental",
      stores: {
        DIA: { label: "Día", done: false, nuevos: 1, faltantes: 1, marcados: 2 },
        COTO: { label: "Coto", done: true, full: true },
      },
      started_at: "2026-10-17T09:00:00Z",
    });
    expect(run.stores.map((s) => s.key)).toEqual(["COTO", "DIA"]);
    expect(run.stores[1]!.faltantes).toBe(3);
    expect(syncProgress(run)).toEqual({ done: 1, total: 2, pct: 50 });
  });
});
