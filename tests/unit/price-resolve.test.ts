import { describe, it, expect } from "vitest";
import {
  resolvePrice,
  type PriceItemLike,
  type PriceListLike,
} from "@/lib/prices/resolve";

const PROD = "11111111-1111-1111-1111-111111111111";
const VAR = "22222222-2222-2222-2222-222222222222";

describe("resolvePrice", () => {
  it("item por variante gana sobre item por producto", () => {
    const items: PriceItemLike[] = [
      { product_id: PROD, variant_id: null, price: 800 },
      { product_id: PROD, variant_id: VAR, price: 950 },
    ];
    const list: PriceListLike = { adjustment_pct: -50 };
    expect(resolvePrice(1000, PROD, VAR, list, items)).toBe(950);
  });

  it("item por producto cuando no hay item por variante", () => {
    const items: PriceItemLike[] = [
      { product_id: PROD, variant_id: null, price: 800 },
    ];
    const list: PriceListLike = { adjustment_pct: 20 };
    expect(resolvePrice(1000, PROD, VAR, list, items)).toBe(800);
  });

  it("aplica adjustment_pct cuando no hay items", () => {
    const list: PriceListLike = { adjustment_pct: 10 };
    expect(resolvePrice(1000, PROD, null, list, [])).toBe(1100);
  });

  it("precio base cuando no hay lista", () => {
    expect(resolvePrice(1000, PROD, null, null, [])).toBe(1000);
  });

  it("precio base cuando la lista no tiene ajuste ni items", () => {
    const list: PriceListLike = { adjustment_pct: null };
    expect(resolvePrice(1000, PROD, null, list, [])).toBe(1000);
  });

  it("pct negativo = descuento", () => {
    const list: PriceListLike = { adjustment_pct: -15 };
    expect(resolvePrice(1000, PROD, null, list, [])).toBe(850);
  });

  it("redondea el ajuste a 2 decimales", () => {
    const list: PriceListLike = { adjustment_pct: 33.33 };
    // 1234.56 * 1.3333 = 1646.0367... → 1646.04
    expect(resolvePrice(1234.56, PROD, null, list, [])).toBe(1646.04);
  });

  it("item de otro producto no interfiere", () => {
    const items: PriceItemLike[] = [
      { product_id: "otro", variant_id: null, price: 1 },
    ];
    const list: PriceListLike = { adjustment_pct: 10 };
    expect(resolvePrice(1000, PROD, null, list, items)).toBe(1100);
  });
});
