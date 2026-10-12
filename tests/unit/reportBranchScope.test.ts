import { describe, expect, it } from "vitest";
import {
  branchFileTag,
  branchStockOf,
  filterByStore,
  reportScopeLabel,
} from "@/lib/reports/branchScope";

describe("reportScopeLabel", () => {
  it("no muestra nada con una sola sucursal", () => {
    expect(reportScopeLabel(false, null)).toBeNull();
    expect(reportScopeLabel(false, { name: "Centro" })).toBeNull();
  });
  it("consolidado y sucursal (nombre corto si hay)", () => {
    expect(reportScopeLabel(true, null)).toBe("Todas las sucursales");
    expect(reportScopeLabel(true, { name: "Sucursal Norte", short_name: "Norte" })).toBe("Sucursal Norte");
    expect(reportScopeLabel(true, { name: "Centro", short_name: "  " })).toBe("Sucursal Centro");
  });
});

describe("branchFileTag", () => {
  it("slug sin acentos ni espacios", () => {
    expect(branchFileTag(false, { name: "Centro" })).toBe("");
    expect(branchFileTag(true, null)).toBe("todas");
    expect(branchFileTag(true, { name: "Córdoba Shopping" })).toBe("cordoba-shopping");
    expect(branchFileTag(true, { name: "###" })).toBe("sucursal");
  });
});

describe("filterByStore", () => {
  const rows = [
    { id: 1, store_id: "a" },
    { id: 2, store_id: "b" },
    { id: 3, store_id: null },
  ];
  it("sin sucursal devuelve todo", () => {
    expect(filterByStore(rows, null)).toHaveLength(3);
  });
  it("con sucursal filtra", () => {
    expect(filterByStore(rows, "b").map((r) => r.id)).toEqual([2]);
  });
});

describe("branchStockOf", () => {
  const rows = [
    { store_id: "a", product_id: "p", variant_id: null, qty: 5, min_qty: 2 },
    { store_id: "b", product_id: "p", variant_id: null, qty: 1, min_qty: null },
    { store_id: "a", product_id: "v", variant_id: "v1", qty: 3, min_qty: null },
    { store_id: "a", product_id: "v", variant_id: "v2", qty: 4, min_qty: null },
  ];
  it("null sin sucursal", () => {
    expect(branchStockOf(rows, { id: "p" }, null)).toBeNull();
  });
  it("stock y mínimo de la sucursal, o el del producto", () => {
    expect(branchStockOf(rows, { id: "p", stock_min: 9 }, "a")).toEqual({ qty: 5, min: 2 });
    expect(branchStockOf(rows, { id: "p", stock_min: 9 }, "b")).toEqual({ qty: 1, min: 9 });
    expect(branchStockOf(rows, { id: "p" }, "c")).toEqual({ qty: 0, min: 0 });
  });
  it("suma variantes", () => {
    expect(branchStockOf(rows, { id: "v", has_variants: true }, "a")).toEqual({ qty: 7, min: 0 });
  });
});
