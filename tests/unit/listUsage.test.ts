// ADR-151 (auditoría de listas): dónde se usa cada lista, ayuda del canal y el
// precio de una lista con el mismo resolver del POS en el editor de la lista.
import { describe, expect, it } from "vitest";
import { RESOLUTION_ORDER, channelHelp, listUsage, productCostsLike, worldWithList } from "@/lib/prices/listUsage";
import { EMPTY_WORLD, resolvePrice, resolveUnitPrice, type PricingWorld } from "@/lib/prices/resolve";

describe("listUsage", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("mostrador y catálogo se usan solos", () => {
    expect(listUsage({ id: "l1", channel: "mostrador" }, [], now)).toEqual({
      used: true,
      where: ["POS por defecto"],
      warning: null,
    });
    expect(listUsage({ id: "l2", channel: "catalogo" }, [], now).where).toEqual(["Catálogo público"]);
  });

  it("mayorista sin asignar avisa que no se usa", () => {
    const u = listUsage({ id: "l3", channel: "mayorista" }, [], now);
    expect(u.used).toBe(false);
    expect(u.warning).toMatch(/Todavía no se usa/);
  });

  it("cuenta asignaciones por destino y elegible en el POS", () => {
    const a = [
      { price_list_id: "l3", scope: "customer_group" },
      { price_list_id: "l3", scope: "customer_group" },
      { price_list_id: "l3", scope: "store" },
      { price_list_id: "l3", scope: "customer" },
      { price_list_id: "otra", scope: "store" },
    ];
    const u = listUsage({ id: "l3", channel: "custom", pos_selectable: true }, a, now);
    expect(u.where).toEqual(["Elegible en el POS", "1 cliente", "2 grupos de clientes", "1 sucursal"]);
    expect(u.warning).toBeNull();
  });

  it("apagada o vencida avisa aunque esté asignada", () => {
    const a = [{ price_list_id: "l4", scope: "store" }];
    expect(listUsage({ id: "l4", channel: "custom", is_active: false }, a, now).warning).toMatch(/apagada/);
    expect(listUsage({ id: "l4", channel: "custom", valid_to: "2026-10-01T00:00:00Z" }, a, now).warning).toMatch(/venció/);
  });

  it("ayuda del canal y orden de resolución", () => {
    expect(channelHelp("mostrador")).toMatch(/POS/);
    expect(channelHelp("mayorista")).toMatch(/sólo un nombre/);
    expect(RESOLUTION_ORDER).toHaveLength(5);
    expect(RESOLUTION_ORDER[0]).toMatch(/elegibles en el POS/);
  });
});

describe("precio de una lista con el resolver del POS", () => {
  const world: PricingWorld = {
    ...EMPTY_WORLD,
    pro: true,
    lists: [
      { id: "base", channel: "custom", adjustment_pct: -10, kind: "fixed", is_active: true },
      { id: "der", channel: "custom", adjustment_pct: 5, kind: "derived", base_list_id: "base", is_active: true },
      { id: "cos", channel: "custom", adjustment_pct: null, kind: "cost", cost_basis: "cost", markup_mode: "markup", markup_value: 60, is_active: true },
      {
        id: "red",
        channel: "custom",
        adjustment_pct: 7,
        kind: "fixed",
        rounding: { mode: "multiple", step: 100, direction: "up" },
        is_active: true,
      },
    ],
  };

  it("derivada, sobre costo y redondeo dan lo que cobra el POS (el cálculo simple sólo aplicaba el %)", () => {
    const costs = { p1: productCostsLike({ cost: "600", final_cost: null }) };
    const w = worldWithList(world, "der", [], costs);
    const q = (listId: string) => resolveUnitPrice(w, { productId: "p1", basePrice: 1000, listId, termId: "none" }).price;
    expect(q("der")).toBe(945);
    expect(q("cos")).toBe(960);
    expect(q("red")).toBe(1100);
    // Lo que mostraba el editor de la lista antes (sólo el % de la lista):
    expect(resolvePrice(1000, "p1", null, { adjustment_pct: 5 }, [])).toBe(1050);
  });

  it("un precio fijo de la lista pisa la regla", () => {
    const w = worldWithList(world, "der", [{ product_id: "p1", variant_id: null, price: 777 }]);
    expect(resolveUnitPrice(w, { productId: "p1", basePrice: 1000, listId: "der", termId: "none" }).price).toBe(777);
  });

  it("los costos del producto se leen como los usa el resolver", () => {
    expect(productCostsLike({ cost: "10.5", last_cost: null, avg_cost: "", replacement_cost: 12, final_cost: 11 })).toEqual({
      cost: 10.5,
      last_cost: null,
      avg_cost: null,
      replacement_cost: 12,
      min_price: null,
      final_cost: 11,
    });
  });
});
