import { describe, it, expect } from "vitest";
import { applyRounding, describeRounding, round2, toCents, toCentsCeil } from "@/lib/prices/rounding";
import { bulkNewPrice, indexPct, summarizePreview, termSurcharge } from "@/lib/prices/bulk";
import { markupToMargin, marginToMarkup, resolveUnitPrice, EMPTY_WORLD } from "@/lib/prices/resolve";

describe("centavos", () => {
  it("redondea mitad hacia arriba sin ruido binario", () => {
    expect(toCents(110.495)).toBe(11050);
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(round2(1646.0367)).toBe(1646.04);
    expect(toCents(-2.345)).toBe(-235);
  });
  it("techo a centavos para pisos de precio", () => {
    expect(toCentsCeil(872.7272)).toBe(87273);
    expect(toCentsCeil(100)).toBe(10000);
    expect(toCentsCeil(60 / 0.6)).toBe(10000);
  });
});

describe("applyRounding", () => {
  it("múltiplos en las tres direcciones", () => {
    const r = { mode: "multiple" as const, step: 10 };
    expect(applyRounding(1234.5, { ...r, direction: "nearest" })).toBe(1230);
    expect(applyRounding(1235, { ...r, direction: "nearest" })).toBe(1240);
    expect(applyRounding(1231, { ...r, direction: "up" })).toBe(1240);
    expect(applyRounding(1239, { ...r, direction: "down" })).toBe(1230);
    expect(applyRounding(1230, { ...r, direction: "up" })).toBe(1230);
    expect(applyRounding(1201, { mode: "multiple", step: 100, direction: "nearest" })).toBe(1200);
    expect(applyRounding(1251, { mode: "multiple", step: 50, direction: "down" })).toBe(1250);
  });
  it("nunca deja un precio en cero", () => {
    expect(applyRounding(4, { mode: "multiple", step: 10, direction: "down" })).toBe(10);
    expect(applyRounding(0.5, { mode: "ending", ending: 0.99, direction: "down" })).toBe(0.99);
  });
  it("terminaciones psicológicas", () => {
    expect(applyRounding(1050.5, { mode: "ending", ending: 0.99, direction: "nearest" })).toBe(1050.99);
    expect(applyRounding(1050.4, { mode: "ending", ending: 0.99, direction: "down" })).toBe(1049.99);
    expect(applyRounding(123.45, { mode: "ending", ending: 9, direction: "nearest" })).toBe(119);
    expect(applyRounding(123.45, { mode: "ending", ending: 9, direction: "up" })).toBe(129);
    expect(applyRounding(1234, { mode: "ending", ending: 90, direction: "up" })).toBe(1290);
    expect(applyRounding(1234, { mode: "ending", ending: 99, direction: "down" })).toBe(1199);
    expect(applyRounding(1299, { mode: "ending", ending: 99, direction: "nearest" })).toBe(1299);
    expect(applyRounding(12345, { mode: "ending", ending: 990, direction: "nearest" })).toBe(11990);
  });
  it("sin regla sólo redondea a centavos", () => {
    expect(applyRounding(10.555, null)).toBe(10.56);
    expect(applyRounding(10.555, { mode: "none" })).toBe(10.56);
    expect(applyRounding(10.555, { mode: "multiple", step: 0 })).toBe(10.56);
  });
  it("describe la regla", () => {
    expect(describeRounding({ mode: "ending", ending: 0.99, direction: "up" })).toBe("Terminado en ,99, hacia arriba");
    expect(describeRounding({ mode: "multiple", step: 100, direction: "nearest" })).toBe(
      "A múltiplos de $100, al más cercano",
    );
    expect(describeRounding(null)).toBe("Sin redondeo");
  });
});

describe("actualización masiva", () => {
  it("% y monto con redondeo (espejo de _price_bulk_new)", () => {
    expect(bulkNewPrice(1000, "pct", 12.5)).toBe(1125);
    expect(bulkNewPrice(1234.56, "pct", 7.3)).toBe(1324.68);
    expect(bulkNewPrice(1000, "pct", 12.5, { mode: "ending", ending: 9, direction: "up" })).toBe(1129);
    expect(bulkNewPrice(1000, "amount", -150.5)).toBe(849.5);
    expect(bulkNewPrice(100, "amount", -150)).toBe(0);
    expect(bulkNewPrice(999.99, "pct", -10, { mode: "multiple", step: 50, direction: "nearest" })).toBe(900);
  });
  it("resume la vista previa", () => {
    const s = summarizePreview([
      { product_id: "a", variant_id: null, name: "A", old_price: 100, new_price: 110, cost: 50 },
      { product_id: "b", variant_id: null, name: "B", old_price: 200, new_price: 180, cost: 190 },
      { product_id: "c", variant_id: null, name: "C", old_price: 300, new_price: 330, cost: null },
    ]);
    expect(s).toEqual({ count: 3, before: 600, after: 620, avgPct: 3.33, up: 2, down: 1, belowCost: 1 });
    expect(summarizePreview([]).avgPct).toBe(0);
  });
  it("% de un índice con tope", () => {
    expect(indexPct(1000, 1050.5)).toBe(5.05);
    expect(indexPct(100, 112.3456)).toBe(12.3456);
    expect(indexPct(100, 130, 20)).toBe(20);
    expect(indexPct(0, 10)).toBe(0);
  });
  it("recargo de una condición por tasa mensual", () => {
    expect(termSurcharge(4, 60, "simple")).toBe(8);
    expect(termSurcharge(4, 60, "compound")).toBe(8.16);
    expect(termSurcharge(3, 45, "compound")).toBe(4.534);
    expect(termSurcharge(4, 0, "simple")).toBe(0);
    expect(termSurcharge(4, 30, "flat")).toBe(0);
  });
  it("markup y margen", () => {
    expect(markupToMargin(50)).toBe(33.33);
    expect(marginToMarkup(33.33)).toBe(49.99);
    expect(marginToMarkup(100)).toBe(Infinity);
  });
  it("sin listas el resolver devuelve el precio base", () => {
    expect(resolveUnitPrice(EMPTY_WORLD, { productId: "x", basePrice: 123.456 }).price).toBe(123.46);
  });
});
