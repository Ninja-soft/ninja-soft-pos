import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import {
  PROMO_KINDS,
  actionPhrase,
  conditionPhrases,
  emptyPromotion,
  kindOf,
  promoStatus,
  ticketPreview,
  validityText,
} from "@/lib/promotions/describe";
import { ticketPromoLabel, ticketPromoLines } from "@/lib/promotions/ticket";
import { promotionRow, sanitizeBundle } from "@/modules/promotions/api";
import { promo } from "../fixtures/promoMatrix";

// ADR-074: textos del asistente, estado del listado, vista previa del ticket
// y normalización de lo que se guarda.

const CLOCK = { weekday: 3, minutes: 19 * 60, date: "2026-11-04" };

describe("asistente: tipos y valores por defecto", () => {
  it("cada tipo tiene título y ejemplo", () => {
    for (const k of PROMO_KINDS) {
      expect(k.title.length).toBeGreaterThan(3);
      expect(k.example.length).toBeGreaterThan(5);
      expect(`${k.title}${k.example}${k.how}`).not.toMatch(/—/);
    }
  });

  it("el atajo por medio de pago es un porcentaje con condición de cobro", () => {
    const p = emptyPromotion("payment");
    expect(p.action_type).toBe("percent");
    expect(kindOf({ ...p, card_brands: ["visa"] })).toBe("payment");
    expect(kindOf(p)).toBe("percent");
    expect(emptyPromotion("nxm")).toMatchObject({ action_type: "nxm", buy_qty: 2, pay_qty: 1 });
  });
});

describe("frases en lenguaje simple", () => {
  const names = { categories: { catX: "Bebidas" }, products: { cafe: "Café", ml: "Medialuna" } };

  it("describe la acción con su alcance", () => {
    expect(actionPhrase(promo({ id: "a", action_type: "nxm", buy_qty: 2, pay_qty: 1, scope: "category", scope_ids: ["catX"] }), names)).toBe(
      "Lleva 2 y paga 1 en Bebidas",
    );
    expect(actionPhrase(promo({ id: "a", action_value: 10 }), names)).toBe("10% de descuento en toda la compra");
    expect(
      actionPhrase(
        promo({ id: "a", action_type: "bundle", action_value: 2500, bundle_items: [{ product_id: "cafe", qty: 1 }, { product_id: "ml", qty: 2 }] }),
        names,
      ),
    ).toBe("Combo Café + 2 Medialuna a $2.500");
  });

  it("lista las condiciones", () => {
    const c = conditionPhrases(
      promo({
        id: "a",
        days_of_week: [3],
        time_from: 18 * 60,
        time_to: 21 * 60,
        payment_method: "credit",
        card_brands: ["visa"],
        min_amount: 5000,
        max_uses_per_customer: 1,
      }),
    );
    expect(c).toEqual(["miércoles", "de 18:00 a 21:00", "pagando con crédito", "tarjeta Visa", "desde $5.000", "1 vez por cliente"]);
  });

  it("vigencia en texto", () => {
    expect(validityText(promo({ id: "a" }))).toBe("Sin vencimiento");
    expect(validityText(promo({ id: "a", valid_from: "2026-11-01", valid_to: "2026-11-30" }))).toBe("Del 01/11 al 30/11");
    expect(validityText(promo({ id: "a", valid_to: "2026-11-30" }))).toBe("Hasta el 30/11");
  });
});

describe("estado en el listado", () => {
  it("activa, pausada, vencida, programada y fuera de horario", () => {
    expect(promoStatus(promo({ id: "a" }), CLOCK).key).toBe("active");
    expect(promoStatus(promo({ id: "a", is_active: false }), CLOCK).key).toBe("paused");
    expect(promoStatus(promo({ id: "a", valid_to: "2026-11-03" }), CLOCK).key).toBe("expired");
    expect(promoStatus(promo({ id: "a", valid_from: "2026-11-10" }), CLOCK).label).toBe("Empieza el 10/11");
    expect(promoStatus(promo({ id: "a", days_of_week: [1] }), CLOCK).key).toBe("waiting");
    expect(promoStatus(promo({ id: "a", time_from: 20 * 60 }), CLOCK).key).toBe("waiting");
  });
});

describe("así se ve en el ticket", () => {
  const catalog = [
    { id: "gaseosa", name: "Gaseosa", price: 1000, category_id: "bebidas" },
    { id: "cafe", name: "Café", price: 1500 },
    { id: "ml", name: "Medialuna", price: 700 },
    { id: "llavero", name: "Llavero", price: 300 },
  ];

  it("2x1 en una categoría arma un carrito que la dispara", () => {
    const t = ticketPreview(
      promo({ id: "a", name: "2x1 Bebidas", action_type: "nxm", buy_qty: 2, pay_qty: 1, scope: "category", scope_ids: ["bebidas"] }),
      catalog,
    );
    expect(t.items).toEqual([{ name: "Gaseosa", quantity: 2, amount: 2000 }]);
    expect(t.promos).toEqual([{ label: "2x1 Bebidas", amount: 1000 }]);
    expect(t.total).toBe(1000);
  });

  it("ignora día, horario y medio de pago para mostrar el efecto", () => {
    const t = ticketPreview(promo({ id: "a", name: "Visa 20%", action_value: 20, card_brands: ["visa"], days_of_week: [1] }), catalog);
    expect(t.promos[0]?.amount).toBe(200);
  });

  it("combo con sus productos y el texto del ticket", () => {
    const t = ticketPreview(
      promo({
        id: "a",
        name: "Combo",
        ticket_label: "Desayuno",
        action_type: "bundle",
        action_value: 2500,
        bundle_items: [
          { product_id: "cafe", qty: 1 },
          { product_id: "ml", qty: 2 },
        ],
      }),
      catalog,
    );
    expect(t.subtotal).toBe(2900);
    expect(t.promos).toEqual([{ label: "Desayuno", amount: 400 }]);
  });

  it("llega a la compra mínima y muestra el regalo", () => {
    const t = ticketPreview(
      promo({ id: "a", name: "Regalo", action_type: "gift", action_value: 0, gift_product_id: "llavero", gift_qty: 1, min_amount: 2500 }),
      catalog,
    );
    expect(t.subtotal).toBeGreaterThanOrEqual(2500);
    expect(t.gift).toBe("1 Llavero");
  });

  it("sin productos usa uno de ejemplo", () => {
    const t = ticketPreview(promo({ id: "a", name: "10%" }), []);
    expect(t.items[0]?.name).toBe("Producto de ejemplo");
    expect(t.promos[0]?.amount).toBe(100);
  });
});

describe("líneas de promociones en el ticket", () => {
  it("separa las promos del resto del descuento", () => {
    const r = ticketPromoLines(1500, [
      { label: "2x1 Bebidas", kind: "discount", amount: 1000 },
      { label: "Visa 5%", kind: "discount", amount: 75 },
      { label: "Llavero", kind: "gift", amount: 300 },
    ]);
    expect(r.promos.map(ticketPromoLabel)).toEqual(["2x1 Bebidas", "Visa 5%", "Regalo: Llavero"]);
    expect(r.otherDiscount).toBe(425);
  });

  it("sin promos todo es descuento y sin descuento no hay línea", () => {
    expect(ticketPromoLines(250, []).otherDiscount).toBe(250);
    expect(ticketPromoLines(100, [{ label: "10%", kind: "discount", amount: 100 }]).otherDiscount).toBe(0);
  });
});

describe("lo que se guarda", () => {
  it("el alcance va en scope_ids y limpia lo que el tipo no usa", () => {
    const row = promotionRow({
      name: " 2x1 ",
      scope: "category",
      scope_ids: ["c1", "c2"],
      action_type: "nxm",
      action_value: 99,
      buy_qty: 2,
      pay_qty: 1,
      volume_tiers: [{ min_qty: 3, pct: 10 }],
      card_brands: [],
      store_ids: ["s1"],
      max_uses_total: 0,
      ticket_label: "x".repeat(60),
    });
    expect(row).toMatchObject({
      name: "2x1",
      scope_ids: ["c1", "c2"],
      scope_category_id: null,
      buy_qty: 2,
      volume_tiers: null,
      card_brands: null,
      store_ids: ["s1"],
      max_uses_total: null,
      stackable: false,
    });
    expect((row.ticket_label as string).length).toBe(40);
  });

  it("el combo es de toda la compra y sin productos repetidos", () => {
    const row = promotionRow({
      name: "Combo",
      scope: "category",
      action_type: "bundle",
      action_value: 2500,
      bundle_items: [
        { product_id: "a", qty: 1 },
        { product_id: "a", qty: 2 },
        { product_id: "b", qty: 0 },
      ],
    });
    expect(row.scope).toBe("cart");
    expect(row.bundle_items).toEqual([{ product_id: "a", qty: 1 }]);
    expect(sanitizeBundle([])).toBeNull();
  });
});
