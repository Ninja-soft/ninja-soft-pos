import { describe, it, expect } from "vitest";
import {
  code39Segments,
  code39Width,
  sanitizeCode39,
} from "@/lib/barcode/code39";
import { labelCode, clampCopies, buildLabels } from "@/lib/labels";

describe("code39", () => {
  it("sanitiza a caracteres válidos en mayúscula", () => {
    expect(sanitizeCode39("abc-123")).toBe("ABC-123");
    expect(sanitizeCode39("a*b")).toBe("AB"); // descarta el '*'
    expect(sanitizeCode39("ñ@#")).toBe(""); // sin válidos
  });

  it("genera segmentos con start/stop y arranca/termina en barra", () => {
    const segs = code39Segments("A");
    expect(segs[0]!.on).toBe(true); // primera barra del '*'
    expect(segs[segs.length - 1]!.on).toBe(true); // última barra del '*'
    // 3 caracteres (* A *) × 9 elementos + 2 gaps inter-carácter = 29 segmentos.
    expect(segs.length).toBe(29);
  });

  it("lanza si el texto queda vacío", () => {
    expect(() => code39Segments("@@@")).toThrow();
  });

  it("el ancho total es positivo y crece con más caracteres", () => {
    expect(code39Width("A")).toBeLessThan(code39Width("ABCDEF"));
  });
});

describe("labels", () => {
  it("labelCode prioriza barcode sobre sku y limpia", () => {
    expect(labelCode({ barcode: "779123", sku: "SKU1" })).toBe("779123");
    expect(labelCode({ barcode: null, sku: "sku-1" })).toBe("SKU-1");
    expect(labelCode({ barcode: null, sku: null })).toBeNull();
  });

  it("clampCopies entre 1 y 200", () => {
    expect(clampCopies(0)).toBe(1);
    expect(clampCopies(5.9)).toBe(5);
    expect(clampCopies(9999)).toBe(200);
    expect(clampCopies(NaN)).toBe(1);
  });

  it("buildLabels expande copias por producto", () => {
    const p = { id: "p1", name: "Coca", price: 100, barcode: "111", sku: null };
    const q = { id: "p2", name: "Agua", price: 50, barcode: null, sku: null };
    const labels = buildLabels([
      { product: p, copies: 3 },
      { product: q, copies: 1 },
    ]);
    expect(labels).toHaveLength(4);
    expect(labels.filter((l) => l.id === "p1")).toHaveLength(3);
    expect(labels.find((l) => l.id === "p2")!.code).toBeNull();
  });
});
