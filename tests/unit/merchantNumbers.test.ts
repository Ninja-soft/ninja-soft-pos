import { describe, it, expect } from "vitest";
import { cleanMerchantNumber, resolveMerchantNumber } from "@/lib/payments/merchantNumbers";

describe("números de comercio (conciliación)", () => {
  const providers = [
    { provider_key: "payway", merchant_numbers: { visa: "12345678", master: "555" } },
    { provider_key: "getnet", merchant_numbers: { visa: "99999999" } },
    { provider_key: "nave_point", merchant_numbers: {} },
  ];

  it("limpia espacios y separadores y corta en 20", () => {
    expect(cleanMerchantNumber(" 12.345-678 ")).toBe("12345678");
    expect(cleanMerchantNumber("")).toBe("");
    expect(cleanMerchantNumber("1".repeat(30))).toHaveLength(20);
  });

  it("usa el del medio del plan elegido", () => {
    expect(resolveMerchantNumber(providers, "visa", "getnet")).toBe("99999999");
  });

  it("sin plan, sólo si un único número corresponde a la marca", () => {
    expect(resolveMerchantNumber(providers, "master", null)).toBe("555");
    expect(resolveMerchantNumber(providers, "visa", null)).toBeNull();
  });

  it("null sin marca o sin números cargados", () => {
    expect(resolveMerchantNumber(providers, null, null)).toBeNull();
    expect(resolveMerchantNumber(providers, "amex", null)).toBeNull();
    expect(resolveMerchantNumber([], "visa", "payway")).toBeNull();
  });
});
