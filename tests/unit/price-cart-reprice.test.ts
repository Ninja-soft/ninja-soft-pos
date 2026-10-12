import { describe, it, expect, beforeEach } from "vitest";
import { cartRepriceChanges, modifiersDelta, type RepriceLine } from "@/lib/prices/cartReprice";
import { currentPricingHeaders, usePricingContext } from "@/lib/prices/pricingContext";
import { selectList } from "@/lib/prices/resolve";
import { IDS, MATRIX_NOW, worldFor } from "../fixtures/priceMatrix";

const line = (over: Partial<RepriceLine>): RepriceLine => ({
  lineId: "l1",
  productId: "p1",
  variantId: null,
  name: "Yerba",
  unitPrice: 100,
  quantity: 1,
  ...over,
});

describe("cartRepriceChanges", () => {
  it("reprecia las líneas de producto con modificadores", () => {
    const lines = [
      line({ modifiers: [{ options: [{ price_delta: 50 }, { price_delta: 25.5 }] }], unitPrice: 175.5 }),
      line({ lineId: "l2", unitPrice: 100 }),
    ];
    const ch = cartRepriceChanges(lines, () => 120);
    expect(ch).toEqual([
      { lineId: "l1", name: "Yerba", from: 175.5, to: 195.5 },
      { lineId: "l2", name: "Yerba", from: 100, to: 120 },
    ]);
  });

  it("no toca precio manual, regalos, packs ni ítems libres", () => {
    const lines = [
      line({ priceOverride: true }),
      line({ lineId: "g", giftPromoId: "x", unitPrice: 0 }),
      line({ lineId: "c", packCreditId: "x" }),
      line({ lineId: "k", packId: "x" }),
      line({ lineId: "f", productId: null }),
    ];
    expect(cartRepriceChanges(lines, () => 999)).toEqual([]);
  });

  it("usa la cantidad (escalas) y saltea lo que no puede calcular", () => {
    const lines = [line({ quantity: 12 }), line({ lineId: "l2", productId: "p2" })];
    const ch = cartRepriceChanges(lines, (l) => (l.productId === "p2" ? null : l.quantity >= 10 ? 90 : 100));
    expect(ch).toEqual([{ lineId: "l1", name: "Yerba", from: 100, to: 90 }]);
    expect(modifiersDelta(null)).toBe(0);
  });
});

describe("contexto de precio del POS", () => {
  beforeEach(() => usePricingContext.getState().reset());

  it("arma los headers sólo con algo elegido", () => {
    expect(currentPricingHeaders()).toBeNull();
    usePricingContext.getState().setList("L");
    usePricingContext.getState().setTerm("none");
    expect(currentPricingHeaders()).toEqual({ "x-ninja-price-list": "L", "x-ninja-payment-term": "none" });
  });

  it("selectList explica qué lista aplica", () => {
    const at = new Date(MATRIX_NOW).getTime();
    expect(selectList(worldFor(true, IDS.C1), at, null, null)?.id).toBe(IDS.L_GRP);
    expect(selectList(worldFor(true, null), at, null, IDS.L_MAY)?.id).toBe(IDS.L_MAY);
    expect(selectList(worldFor(true, null), at, null, IDS.L_FUT)?.id).toBe(IDS.L_MOST);
    expect(selectList(worldFor(true, null), at, IDS.L_EXP, null)).toBeNull();
  });
});
