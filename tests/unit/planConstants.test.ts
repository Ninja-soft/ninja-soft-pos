import { describe, it, expect } from "vitest";
import { brandLogo, planLabel, BRAND_LABEL } from "@/modules/pos/planConstants";

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

describe("brandLogo", () => {
  it("devuelve ruta svg para marca conocida", () => {
    expect(brandLogo("visa")).toBe("/img/medios_de_pago/cards/visa_credito.svg");
  });
  it("null si no hay marca", () => {
    expect(brandLogo(null)).toBeNull();
    expect(brandLogo("inexistente")).toBeNull();
  });
});

describe("BRAND_LABEL", () => {
  it("mapea las marcas principales", () => {
    expect(BRAND_LABEL.visa).toBe("Visa");
    expect(BRAND_LABEL.master).toBe("Mastercard");
  });
});
