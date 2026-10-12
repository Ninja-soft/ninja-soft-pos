import { describe, it, expect } from "vitest";
import { planLabel, BRAND_LABEL, summarizePlans } from "@/modules/pos/planConstants";
import { cardLogo, logoOnDark, paymentIcon, paymentWordmark } from "@/lib/payments/logos";

describe("summarizePlans", () => {
  it("cuenta planes por medio y ordena las marcas", () => {
    const s = summarizePlans([
      { provider_key: "payway", brand: "master" },
      { provider_key: "payway", brand: "visa" },
      { provider_key: "payway", brand: "visa" },
      { provider_key: "mobbex", brand: null },
    ]);
    expect(s.payway).toEqual({ count: 3, brands: ["visa", "master"] });
    expect(s.mobbex).toEqual({ count: 1, brands: [] });
    expect(s.mercadopago).toBeUndefined();
  });
});

describe("planLabel", () => {
  it("débito con marca", () => {
    expect(planLabel("debito", "visa", 1)).toBe("Débito Visa");
  });
  it("crédito 1 pago", () => {
    expect(planLabel("credito", "visa", 1)).toBe("Crédito Visa 1 pago");
  });
  it("crédito en cuotas", () => {
    expect(planLabel("credito", "master", 6)).toBe("Crédito Mastercard 6 cuotas");
  });
  it("sin marca", () => {
    expect(planLabel("credito", null, 3)).toBe("Crédito 3 cuotas");
  });
});

describe("cardLogo", () => {
  it("devuelve el webp de la red para marca conocida", () => {
    expect(cardLogo("visa")).toBe("/images/cards/visa.webp");
    expect(cardLogo("master")).toBe("/images/cards/mastercard.webp");
    expect(cardLogo("naranja")).toBe("/images/cards/naranja-x.webp");
  });
  it("usa la variante para fondo oscuro sólo si la marca la tiene", () => {
    expect(cardLogo("visa", { on: "dark" })).toBe("/images/cards/visa-on-dark.webp");
    expect(cardLogo("amex", { on: "dark" })).toBe("/images/cards/amex.webp");
    expect(cardLogo("master", { on: "dark" })).toBe("/images/cards/mastercard.webp");
  });
  it("null si no hay marca", () => {
    expect(cardLogo(null)).toBeNull();
    expect(cardLogo("inexistente")).toBeNull();
  });
});

describe("logoOnDark", () => {
  it("resuelve la variante oscura de un src ya armado", () => {
    expect(logoOnDark("/images/cards/visa-debito.webp")).toBe("/images/cards/visa-debito-on-dark.webp");
    expect(logoOnDark(paymentWordmark("mercadopago")!)).toBe("/images/payments/mercado-pago-wordmark-on-dark.webp");
    expect(logoOnDark(paymentIcon("payway_point")!)).toBe("/images/payments/payway-icon-on-dark.webp");
  });
  it("deja igual los logos sin variante", () => {
    expect(logoOnDark(paymentIcon("modo")!)).toBe("/images/payments/modo-icon.webp");
    expect(logoOnDark(cardLogo("amex")!)).toBe("/images/cards/amex.webp");
  });
});

describe("BRAND_LABEL", () => {
  it("mapea las marcas principales", () => {
    expect(BRAND_LABEL.visa).toBe("Visa");
    expect(BRAND_LABEL.master).toBe("Mastercard");
  });
});
