// ADR-109: referencia de mercado (todas las ofertas por tienda y vendedor).
import { describe, it, expect } from "vitest";
import {
  comparePriceToReference,
  marketFromLabel,
  marketPosition,
  marketSummary,
  parseMarketOffer,
  parsePriceReference,
} from "@/modules/catalog/priceReference";

const offers = [
  { store_key: "COTO", store_name: "Coto", vendedor: "Coto", principal: true, precio: "2000", disponible: false },
  { store_key: "BNA", store_name: "Tienda BNA", vendedor: "Electro Sur", principal: false, precio: 1500, disponible: true },
  { store_key: "JUMBO", store_name: "Jumbo", vendedor: "Jumbo", principal: true, precio: 1800, disponible: true },
  { store_key: "DIA", store_name: "Día", vendedor: "Día", principal: true, precio: null, disponible: true },
].map(parseMarketOffer);

describe("referencia de mercado", () => {
  it("resumen: desde / hasta / mediana / vendedores (sin los que no tienen precio)", () => {
    const s = marketSummary(offers)!;
    expect([s.min, s.max, s.median, s.offers, s.sellers, s.stores]).toEqual([1500, 2000, 1800, 3, 3, 3]);
    expect(s.cheapest.seller).toBe("Electro Sur");
    expect(marketSummary([])).toBeNull();
    expect(marketSummary(offers.slice(0, 2))!.median).toBe(1750);
  });

  it("posición de mi precio", () => {
    const s = { min: 1500, max: 2000 };
    expect(marketPosition(1000, s)).toBe("below");
    expect(marketPosition(1500, s)).toBe("in_range");
    expect(marketPosition(2001, s)).toBe("above");
    expect(marketPosition(0, s)).toBeNull();
    expect(marketPosition(100, null)).toBeNull();
  });

  it("referencia por EAN: columnas nuevas y compatibilidad con la RPC vieja", () => {
    const ref = parsePriceReference({
      ean: "7790070012050", reference_price: "1800", store_count: 2, min_price: "1500", max_price: 2000,
      offer_count: 3, seller_count: 3, min_store_key: "BNA", min_store_name: "Tienda BNA", min_seller: "Electro Sur",
    });
    const fmt = (n: number) => `$${n}`;
    expect(marketFromLabel(ref, fmt)).toBe("desde $1500 en Tienda BNA/Electro Sur, 3 vendedores");
    expect(marketFromLabel({ ...ref, minSeller: "Tienda BNA", sellerCount: 1 }, fmt)).toBe("desde $1500 en Tienda BNA");
    const old = parsePriceReference({ ean: "1", reference_price: 100, store_count: 2 });
    expect(old).toMatchObject({ minPrice: null, offerCount: 2, sellerCount: 2 });
    expect(marketFromLabel(old, fmt)).toBeNull();
    expect(comparePriceToReference(1980, ref)).toMatchObject({ direction: "above", diffPct: 10 });
  });
});
