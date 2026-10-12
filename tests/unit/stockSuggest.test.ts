import { describe, expect, it } from "vitest";
import {
  groupSuggestions,
  parseStockKey,
  stockKey,
  suggestTransfers,
  type StockCell,
} from "@/lib/stock/suggest";
import {
  storeStockLines,
  storeStockTone,
  totalsByStore,
  type StoreStockRow,
} from "@/lib/stock/byStore";

const cell = (
  storeId: string,
  qty: number,
  min: number,
  max: number | null = null,
  inTransitIn = 0,
  key = "p:",
): StockCell => ({
  key,
  storeId,
  qty,
  min,
  max,
  inTransitIn,
});

describe("sugerencia de traslados", () => {
  it("repone hasta el máximo desde la sucursal con sobrante", () => {
    const s = suggestTransfers([
      cell("centro", 30, 5),
      cell("norte", 2, 5, 12),
    ]);
    expect(s).toEqual([
      { key: "p:", fromStoreId: "centro", toStoreId: "norte", qty: 10 },
    ]);
  });

  it("sin máximo, repone hasta el mínimo", () => {
    const s = suggestTransfers([cell("centro", 30, 5), cell("norte", 2, 5)]);
    expect(s[0]!.qty).toBe(3);
  });

  it("nunca deja a la donante bajo su mínimo", () => {
    const s = suggestTransfers([cell("centro", 7, 5), cell("norte", 0, 10)]);
    expect(s).toEqual([
      { key: "p:", fromStoreId: "centro", toStoreId: "norte", qty: 2 },
    ]);
  });

  it("cuenta lo que ya viene en camino", () => {
    expect(
      suggestTransfers([cell("centro", 30, 5), cell("norte", 2, 5, null, 3)]),
    ).toEqual([]);
  });

  it("reparte entre varias donantes, la más cargada primero", () => {
    const s = suggestTransfers([
      cell("a", 8, 2),
      cell("b", 20, 2),
      cell("c", 0, 25),
    ]);
    expect(s).toEqual([
      { key: "p:", fromStoreId: "b", toStoreId: "c", qty: 18 },
      { key: "p:", fromStoreId: "a", toStoreId: "c", qty: 6 },
    ]);
  });

  it("varias necesitadas: primero la de mayor faltante y sin sobre-asignar", () => {
    const s = suggestTransfers([
      cell("a", 10, 0),
      cell("b", 0, 3),
      cell("c", 0, 8),
    ]);
    const total = s.reduce((t, x) => t + x.qty, 0);
    expect(total).toBe(10);
    expect(s[0]!.toStoreId).toBe("c");
    expect(s[0]!.qty).toBe(8);
  });

  it("redondea a unidades enteras salvo productos fraccionables", () => {
    const cells = [cell("a", 10.5, 0), cell("b", 0.2, 1, 3.7)];
    expect(suggestTransfers(cells)[0]!.qty).toBe(3);
    expect(suggestTransfers(cells, { isInteger: () => false })[0]!.qty).toBe(
      3.5,
    );
  });

  it("filtra por sucursal de destino", () => {
    const cells = [cell("a", 50, 0), cell("b", 0, 3), cell("c", 0, 8)];
    const s = suggestTransfers(cells, { destStoreId: "b" });
    expect(s.map((x) => x.toStoreId)).toEqual(["b"]);
  });

  it("sin sobrante en ninguna sucursal no sugiere nada", () => {
    expect(suggestTransfers([cell("a", 1, 2), cell("b", 0, 3)])).toEqual([]);
  });

  it("agrupa por origen y destino (un traslado por par)", () => {
    const s = suggestTransfers([
      cell("a", 10, 0, null, 0, "p1:"),
      cell("b", 0, 2, null, 0, "p1:"),
      cell("a", 10, 0, null, 0, "p2:v"),
      cell("b", 0, 4, null, 0, "p2:v"),
    ]);
    const g = groupSuggestions(s);
    expect(g).toHaveLength(1);
    expect(g[0]!.lines.map((l) => l.qty)).toEqual([2, 4]);
  });

  it("claves de producto y variante ida y vuelta", () => {
    expect(parseStockKey(stockKey("p", null))).toEqual({
      productId: "p",
      variantId: null,
    });
    expect(parseStockKey(stockKey("p", "v"))).toEqual({
      productId: "p",
      variantId: "v",
    });
  });
});

describe("desglose por sucursal", () => {
  const stores = [
    { id: "n", name: "Norte", is_default: false },
    { id: "c", name: "Centro", is_default: true },
    { id: "s", name: "Shopping", is_default: false },
  ];
  const row = (
    store_id: string,
    qty: number,
    extra: Partial<StoreStockRow> = {},
  ): StoreStockRow => ({
    store_id,
    product_id: "p",
    variant_id: null,
    qty,
    min_qty: null,
    max_qty: null,
    location: null,
    in_transit_in: 0,
    in_transit_out: 0,
    ...extra,
  });

  it("una fila por sucursal, la actual primero y las sin saldo en 0", () => {
    const lines = storeStockLines(
      stores,
      [row("c", 5), row("n", 1, { min_qty: 2 })],
      "p",
      null,
      3,
      "n",
    );
    expect(lines.map((l) => l.store.id)).toEqual(["n", "c", "s"]);
    expect(lines[0]!.current).toBe(true);
    expect(lines[0]!.tone).toBe("low");
    expect(lines[0]!.min).toBe(2);
    expect(lines[1]!.min).toBe(3);
    expect(lines[2]!.qty).toBe(0);
    expect(lines[2]!.tone).toBe("out");
  });

  it("sin contexto, la principal es la actual", () => {
    const lines = storeStockLines(stores, [], "p", null, 0);
    expect(lines[0]!.store.id).toBe("c");
  });

  it("estados de stock", () => {
    expect(storeStockTone(-1, 0)).toBe("negative");
    expect(storeStockTone(0, 0)).toBe("out");
    expect(storeStockTone(2, 2)).toBe("low");
    expect(storeStockTone(3, 2)).toBe("ok");
  });

  it("totales por sucursal: con variantes suma variantes, sin variantes la fila del producto", () => {
    const rows = [
      row("c", 5),
      row("c", 2, { variant_id: "v1" }),
      row("n", 3, { variant_id: "v2" }),
    ];
    expect(Object.fromEntries(totalsByStore(rows, "p"))).toEqual({ c: 5 });
    expect(Object.fromEntries(totalsByStore(rows, "p", true))).toEqual({
      c: 2,
      n: 3,
    });
  });
});
