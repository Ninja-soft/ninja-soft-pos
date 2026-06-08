import { describe, it, expect } from "vitest";
import { formatQty, formatCurrency, capitalizeName } from "@/lib/utils/format";

describe("formatQty", () => {
  it("enteros sin decimales", () => {
    expect(formatQty(5)).toBe("5");
    expect(formatQty(0)).toBe("0");
  });
  it("fracciones sin ceros sobrantes", () => {
    expect(formatQty(2.5)).toBe("2.5");
  });
  it("null → 0", () => {
    expect(formatQty(null)).toBe("0");
  });
});

describe("formatCurrency", () => {
  it("devuelve string con símbolo de moneda", () => {
    const out = formatCurrency(1000);
    expect(typeof out).toBe("string");
    expect(out).toContain("$");
  });
});

describe("capitalizeName", () => {
  it("capitaliza la primera letra de cada palabra", () => {
    expect(capitalizeName("juan perez")).toBe("Juan Perez");
    expect(capitalizeName("hola juan perez")).toBe("Hola Juan Perez");
  });
  it("baja a minúscula el resto (mayúsculas de más)", () => {
    expect(capitalizeName("JUAN PEREZ")).toBe("Juan Perez");
    expect(capitalizeName("mARÍA")).toBe("María");
  });
  it("respeta acentos existentes (no los agrega ni quita)", () => {
    expect(capitalizeName("juan pérez")).toBe("Juan Pérez");
    expect(capitalizeName("MARÍA JOSÉ")).toBe("María José");
    // sin tilde en la entrada → sigue sin tilde
    expect(capitalizeName("maria jose")).toBe("Maria Jose");
  });
  it("maneja guiones y apóstrofos", () => {
    expect(capitalizeName("ana-maría")).toBe("Ana-María");
    expect(capitalizeName("d'angelo")).toBe("D'Angelo");
  });
  it("normaliza espacios internos no agregados y bordes", () => {
    expect(capitalizeName("  juan   perez  ")).toBe("  Juan   Perez  ");
  });
  it("null/undefined/vacío → string vacío", () => {
    expect(capitalizeName(null)).toBe("");
    expect(capitalizeName(undefined)).toBe("");
    expect(capitalizeName("")).toBe("");
  });
});
