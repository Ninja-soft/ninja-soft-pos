import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCALE_FORMAT,
  buildScaleLabel,
  decodeScaleLabel,
  ean13CheckDigit,
  isValidEan13,
  parseScaleFormat,
  productCodeCandidates,
  scaleFormatProblem,
  scaleLine,
  serializeScaleFormat,
  valueCheckDigit,
  valueDigits,
  type ScaleLabelFormat,
} from "@/lib/barcode/scaleLabel";

// Etiquetas de balanza (F10 · H23, ADR-063). Fixtures con el dígito
// verificador EAN-13 calculado a mano (pesos 1 y 3 alternados).

const PRICE: ScaleLabelFormat = { ...DEFAULT_SCALE_FORMAT }; // 20-29, código 5, precio, 0 decimales
const WEIGHT: ScaleLabelFormat = { ...DEFAULT_SCALE_FORMAT, embed: "weight", decimals: 3 };

const FIXTURES = {
  // 20 | 01234 | 01500 | 4 → producto 01234, $ 1500
  price1500: "2001234015004",
  // 21 | 00045 | 01250 | 6 → producto 00045, 1,250 kg
  weight1250: "2100045012506",
  // 25 | 01234 | 00750 | 9 → producto 01234, 0,750 kg
  weight0750: "2501234007509",
  // 20 | 00123 | 00350 | 4 → con 2 decimales, $ 3,50
  price350c: "2000123003504",
};

describe("EAN-13", () => {
  it("dígito verificador de los fixtures", () => {
    expect(ean13CheckDigit("200123401500")).toBe(4);
    expect(ean13CheckDigit("210004501250")).toBe(6);
    // Ejemplo clásico de EAN-13 (4006381333931).
    expect(ean13CheckDigit("400638133393")).toBe(1);
    for (const code of Object.values(FIXTURES)) expect(isValidEan13(code)).toBe(true);
    expect(isValidEan13("2001234015005")).toBe(false);
    expect(isValidEan13("200123401500")).toBe(false);
  });
});

describe("decodeScaleLabel", () => {
  it("precio embebido", () => {
    expect(decodeScaleLabel(FIXTURES.price1500, PRICE)).toEqual({
      ok: true,
      prefix: "20",
      itemCode: "01234",
      embed: "price",
      value: 1500,
    });
  });

  it("precio con 2 decimales", () => {
    const d = decodeScaleLabel(FIXTURES.price350c, { ...PRICE, decimals: 2 });
    expect(d).toMatchObject({ ok: true, itemCode: "00123", value: 3.5 });
  });

  it("peso embebido en gramos (3 decimales)", () => {
    expect(decodeScaleLabel(FIXTURES.weight1250, WEIGHT)).toMatchObject({
      ok: true,
      prefix: "21",
      itemCode: "00045",
      embed: "weight",
      value: 1.25,
    });
    expect(decodeScaleLabel(FIXTURES.weight0750, WEIGHT)).toMatchObject({ itemCode: "01234", value: 0.75 });
  });

  it("no es etiqueta de balanza: otro prefijo, otro largo o prefijo no habilitado", () => {
    expect(decodeScaleLabel("4006381333931", PRICE)).toBeNull();
    expect(decodeScaleLabel("200123401500", PRICE)).toBeNull();
    expect(decodeScaleLabel("ABC", PRICE)).toBeNull();
    expect(decodeScaleLabel(FIXTURES.weight1250, { ...WEIGHT, prefixes: ["20"] })).toBeNull();
  });

  it("dígito verificador mal leído", () => {
    expect(decodeScaleLabel("2001234015005", PRICE)).toEqual({ ok: false, error: "check_digit" });
    // Sin validar, se acepta (balanzas que imprimen el DV mal).
    expect(decodeScaleLabel("2001234015005", { ...PRICE, verifyCheckDigit: false })).toMatchObject({ ok: true });
  });

  it("código del producto de 4 y 6 dígitos", () => {
    const f4 = { ...PRICE, codeDigits: 4 };
    const c4 = buildScaleLabel(f4, "22", "0077", 123456);
    expect(decodeScaleLabel(c4, f4)).toMatchObject({ itemCode: "0077", value: 123456 });
    const f6 = { ...WEIGHT, codeDigits: 6 };
    const c6 = buildScaleLabel(f6, "29", "123456", 2.5);
    expect(decodeScaleLabel(c6, f6)).toMatchObject({ itemCode: "123456", value: 2.5 });
  });
});

describe("dígito verificador del valor (GS1)", () => {
  it("vector de 4 dígitos: 2875 → 9", () => {
    expect(valueCheckDigit("2875")).toBe(9);
  });

  it("sólo existe para 4 o 5 dígitos", () => {
    expect(valueCheckDigit("123")).toBeNull();
    expect(valueCheckDigit("123456")).toBeNull();
  });

  it("ida y vuelta con 4 y 5 dígitos y rechazo si se altera", () => {
    const f5 = { ...PRICE, codeDigits: 4, valueCheckDigit: true }; // valor de 5
    const f4 = { ...PRICE, codeDigits: 5, valueCheckDigit: true }; // valor de 4
    expect(valueDigits(f5)).toBe(5);
    expect(valueDigits(f4)).toBe(4);
    for (const [f, v] of [
      [f5, 14685],
      [f5, 99],
      [f4, 2875],
      [f4, 1],
    ] as const) {
      const code = buildScaleLabel(f, "20", "12", v);
      expect(decodeScaleLabel(code, f)).toMatchObject({ ok: true, value: v });
      // Cambia el dígito del valor y recalcula el DV del EAN: tiene que fallar.
      const pos = 2 + f.codeDigits;
      const bad12 = code.slice(0, pos) + String((Number(code[pos]) + 1) % 10) + code.slice(pos + 1, 12);
      const bad = bad12 + ean13CheckDigit(bad12);
      expect(decodeScaleLabel(bad, f)).toEqual({ ok: false, error: "value_check_digit" });
    }
  });
});

describe("formato", () => {
  it("problemas del formato", () => {
    expect(scaleFormatProblem(PRICE)).toBeNull();
    expect(scaleFormatProblem({ ...PRICE, prefixes: [] })).toMatch(/prefijo/);
    expect(scaleFormatProblem({ ...PRICE, prefixes: ["30"] })).toMatch(/20 al 29/);
    expect(scaleFormatProblem({ ...PRICE, codeDigits: 7 })).toMatch(/entre 4 y 6/);
    expect(scaleFormatProblem({ ...PRICE, codeDigits: 6, valueCheckDigit: true })).toMatch(/4 o 5/);
  });

  it("serializa a snake_case y vuelve igual; basura cae al default", () => {
    const f: ScaleLabelFormat = { ...WEIGHT, prefixes: ["21", "20"], codeDigits: 4 };
    const raw = serializeScaleFormat(f);
    expect(raw).toEqual({
      prefixes: ["20", "21"],
      code_digits: 4,
      embed: "weight",
      decimals: 3,
      value_check_digit: false,
      verify_check_digit: true,
    });
    expect(parseScaleFormat(raw)).toEqual({ ...f, prefixes: ["20", "21"] });
    expect(parseScaleFormat(null)).toEqual(DEFAULT_SCALE_FORMAT);
    expect(parseScaleFormat({ code_digits: 6, value_check_digit: true })).toEqual(DEFAULT_SCALE_FORMAT);
  });
});

describe("línea del carrito", () => {
  it("peso embebido: cantidad = peso, monto = peso por precio", () => {
    const d = decodeScaleLabel(FIXTURES.weight1250, WEIGHT);
    if (!d?.ok) throw new Error("fixture");
    expect(scaleLine(d, 8000)).toEqual({ quantityKg: 1.25, amount: 10000 });
  });

  it("precio embebido: monto = etiqueta, cantidad = importe / precio por kg", () => {
    const d = decodeScaleLabel(FIXTURES.price1500, PRICE);
    if (!d?.ok) throw new Error("fixture");
    expect(scaleLine(d, 6000)).toEqual({ quantityKg: 0.25, amount: 1500 });
    // Sin precio por kg no se puede calcular el peso.
    expect(scaleLine(d, 0)).toBeNull();
  });

  it("valor en cero no agrega", () => {
    const d = decodeScaleLabel(buildScaleLabel(PRICE, "20", "1", 0), PRICE);
    if (!d?.ok) throw new Error("fixture");
    expect(scaleLine(d, 1000)).toBeNull();
  });

  it("candidatos de código del producto (PLU de 6 dígitos)", () => {
    expect(productCodeCandidates("01234")).toEqual(["01234", "1234", "001234"]);
    expect(productCodeCandidates("123456")).toEqual(["123456"]);
    expect(productCodeCandidates("00000")).toEqual(["00000", "0", "000000"]);
  });
});
