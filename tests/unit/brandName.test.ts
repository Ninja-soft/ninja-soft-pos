import { describe, it, expect } from "vitest";
import { findBrandByName, normalizeBrandName } from "@/lib/products/brandName";

describe("normalizeBrandName (espejo de brand_name_normalize)", () => {
  it("pasa a mayúsculas respetando acentos y ñ", () => {
    expect(normalizeBrandName("Ayudín")).toBe("AYUDÍN");
    expect(normalizeBrandName("ñandú")).toBe("ÑANDÚ");
    expect(normalizeBrandName("Codini")).toBe("CODINI");
  });

  it("recorta y colapsa espacios internos (también tabs)", () => {
    expect(normalizeBrandName("  coca   cola ")).toBe("COCA COLA");
    expect(normalizeBrandName("la\tserenísima")).toBe("LA SERENÍSIMA");
  });

  it("vacío o nulo queda vacío", () => {
    expect(normalizeBrandName("   ")).toBe("");
    expect(normalizeBrandName(null)).toBe("");
    expect(normalizeBrandName(undefined)).toBe("");
  });

  it("es idempotente", () => {
    const once = normalizeBrandName(" Epson  Argentina ");
    expect(normalizeBrandName(once)).toBe(once);
  });
});

describe("findBrandByName", () => {
  const brands = [
    { id: "1", name: "EPSON" },
    { id: "2", name: "Coca Cola" },
  ];

  it("encuentra sin distinguir mayúsculas ni espacios", () => {
    expect(findBrandByName(brands, "epson")?.id).toBe("1");
    expect(findBrandByName(brands, " COCA  cola")?.id).toBe("2");
  });

  it("no encuentra nombres distintos ni vacíos", () => {
    expect(findBrandByName(brands, "Epsonn")).toBeUndefined();
    expect(findBrandByName(brands, "  ")).toBeUndefined();
    expect(findBrandByName(null, "epson")).toBeUndefined();
  });
});
