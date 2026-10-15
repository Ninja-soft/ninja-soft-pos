// ADR-140: costo final, utilidad, redondeo, mínimos, actualización por dólar y
// resolución con piso global y base "costo final". La paridad SQL vs TS de
// estas funciones corre además en PGlite con cientos de casos al azar.
import { describe, expect, it } from "vitest";
import {
  arsToUsd,
  bulkFollow,
  bulkRaw,
  bulkRound,
  costBreakdown,
  costExtrasError,
  finalCost,
  fxVariationPct,
  marginPct,
  pickFxQuote,
  priceFloorFromFinal,
  priceFromCost,
  usdToArs,
  utility,
} from "@/lib/prices/costing";
import { EMPTY_WORLD, resolveUnitPrice, type PricingWorld, type ProPriceList } from "@/lib/prices/resolve";
import { costingEquals, costingFromProduct, costingPatch } from "@/modules/prices/costingApi";

describe("costo final", () => {
  it("suma % sobre el costo de compra (no en cascada) y $", () => {
    const extras = [
      { label: "Internos", type: "pct" as const, value: 8 },
      { label: "Flete", type: "pct" as const, value: 5 },
      { label: "Embalaje", type: "amount" as const, value: 120 },
    ];
    expect(finalCost(10000, extras)).toBe(11420);
    expect(costBreakdown(10000, extras).map((e) => e.amount)).toEqual([800, 500, 120]);
  });
  it("bonificación negativa y nunca negativo", () => {
    expect(finalCost(1000, [{ label: "Bonif", type: "pct", value: -10 }])).toBe(900);
    expect(finalCost(100, [{ label: "Bonif", type: "amount", value: -500 }])).toBe(0);
    expect(finalCost(null, [])).toBeNull();
  });
  it("redondea cada componente a centavos como Postgres", () => {
    expect(finalCost(0.15, [{ label: "x", type: "pct", value: 50 }])).toBe(0.23); // 0,075 → 0,08
  });
  it("valida los componentes", () => {
    expect(costExtrasError([{ label: "x", type: "pct", value: 10 }])).toBeNull();
    expect(costExtrasError([{ label: "x", type: "pct", value: -100 }])).toBe("invalid_cost_extras");
    expect(costExtrasError([{ label: "x", type: "otro", value: 1 }])).toBe("invalid_cost_extras");
    expect(costExtrasError(Array(11).fill({ label: "x", type: "pct", value: 1 }))).toBe("invalid_cost_extras");
  });
});

describe("markup vs margen", () => {
  it("markup suma sobre el costo; margen es parte del precio", () => {
    expect(priceFromCost(100, "markup", 50)).toBe(150);
    expect(priceFromCost(100, "margin", 50)).toBe(200);
    expect(priceFromCost(100, "margin", 100)).toBeNull();
    expect(priceFromCost(0, "markup", 50)).toBeNull();
  });
  it("con IVA da el precio final", () => {
    expect(priceFromCost(1000, "markup", 100, 21)).toBe(2420);
  });
  it("utilidad sobre el precio sin IVA", () => {
    const u = utility(2420, 1000, 21)!;
    expect(u.net).toBe(2000);
    expect(u.amount).toBe(1000);
    expect(u.markupPct).toBe(100);
    expect(u.marginPct).toBe(50);
    expect(marginPct(150, 100, 0)).toBe(33.33);
    expect(utility(0, 100)).toBeNull();
  });
});

describe("dólar", () => {
  it("convierte y vuelve", () => {
    expect(usdToArs(10.5, 1234.5)).toBe(12962.25);
    expect(arsToUsd(12100, 1100)).toBe(11);
    expect(usdToArs(10, null)).toBeNull();
  });
  it("cotización: la fecha más nueva; si empata, la del negocio", () => {
    const rows = [
      { rate: 1000, rate_date: "2026-10-10", origin: "plataforma" as const },
      { rate: 1050, rate_date: "2026-10-10", origin: "negocio" as const },
      { rate: 1100, rate_date: "2026-10-14", origin: "plataforma" as const },
    ];
    expect(pickFxQuote(rows, "2026-10-12")?.rate).toBe(1050);
    expect(pickFxQuote(rows, "2026-10-15")?.rate).toBe(1100);
    expect(pickFxQuote(rows, "2026-10-01")).toBeNull();
    expect(fxVariationPct(1000, 1100)).toBe(10);
  });
});

describe("piso", () => {
  it("costo final / (1 − margen) × IVA, hacia arriba", () => {
    expect(priceFloorFromFinal(11000, 20, 21)).toBe(16637.5);
    expect(priceFloorFromFinal(100, 33, 0)).toBe(149.26);
    expect(priceFloorFromFinal(0, 20, 21)).toBe(0);
  });
});

describe("asistente: precio nuevo", () => {
  it("dólar mantiene la ganancia (precio × costo final nuevo / viejo)", () => {
    expect(bulkRaw({ mode: "fx", value: 0, oldPrice: 15000, oldFinal: 11000, newFinal: 13200, reprice: "keep_markup" })).toBe(18000);
    expect(bulkRaw({ mode: "fx", value: 0, oldPrice: 15000, oldFinal: 11000, newFinal: 13200, reprice: "none" })).toBeNull();
    expect(
      bulkRaw({ mode: "fx", value: 0, oldPrice: 15000, oldFinal: 11000, newFinal: 13200, reprice: "target", targetMode: "markup", targetPct: 40, ivaPct: 21 }),
    ).toBe(22360.8);
  });
  it("markup, desde costo, % y monto", () => {
    expect(bulkRaw({ mode: "markup", value: 100, markupMode: "markup", oldPrice: 2000, oldFinal: 1000, newFinal: 1000, ivaPct: 21 })).toBe(2420);
    expect(bulkRaw({ mode: "cost", value: 0, oldPrice: 2000, oldFinal: 1000, newFinal: 1000, targetMode: null, targetPct: null })).toBeNull();
    expect(bulkRaw({ mode: "pct", value: 10, oldPrice: 999.99, oldFinal: null, newFinal: null })).toBe(1099.99);
    expect(bulkRaw({ mode: "amount", value: -50, oldPrice: 30, oldFinal: null, newFinal: null })).toBe(0);
  });
  it("redondeo y precios que acompañan", () => {
    expect(bulkRound(18003, { mode: "multiple", step: 10, direction: "up" })).toBe(18010);
    expect(bulkRound(18003, { mode: "ending", ending: 99, direction: "nearest" })).toBe(17999);
    expect(bulkFollow(1800, 2000, 2420, null)).toBe(2178);
    expect(bulkFollow(1800, 0, 2420, null)).toBeNull();
  });
});

describe("resolución (espejo de _resolve_unit_price)", () => {
  const list = (over: Partial<ProPriceList>): ProPriceList => ({
    id: "L1",
    channel: "custom",
    adjustment_pct: null,
    is_active: true,
    created_at: "2026-01-01",
    prices_include_tax: true,
    ...over,
  });
  const world = (over: Partial<PricingWorld>): PricingWorld => ({ ...EMPTY_WORLD, pro: true, ...over });

  it("lista sobre costo final", () => {
    const w = world({
      lists: [list({ kind: "cost", cost_basis: "final", markup_mode: "markup", markup_value: 50 })],
      costs: { P: { cost: 10000, final_cost: 11000 } },
    });
    expect(resolveUnitPrice(w, { productId: "P", basePrice: 15000, listId: "L1" }).price).toBe(16500);
  });
  it("piso global sobre el costo final con IVA", () => {
    const w = world({ floorMarginPct: 20, costs: { P: { cost: 10000, final_cost: 11000, iva_pct: 21 } } });
    expect(resolveUnitPrice(w, { productId: "P", basePrice: 15000 }).price).toBe(16637.5);
    expect(resolveUnitPrice({ ...w, pro: false }, { productId: "P", basePrice: 15000 }).price).toBe(15000);
    // Lista neta (sin IVA): el piso no lleva IVA.
    const net = world({
      floorMarginPct: 20,
      lists: [list({ prices_include_tax: false, adjustment_pct: 0 })],
      costs: { P: { cost: 10000, final_cost: 11000, iva_pct: 21 } },
    });
    expect(resolveUnitPrice(net, { productId: "P", basePrice: 10000, listId: "L1" }).price).toBe(13750);
  });
  it("lista en dólares con la oficial de la plataforma y la del negocio", () => {
    const w = world({
      lists: [list({ kind: "currency", currency: "USD", fx_source: "oficial" })],
      items: [{ price_list_id: "L1", product_id: "P", variant_id: null, price: 10 }],
      fx: [
        { currency: "USD", source: "oficial", rate: 1000, rate_date: "2026-10-10", origin: "plataforma" },
        { currency: "USD", source: "oficial", rate: 1010, rate_date: "2026-10-10", origin: "negocio" },
        { currency: "USD", source: "oficial", rate: 1200, rate_date: "2026-10-13", origin: "plataforma" },
      ],
    });
    expect(resolveUnitPrice(w, { productId: "P", basePrice: 1, listId: "L1", at: "2026-10-12T15:00:00Z" }).price).toBe(10100);
    expect(resolveUnitPrice(w, { productId: "P", basePrice: 1, listId: "L1", at: "2026-10-13T15:00:00Z" }).price).toBe(12000);
  });
});

describe("borrador de costos de la ficha", () => {
  it("lee y arma el patch", () => {
    const d = costingFromProduct({ cost_currency: "USD", cost_usd: 10.5, cost_fx_source: "bna", cost_extras: [{ label: "Flete", type: "pct", value: 5 }], markup_mode: "margin", markup_pct: 30 });
    expect(d.cost_usd).toBe("10,5");
    const p = costingPatch(d, 1200);
    expect(p).toMatchObject({ cost_currency: "USD", cost_usd: 10.5, cost_fx_rate: 1200, markup_mode: "margin", markup_pct: 30 });
    const ars = costingPatch({ ...d, cost_currency: "ARS", markup_pct: "" }, 1200);
    expect(ars).toMatchObject({ cost_usd: null, cost_fx_rate: null, markup_mode: null, markup_pct: null });
    expect(costingEquals(d, costingFromProduct({ ...d, cost_usd: 10.5, markup_pct: 30 }))).toBe(true);
  });
});
