// ADR-118: productos sin EAN por tienda y cierre de la corrida por lotes.
// Mapeo de ítems de tienda (ean null + codigo_tienda), loop de cierre con
// presupuesto de tiempo y reintentos, estado partial; medidas y GTIN del
// diálogo de import.
import { describe, it, expect, vi } from "vitest";
import {
  applyCloseBatch,
  applyCloseError,
  closingHasErrors,
  emptyClosing,
  emptyStoreState,
  mapCatalogPage,
  mapFeedCatalogItem,
  MAX_CLOSE_RETRIES,
  runClosing,
  type CloseBatchResult,
  type ClosingDeps,
  type ClosingProgress,
  type FeedCatalogItem,
  type StoresState,
} from "@/supabase/functions/_shared/catalogSync";
import { isValidGtin, measureLines } from "@/lib/catalog/importInfo";

const sinEan = (over: Partial<FeedCatalogItem> = {}): FeedCatalogItem => ({
  key: "MEGATONE:ID:M1",
  ean: null,
  scope: "MEGATONE",
  codigo_tienda: "M1",
  titulo: "Heladera No Frost Gafa 300 L",
  fotos: ["https://x/m1.jpg"],
  ofertas: [
    { tienda: "MEGATONE", vendedor_id: "", precio: 900000, disponible: true },
    { tienda: "MEGATONE", vendedor_id: "77", vendedor: "Otro", precio: 850000, disponible: true },
  ],
  ...over,
});

describe("mapFeedCatalogItem: productos sin EAN (ADR-118)", () => {
  it("entra como producto de la tienda con su código, sin EAN", () => {
    const r = mapFeedCatalogItem(sinEan())!;
    expect(r.ean).toBeNull();
    expect(r.scope).toBe("MEGATONE");
    expect(r.codigo_tienda).toBe("M1");
    expect(r.ofertas.map((o) => [o.store_key, o.vendedor_key, o.ean_origen])).toEqual([
      ["MEGATONE", "", null],
      ["MEGATONE", "77", null],
    ]);
  });

  it("sin tienda o sin código no se puede identificar", () => {
    expect(mapFeedCatalogItem(sinEan({ scope: null }))).toBeNull();
    expect(mapFeedCatalogItem(sinEan({ codigo_tienda: "  " }))).toBeNull();
    expect(mapFeedCatalogItem(sinEan({ codigo_tienda: undefined }))).toBeNull();
  });

  it("con EAN el código de la tienda se ignora", () => {
    const r = mapFeedCatalogItem(sinEan({ ean: "7790070012050", scope: null, codigo_tienda: "X" }))!;
    expect(r.ean).toBe("7790070012050");
    expect(r.codigo_tienda).toBeNull();
  });

  it("dedupe por página: por código de la tienda, sin chocar con un EAN igual al código", () => {
    const rows = mapCatalogPage([
      sinEan({ titulo: "Viejo" }),
      sinEan({ titulo: "Nuevo" }),
      sinEan({ codigo_tienda: "M2" }),
      sinEan({ ean: "M1", scope: "MEGATONE", codigo_tienda: null }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.codigo_tienda === "M1")!.titulo).toBe("Nuevo");
  });
});

// ---------------------------------------------------------------------------
// Cierre por lotes
// ---------------------------------------------------------------------------
const batch = (over: Partial<CloseBatchResult> = {}): CloseBatchResult => ({
  filas: 20000,
  contadas: 20000,
  marcados: 0,
  last_item: 1,
  last_vendor: "",
  done: false,
  ...over,
});

function fakeDeps(opts: {
  storeRows: Record<string, number>;
  catalogs?: string[];
  recountSteps?: number;
  failStore?: { store: string; times: number };
  failRecount?: { id: string; times: number };
  failFinalize?: number;
  batchRows?: number;
}) {
  const size = opts.batchRows ?? 1000;
  const calls: string[] = [];
  const failsLeft = { store: opts.failStore?.times ?? 0, recount: opts.failRecount?.times ?? 0, fin: opts.failFinalize ?? 0 };
  const recount = new Map<string, number>();
  const saved: ClosingProgress[] = [];
  const deps: ClosingDeps = {
    assertActive: vi.fn(async () => {}),
    closeStoreBatch: vi.fn(async (store, cursor, counted) => {
      calls.push(`close:${store}`);
      if (opts.failStore?.store === store && failsLeft.store > 0) {
        failsLeft.store--;
        throw new Error("canceling statement due to statement timeout");
      }
      const from = cursor?.item ?? 0;
      const total = opts.storeRows[store] ?? 0;
      const n = Math.max(0, Math.min(size, total - from));
      return batch({ filas: n, contadas: n, marcados: n ? 1 : 0, last_item: n ? from + n : null, done: n < size, ...(counted < 0 ? {} : {}) });
    }),
    listCatalogs: vi.fn(async () => opts.catalogs ?? []),
    recountStep: vi.fn(async (id, restart) => {
      calls.push(`recount:${id}:${restart}`);
      if (opts.failRecount?.id === id && failsLeft.recount > 0) {
        failsLeft.recount--;
        throw new Error("timeout");
      }
      const step = (restart ? 0 : (recount.get(id) ?? 0)) + 1;
      recount.set(id, step);
      return { done: step >= (opts.recountSteps ?? 2), product_count: step * 10 };
    }),
    finalize: vi.fn(async () => {
      calls.push("finalize");
      if (failsLeft.fin > 0) {
        failsLeft.fin--;
        throw new Error("timeout");
      }
    }),
    markPartial: vi.fn(async () => {}),
    save: vi.fn(async (p) => {
      saved.push(p);
    }),
  };
  return { deps, calls, saved };
}

const stores = (...keys: string[]): StoresState => Object.fromEntries(keys.map((k) => [k, emptyStoreState(k)]));
const always = () => true;

describe("runClosing: cierre por lotes con presupuesto", () => {
  it("cierra cada tienda en lotes, recuenta cada catálogo y finaliza", async () => {
    const { deps, calls } = fakeDeps({ storeRows: { BNA: 2500, COTO: 999 }, catalogs: ["c2", "c1", "c1"], recountSteps: 2 });
    const out = await runClosing({ stores: stores("COTO", "BNA"), closing: emptyClosing() }, deps, always);
    expect(out.finished).toBe(true);
    expect(calls).toEqual([
      "close:BNA", "close:BNA", "close:BNA", "close:COTO",
      "recount:c1:true", "recount:c1:false", "recount:c2:true", "recount:c2:false",
      "finalize",
    ]);
    expect(out.progress.stores.BNA).toMatchObject({ done: true, contadas: 2500, marcados: 3, cursor: { item: 2500, vendor: "" } });
    expect(out.progress.closing.recounted).toEqual(["c1", "c2"]);
    expect(deps.markPartial).not.toHaveBeenCalled();
  });

  it("sin presupuesto corta y la próxima invocación sigue desde el cursor guardado", async () => {
    const { deps } = fakeDeps({ storeRows: { JUMBO: 5000 }, catalogs: ["c1"] });
    let budget = 2;
    const first = await runClosing({ stores: stores("JUMBO"), closing: emptyClosing() }, deps, () => budget-- > 0);
    expect(first.finished).toBe(false);
    expect(first.progress.stores.JUMBO).toMatchObject({ done: false, contadas: 2000, cursor: { item: 2000, vendor: "" } });
    const second = await runClosing(first.progress, deps, always);
    expect(second.finished).toBe(true);
    expect(second.progress.stores.JUMBO!.contadas).toBe(5000);
    expect(vi.mocked(deps.closeStoreBatch).mock.calls[2]![1]).toEqual({ item: 2000, vendor: "" });
    expect(vi.mocked(deps.closeStoreBatch).mock.calls[2]![2]).toBe(2000);
  });

  it("un lote que falla se reintenta y sigue desde el mismo cursor", async () => {
    const { deps } = fakeDeps({ storeRows: { BNA: 1500 }, failStore: { store: "BNA", times: MAX_CLOSE_RETRIES - 1 } });
    const out = await runClosing({ stores: stores("BNA"), closing: emptyClosing() }, deps, always);
    expect(out.progress.stores.BNA).toMatchObject({ done: true, error: null, contadas: 1500, intentos: 0 });
    expect(closingHasErrors(out.progress.stores, out.progress.closing)).toBe(false);
  });

  it("tras los reintentos la tienda queda con error (la corrida será partial) y el resto sigue", async () => {
    const { deps, calls } = fakeDeps({ storeRows: { BNA: 1500, COTO: 10 }, failStore: { store: "BNA", times: 99 }, catalogs: ["c1"] });
    const out = await runClosing({ stores: stores("BNA", "COTO"), closing: emptyClosing() }, deps, always);
    expect(out.finished).toBe(true);
    expect(out.progress.stores.BNA!.error).toMatch(/^cierre: canceling statement/);
    expect(out.progress.stores.COTO!.done).toBe(true);
    expect(calls.filter((c) => c === "close:BNA")).toHaveLength(MAX_CLOSE_RETRIES);
    expect(closingHasErrors(out.progress.stores, out.progress.closing)).toBe(true);
  });

  it("un recuento que falla se reintenta (el primer paso vuelve a reiniciar); si sigue fallando queda en closing.errors", async () => {
    const ok = fakeDeps({ storeRows: {}, catalogs: ["c1"], recountSteps: 2, failRecount: { id: "c1", times: 1 } });
    const r1 = await runClosing({ stores: {}, closing: emptyClosing() }, ok.deps, always);
    expect(ok.calls).toEqual(["recount:c1:true", "recount:c1:true", "recount:c1:false", "finalize"]);
    expect(r1.progress.closing.errors).toEqual({});

    const bad = fakeDeps({ storeRows: {}, catalogs: ["c1", "c2"], failRecount: { id: "c1", times: 99 } });
    const r2 = await runClosing({ stores: {}, closing: emptyClosing() }, bad.deps, always);
    expect(r2.finished).toBe(true);
    expect(r2.progress.closing.errors.c1).toMatch(/^recuento: timeout/);
    expect(r2.progress.closing.recounted).toEqual(["c2"]);
    expect(closingHasErrors({}, r2.progress.closing)).toBe(true);
  });

  it("el cierre final se reintenta; si falla las 3 veces la corrida termina partial (no ok)", async () => {
    const retry = fakeDeps({ storeRows: {}, catalogs: [], failFinalize: 2 });
    const a = await runClosing({ stores: {}, closing: emptyClosing() }, retry.deps, always);
    expect(a.finished).toBe(true);
    expect(retry.deps.markPartial).not.toHaveBeenCalled();
    expect(a.progress.closing.finalize_intentos).toBe(2);

    const dead = fakeDeps({ storeRows: {}, catalogs: [], failFinalize: 99 });
    const b = await runClosing({ stores: {}, closing: emptyClosing() }, dead.deps, always);
    expect(b.finished).toBe(true);
    expect(dead.deps.markPartial).toHaveBeenCalledWith("cierre: timeout");
    expect(dead.calls.filter((c) => c === "finalize")).toHaveLength(MAX_CLOSE_RETRIES);
  });

  it("pausada o cancelada: corta sin tocar nada más", async () => {
    const { deps } = fakeDeps({ storeRows: { BNA: 10 } });
    deps.assertActive = vi.fn(async () => {
      throw new Error("cancelled");
    });
    await expect(runClosing({ stores: stores("BNA"), closing: emptyClosing() }, deps, always)).rejects.toThrow("cancelled");
    expect(deps.closeStoreBatch).not.toHaveBeenCalled();
  });

  it("applyCloseBatch / applyCloseError", () => {
    const s = applyCloseBatch(emptyStoreState("Coto"), batch({ filas: 0, contadas: 0, last_item: null, done: true }));
    expect(s).toMatchObject({ done: true, cursor: null, contadas: 0 });
    let e = applyCloseError(emptyStoreState("Coto"), "x");
    expect(e).toMatchObject({ done: false, error: null, intentos: 1 });
    e = applyCloseError(applyCloseError(e, "x"), "boom");
    expect(e).toMatchObject({ done: true, error: "cierre: boom", intentos: 3 });
  });
});

describe("importInfo: medidas y GTIN para el diálogo de import", () => {
  it("medidas legibles en orden fijo", () => {
    expect(
      measureLines({ peso_kg: 55, alto_cm: 170, ancho_cm: 60, profundidad_cm: 65, contenido: { valor: 1500, unidad: "ml" }, unidades_pack: 1 }),
    ).toEqual([
      { key: "peso", label: "Peso", value: "55 kg" },
      { key: "volumen", label: "Volumen", value: "1,5 l" },
      { key: "dimensiones", label: "Dimensiones", value: "170 × 60 × 65 cm" },
    ]);
    expect(measureLines({ contenido: { valor: 500, unidad: "g" }, unidades_pack: 6, alto_cm: 10 })).toEqual([
      { key: "contenido", label: "Contenido", value: "500 g" },
      { key: "dimensiones", label: "Dimensiones", value: "10 × – × – cm" },
      { key: "pack", label: "Unidades por pack", value: "6" },
    ]);
    expect(measureLines(null)).toEqual([]);
    expect(measureLines({})).toEqual([]);
  });

  it("GTIN válido (con separadores) y dígito verificador", () => {
    expect(isValidGtin("7790070012050")).toBe(true);
    expect(isValidGtin("779-0070-012050")).toBe(true);
    expect(isValidGtin("041331014915")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("7790070012051")).toBe(false);
    expect(isValidGtin("M-4455")).toBe(false);
    expect(isValidGtin("")).toBe(false);
  });
});
