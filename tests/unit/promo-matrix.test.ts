import { describe, it, expect } from "vitest";
import { evaluatePromotions, cardKey, r2, arPromoClock } from "@/lib/promotions/engine";
import { PROMO_CASES, promoSqlArgs } from "../fixtures/promoMatrix";

// ADR-074: matriz de paridad. La misma tabla corre contra la base en
// tests/integration/rls-promociones.test.ts (promotion_preview).

describe("motor de promociones · matriz de paridad", () => {
  it.each(PROMO_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const ev = evaluatePromotions(c.lines, c.promos, c.ctx);
    expect(ev.discount).toBe(c.expected.discount);
    expect(ev.applied.map((a) => ({ id: a.promotionId, discount: a.discount }))).toEqual(c.expected.applied);
    if (c.expected.firstLines) expect(ev.applied[0]?.lines).toEqual(c.expected.firstLines);
    if (c.expected.gifts) expect(ev.gifts.map((g) => g.promotionId)).toEqual(c.expected.gifts);
    // El descuento por línea nunca supera lo que vale la línea y suma el total.
    for (const a of ev.applied) {
      a.lines.forEach((x, i) => expect(x).toBeLessThanOrEqual(c.lines[i]!.lineTotal + 0.001));
      expect(r2(a.lines.reduce((s, x) => s + x, 0))).toBe(a.discount);
    }
  });

  it("la tabla es suficientemente amplia", () => {
    expect(PROMO_CASES.length).toBeGreaterThanOrEqual(50);
    const types = new Set(PROMO_CASES.flatMap((c) => c.promos.map((p) => p.action_type)));
    for (const t of ["percent", "amount", "fixed_price", "nxm", "second_item", "volume_tier", "bundle", "gift"]) {
      expect(types.has(t as never)).toBe(true);
    }
  });

  it("arma los argumentos SQL con todas las claves en cada línea y pago", () => {
    const a = promoSqlArgs(PROMO_CASES.find((c) => c.name.startsWith("banco: crédito"))!);
    expect(Object.keys(a.p_lines[0]!).sort()).toEqual(
      ["brand_id", "category_id", "excluded", "line_total", "product_id", "quantity"].sort(),
    );
    expect(a.p_ctx.payments).toEqual([{ method: "credit", card_brand: "visa", bank: "galicia", ineligible: false }]);
  });
});

describe("utilidades del motor", () => {
  it("r2 redondea mitad hacia arriba como round(numeric, 2)", () => {
    expect(r2(4.9995)).toBe(5);
    expect(r2(1.005)).toBe(1.01);
    expect(r2(0.075)).toBe(0.08);
    expect(r2(206.8965)).toBe(206.9);
    expect(r2(-1.005)).toBe(-1.01);
  });

  it("cardKey acepta clave o etiqueta", () => {
    expect(cardKey("Visa")).toBe("visa");
    expect(cardKey("Mastercard")).toBe("master");
    expect(cardKey(" American Express ")).toBe("amex");
    expect(cardKey("")).toBeNull();
    expect(cardKey(null)).toBeNull();
  });

  it("arPromoClock da día, minutos y fecha de Argentina (UTC-3)", () => {
    // 2026-11-05 01:30 UTC = 2026-11-04 22:30 en Argentina (miércoles).
    expect(arPromoClock(new Date("2026-11-05T01:30:00Z"))).toEqual({ weekday: 3, minutes: 22 * 60 + 30, date: "2026-11-04" });
  });
});
