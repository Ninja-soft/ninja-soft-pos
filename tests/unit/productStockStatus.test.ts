import { describe, it, expect } from "vitest";
import { productStockStatus } from "@/modules/products/stockStatus";

describe("productStockStatus", () => {
  it("sin control de stock muestra la leyenda y no la cantidad", () => {
    expect(productStockStatus({ track_stock: false, stock: 12, unit: "u" })).toEqual({
      tone: "untracked",
      label: "Sin control de stock",
    });
  });

  it("con control muestra cantidad y unidad", () => {
    expect(productStockStatus({ track_stock: true, stock: 12, stock_min: 2, unit: "u" })).toEqual({
      tone: "ok",
      label: "12 u",
    });
  });

  it("formatea decimales de productos por peso", () => {
    expect(productStockStatus({ track_stock: true, stock: 1.25, unit: "kg" }).label).toBe("1.25 kg");
  });

  it("marca agotado con stock en cero o negativo", () => {
    expect(productStockStatus({ track_stock: true, stock: 0, unit: "u" }).tone).toBe("out");
    expect(productStockStatus({ track_stock: true, stock: -3, unit: "u" }).tone).toBe("out");
  });

  it("marca bajo cuando llega al mínimo", () => {
    expect(productStockStatus({ track_stock: true, stock: 2, stock_min: 2, unit: "u" }).tone).toBe("low");
    expect(productStockStatus({ track_stock: true, stock: 3, stock_min: 0, unit: "u" }).tone).toBe("ok");
  });

  it("tolera unidad y stock nulos", () => {
    expect(productStockStatus({ track_stock: true, stock: null, unit: null })).toEqual({
      tone: "out",
      label: "0",
    });
  });
});
