import { describe, expect, it } from "vitest";
import { parseZItems, zItemsTotals } from "@/lib/cash/zItems";
import { customerProfileHref } from "@/components/pos/screen/PosDialogs";

describe("Cierre Z: ítems vendidos resumidos (H30b)", () => {
  it("un Z sin resumen (anterior) devuelve null, no un turno vacío", () => {
    expect(parseZItems(null)).toBeNull();
    expect(parseZItems(undefined)).toBeNull();
    expect(parseZItems({})).toBeNull();
    expect(parseZItems([])).toEqual([]);
  });

  it("normaliza las líneas del servidor (números en texto, ítem libre, otros)", () => {
    const lines = parseZItems([
      { product_id: "p1", variant_id: null, name: "Remera", qty: "2", total: "200.00" },
      { product_id: null, variant_id: null, name: "Venta rápida", qty: 1, total: 50 },
      { name: "Otros productos", qty: 3, total: 30.5, other: true },
      { name: "", qty: null, total: null },
      "basura",
    ]);
    expect(lines).toEqual([
      { productId: "p1", variantId: null, name: "Remera", qty: 2, total: 200, other: false },
      { productId: null, variantId: null, name: "Venta rápida", qty: 1, total: 50, other: false },
      { productId: null, variantId: null, name: "Otros productos", qty: 3, total: 30.5, other: true },
      { productId: null, variantId: null, name: "Sin nombre", qty: 0, total: 0, other: false },
    ]);
    expect(zItemsTotals(lines!)).toEqual({ units: 6, total: 280.5 });
  });
});

describe("POS: acceso a la ficha del cliente (H31)", () => {
  it("arma el link a la ficha 360", () => {
    expect(customerProfileHref("abc-123")).toBe("/clientes/abc-123");
    expect(customerProfileHref("a/b")).toBe("/clientes/a%2Fb");
  });
});
