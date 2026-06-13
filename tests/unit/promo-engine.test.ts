import { describe, it, expect } from "vitest";
import {
  evaluateCart,
  promoApplies,
  promoDiscount,
  cartSubtotal,
  type Promotion,
  type PromoCartLine,
  type PromoContext,
} from "@/lib/promotions/engine";

// F9 · H53 — el motor de promociones es PURO: estos tests fijan su contrato
// (condiciones de vigencia, alcance, acción y elección de la mejor promo).

const ctx: PromoContext = { weekday: 3, minutes: 13 * 60, date: "2026-06-13" };

function base(p: Partial<Promotion>): Promotion {
  return {
    id: "p1",
    name: "Promo",
    is_active: true,
    priority: 0,
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    time_from: null,
    time_to: null,
    min_amount: 0,
    scope: "cart",
    scope_category_id: null,
    scope_product_id: null,
    action_type: "percent",
    action_value: 10,
    ...p,
  };
}

const cart: PromoCartLine[] = [
  { productId: "prodA", categoryId: "catX", lineTotal: 1000 },
  { productId: "prodB", categoryId: "catY", lineTotal: 500 },
];

describe("cartSubtotal", () => {
  it("suma las líneas", () => {
    expect(cartSubtotal(cart)).toBe(1500);
  });
});

describe("promoDiscount", () => {
  it("% sobre todo el carrito", () => {
    expect(promoDiscount(base({ action_type: "percent", action_value: 10 }), cart)).toBe(150);
  });
  it("monto fijo, acotado a la base del alcance", () => {
    expect(promoDiscount(base({ action_type: "amount", action_value: 200 }), cart)).toBe(200);
    // Una categoría con base 500, monto fijo 800 → se acota a 500.
    expect(
      promoDiscount(
        base({ action_type: "amount", action_value: 800, scope: "category", scope_category_id: "catY" }),
        cart,
      ),
    ).toBe(500);
  });
  it("% sobre una categoría usa sólo esa base", () => {
    expect(
      promoDiscount(
        base({ scope: "category", scope_category_id: "catX", action_value: 10 }),
        cart,
      ),
    ).toBe(100); // 10% de 1000
  });
});

describe("promoApplies — condiciones", () => {
  it("inactiva no aplica", () => {
    expect(promoApplies(base({ is_active: false }), cart, ctx)).toBe(false);
  });
  it("respeta el rango de fechas", () => {
    expect(promoApplies(base({ valid_from: "2026-06-14" }), cart, ctx)).toBe(false);
    expect(promoApplies(base({ valid_to: "2026-06-12" }), cart, ctx)).toBe(false);
    expect(promoApplies(base({ valid_from: "2026-06-01", valid_to: "2026-06-30" }), cart, ctx)).toBe(true);
  });
  it("respeta días de semana", () => {
    expect(promoApplies(base({ days_of_week: [1, 2] }), cart, ctx)).toBe(false); // hoy = 3
    expect(promoApplies(base({ days_of_week: [3] }), cart, ctx)).toBe(true);
    expect(promoApplies(base({ days_of_week: [] }), cart, ctx)).toBe(true); // vacío = todos
  });
  it("respeta la franja horaria (fin exclusivo)", () => {
    expect(promoApplies(base({ time_from: 14 * 60 }), cart, ctx)).toBe(false); // 13:00 < 14:00
    expect(promoApplies(base({ time_to: 13 * 60 }), cart, ctx)).toBe(false); // 13:00 >= 13:00
    expect(promoApplies(base({ time_from: 12 * 60, time_to: 15 * 60 }), cart, ctx)).toBe(true);
  });
  it("respeta el monto mínimo del carrito", () => {
    expect(promoApplies(base({ min_amount: 2000 }), cart, ctx)).toBe(false);
    expect(promoApplies(base({ min_amount: 1500 }), cart, ctx)).toBe(true);
  });
  it("no aplica si el alcance no tiene líneas", () => {
    expect(
      promoApplies(base({ scope: "product", scope_product_id: "no-existe" }), cart, ctx),
    ).toBe(false);
  });
});

describe("evaluateCart — elige la mejor", () => {
  it("devuelve la promo que más descuenta", () => {
    const promos = [
      base({ id: "a", action_type: "percent", action_value: 10 }), // 150
      base({ id: "b", action_type: "amount", action_value: 300 }), // 300
    ];
    expect(evaluateCart(cart, promos, ctx)).toEqual({ promotionId: "b", name: "Promo", discount: 300 });
  });
  it("desempata por prioridad", () => {
    const promos = [
      base({ id: "a", action_type: "amount", action_value: 200, priority: 1 }),
      base({ id: "b", action_type: "amount", action_value: 200, priority: 5 }),
    ];
    expect(evaluateCart(cart, promos, ctx)?.promotionId).toBe("b");
  });
  it("ignora las que no aplican y devuelve null si ninguna sirve", () => {
    const promos = [base({ is_active: false }), base({ min_amount: 99999 })];
    expect(evaluateCart(cart, promos, ctx)).toBeNull();
  });
});
