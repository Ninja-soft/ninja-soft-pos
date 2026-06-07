import { describe, it, expect } from "vitest";
import {
  parseAxisValues,
  generateCombos,
  variantSku,
  type AxisDef,
} from "@/lib/variants/matrix";

describe("parseAxisValues", () => {
  it("recorta espacios y separa por coma", () => {
    expect(parseAxisValues("S, M , L")).toEqual(["S", "M", "L"]);
  });
  it("descarta vacíos", () => {
    expect(parseAxisValues("S, , M,")).toEqual(["S", "M"]);
  });
  it("deduplica respetando mayúsculas/minúsculas", () => {
    expect(parseAxisValues("S, M, S, s")).toEqual(["S", "M", "s"]);
  });
  it("string vacío → []", () => {
    expect(parseAxisValues("")).toEqual([]);
    expect(parseAxisValues("   ")).toEqual([]);
  });
});

describe("generateCombos", () => {
  it("2x2 = 4 combinaciones en orden estable", () => {
    const axes: AxisDef[] = [
      { name: "Talle", values: ["S", "M"] },
      { name: "Color", values: ["Rojo", "Negro"] },
    ];
    expect(generateCombos(axes)).toEqual([
      { option1: "S", option2: "Rojo" },
      { option1: "S", option2: "Negro" },
      { option1: "M", option2: "Rojo" },
      { option1: "M", option2: "Negro" },
    ]);
  });

  it("1 eje → option2 null", () => {
    const axes: AxisDef[] = [{ name: "Talle", values: ["S", "M", "L"] }];
    expect(generateCombos(axes)).toEqual([
      { option1: "S", option2: null },
      { option1: "M", option2: null },
      { option1: "L", option2: null },
    ]);
  });

  it("0 ejes → []", () => {
    expect(generateCombos([])).toEqual([]);
  });

  it("ejes sin valores → []", () => {
    expect(generateCombos([{ name: "Talle", values: [] }])).toEqual([]);
  });

  it("segundo eje sin valores se ignora (queda 1 eje)", () => {
    const axes: AxisDef[] = [
      { name: "Talle", values: ["S", "M"] },
      { name: "Color", values: [] },
    ];
    expect(generateCombos(axes)).toEqual([
      { option1: "S", option2: null },
      { option1: "M", option2: null },
    ]);
  });
});

describe("variantSku", () => {
  it("compone padre + opciones en mayúsculas", () => {
    expect(variantSku("REM-001", { option1: "M", option2: "Rojo" })).toBe(
      "REM-001-M-ROJO",
    );
  });

  it("1 sola opción", () => {
    expect(variantSku("REM-001", { option1: "M", option2: null })).toBe(
      "REM-001-M",
    );
  });

  it("acentos y espacios: 'Rojo Claro' → 'ROJO-CLARO'", () => {
    expect(variantSku("REM-1", { option1: "M", option2: "Rojo Claro" })).toBe(
      "REM-1-M-ROJO-CLARO",
    );
  });

  it("remueve acentos (Marrón → MARRON)", () => {
    expect(variantSku("P", { option1: "Marrón", option2: null })).toBe(
      "P-MARRON",
    );
  });

  it("descarta caracteres no [A-Z0-9-]", () => {
    expect(variantSku("P", { option1: "38½", option2: null })).toBe("P-38");
  });

  it("padre null → null", () => {
    expect(variantSku(null, { option1: "M", option2: "Rojo" })).toBeNull();
    expect(variantSku("  ", { option1: "M", option2: null })).toBeNull();
  });
});
