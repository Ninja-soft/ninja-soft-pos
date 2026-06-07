import { describe, it, expect } from "vitest";
import {
  firstPlanWithFeature,
  type PlanForUpgrade,
} from "@/modules/saas/gating";

function plan(
  key: string,
  opts: {
    sort?: number | null;
    price?: number;
    modules?: Record<string, unknown> | null;
  } = {},
): PlanForUpgrade {
  return {
    key,
    name: key.toUpperCase(),
    monthly_price_ars: opts.price ?? 0,
    sort: opts.sort ?? null,
    limits: { modules: opts.modules ?? {} },
  };
}

describe("firstPlanWithFeature", () => {
  it("devuelve el plan de menor sort que incluye la feature", () => {
    const plans = [
      plan("pro", { sort: 2, modules: { variantes: true } }),
      plan("basic", { sort: 1, modules: { variantes: false } }),
      plan("premium", { sort: 3, modules: { variantes: true } }),
    ];
    expect(firstPlanWithFeature(plans, "variantes")?.key).toBe("pro");
  });

  it("desempata por precio cuando el sort coincide", () => {
    const plans = [
      plan("caro", { sort: 1, price: 9000, modules: { x: true } }),
      plan("barato", { sort: 1, price: 5000, modules: { x: true } }),
    ];
    expect(firstPlanWithFeature(plans, "x")?.key).toBe("barato");
  });

  it("ignora planes donde la feature es false o ausente", () => {
    const plans = [
      plan("a", { sort: 1, modules: { y: false } }),
      plan("b", { sort: 2, modules: {} }),
      plan("c", { sort: 3, modules: { y: true } }),
    ];
    expect(firstPlanWithFeature(plans, "y")?.key).toBe("c");
  });

  it("devuelve null si ningún plan incluye la feature", () => {
    const plans = [
      plan("a", { modules: { otra: true } }),
      plan("b", { modules: {} }),
    ];
    expect(firstPlanWithFeature(plans, "variantes")).toBeNull();
  });

  it("trata sort null como el de menor prioridad", () => {
    const plans = [
      plan("sinSort", { sort: null, modules: { z: true } }),
      plan("conSort", { sort: 5, modules: { z: true } }),
    ];
    expect(firstPlanWithFeature(plans, "z")?.key).toBe("conSort");
  });

  it("requiere true estricto (no truthy) en el módulo", () => {
    const plans = [
      plan("a", { sort: 1, modules: { f: 1 } }),
      plan("b", { sort: 2, modules: { f: true } }),
    ];
    expect(firstPlanWithFeature(plans, "f")?.key).toBe("b");
  });
});
