import { describe, it, expect } from "vitest";
import { inferFormat } from "@/modules/pos/useScanner";

describe("inferFormat", () => {
  it("detecta EAN-13 (13 dígitos)", () => {
    expect(inferFormat("7790001001234")).toBe("EAN-13");
  });

  it("detecta EAN-8 (8 dígitos)", () => {
    expect(inferFormat("12345678")).toBe("EAN-8");
  });

  it("detecta UPC-A (12 dígitos)", () => {
    expect(inferFormat("012345678905")).toBe("UPC-A");
  });

  it("clasifica otros largos numéricos como Numérico", () => {
    expect(inferFormat("12345")).toBe("Numérico");
    expect(inferFormat("1234567890123456")).toBe("Numérico");
  });

  it("detecta URL/QR", () => {
    expect(inferFormat("https://ninjapos.ar/p/42")).toBe("URL/QR");
    expect(inferFormat("http://example.com")).toBe("URL/QR");
  });

  it("clasifica el resto como Alfanumérico (Code 39/128)", () => {
    expect(inferFormat("ABC-123")).toBe("Alfanumérico (Code 39/128)");
    expect(inferFormat("SKU0099")).toBe("Alfanumérico (Code 39/128)");
  });
});
