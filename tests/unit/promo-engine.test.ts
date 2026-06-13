import { describe, it, expect } from "vitest";
import {
  evaluateCart,
  promoApplies,
  promoDiscount,
  cartSubtotal,
  simulatePromotion,
  type Promotion,
  type PromoCartLine,
  type PromoContext,
  type SimSale,
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
    buy_qty: null,
    pay_qty: null,
    ...p,
  };
}

const cart: PromoCartLine[] = [
  { productId: "prodA", categoryId: "catX", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
  { productId: "prodB", categoryId: "catY", unitPrice: 500, quantity: 1, lineTotal: 500 },
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

describe("promoDiscount — H54 (NxM y precio fijo)", () => {
  // 4 unidades de $100 en una categoría: 2x1 → 2 unidades gratis = $200.
  const fourUnits: PromoCartLine[] = [
    { productId: "p", categoryId: "catX", unitPrice: 100, quantity: 4, lineTotal: 400 },
  ];
  it("2x1 libera la mitad (unidades más baratas)", () => {
    expect(
      promoDiscount(
        base({ action_type: "nxm", buy_qty: 2, pay_qty: 1, scope: "category", scope_category_id: "catX" }),
        fourUnits,
      ),
    ).toBe(200); // 4/2 = 2 sets, cada set libera 1 → 2 gratis × $100
  });
  it("3x2 sobre 6 unidades libera 2", () => {
    const six: PromoCartLine[] = [
      { productId: "p", categoryId: "catX", unitPrice: 100, quantity: 6, lineTotal: 600 },
    ];
    expect(
      promoDiscount(
        base({ action_type: "nxm", buy_qty: 3, pay_qty: 2, scope: "category", scope_category_id: "catX" }),
        six,
      ),
    ).toBe(200); // 6/3 = 2 sets, cada set libera 1 → 2 gratis
  });
  it("NxM libera las unidades MÁS BARATAS", () => {
    const mixed: PromoCartLine[] = [
      { productId: "a", categoryId: "catX", unitPrice: 300, quantity: 1, lineTotal: 300 },
      { productId: "b", categoryId: "catX", unitPrice: 100, quantity: 1, lineTotal: 100 },
    ];
    // 2x1 sobre 2 unidades → 1 gratis = la de $100.
    expect(
      promoDiscount(
        base({ action_type: "nxm", buy_qty: 2, pay_qty: 1, scope: "category", scope_category_id: "catX" }),
        mixed,
      ),
    ).toBe(100);
  });
  it("NxM sin grupos completos no descuenta", () => {
    const one: PromoCartLine[] = [
      { productId: "p", categoryId: "catX", unitPrice: 100, quantity: 1, lineTotal: 100 },
    ];
    expect(
      promoDiscount(
        base({ action_type: "nxm", buy_qty: 2, pay_qty: 1, scope: "category", scope_category_id: "catX" }),
        one,
      ),
    ).toBe(0);
  });
  it("precio fijo: el alcance pasa a costar action_value", () => {
    // Carrito base 1500, precio fijo 1200 → descuento 300.
    expect(promoDiscount(base({ action_type: "fixed_price", action_value: 1200 }), cart)).toBe(300);
    // Precio fijo mayor que la base → no descuenta (no encarece).
    expect(promoDiscount(base({ action_type: "fixed_price", action_value: 2000 }), cart)).toBe(0);
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

describe("simulatePromotion — H56", () => {
  const sales: SimSale[] = [
    // Miércoles (3), 13:00, $1500 → 10% = $150.
    { weekday: 3, minutes: 13 * 60, date: "2026-06-10", lines: cart },
    // Martes (2): si la promo es sólo miércoles, no aplica.
    { weekday: 2, minutes: 13 * 60, date: "2026-06-09", lines: cart },
    // Ticket chico que no llega al mínimo.
    {
      weekday: 3,
      minutes: 13 * 60,
      date: "2026-06-10",
      lines: [{ productId: "x", categoryId: "z", unitPrice: 100, quantity: 1, lineTotal: 100 }],
    },
  ];

  it("cuenta tickets, descuento total y total vendido (promo simple)", () => {
    const r = simulatePromotion(base({ action_type: "percent", action_value: 10 }), sales);
    expect(r.ticketsAnalyzed).toBe(3);
    expect(r.ticketsWithPromo).toBe(3); // 10% sin condiciones aplica a los 3
    expect(r.totalDiscount).toBe(310); // 150 + 150 + 10
    expect(r.totalSold).toBe(3100); // 1500 + 1500 + 100
  });

  it("respeta las condiciones de la promo (sólo miércoles + mínimo)", () => {
    const r = simulatePromotion(
      base({ action_type: "percent", action_value: 10, days_of_week: [3], min_amount: 1000 }),
      sales,
    );
    // Sólo el primer ticket (miércoles y ≥ 1000). El martes y el chico quedan fuera.
    expect(r.ticketsWithPromo).toBe(1);
    expect(r.totalDiscount).toBe(150);
  });

  it("simula aunque la promo esté inactiva (borrador)", () => {
    const r = simulatePromotion(
      base({ is_active: false, action_type: "amount", action_value: 100 }),
      sales,
    );
    expect(r.ticketsWithPromo).toBe(3);
  });
});
