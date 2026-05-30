import { describe, it, expect } from "vitest";
import { isValidCuit } from "@/modules/customers/schemas";

describe("isValidCuit", () => {
  it("acepta un CUIT con dígito verificador correcto", () => {
    // 20-12345678-6 (dígito calculado)
    expect(isValidCuit("20123456786")).toBe(true);
    expect(isValidCuit("20-12345678-6")).toBe(true);
  });

  it("rechaza dígito verificador incorrecto", () => {
    expect(isValidCuit("20123456789")).toBe(false);
  });

  it("rechaza longitud inválida", () => {
    expect(isValidCuit("123")).toBe(false);
    expect(isValidCuit("")).toBe(false);
  });
});
