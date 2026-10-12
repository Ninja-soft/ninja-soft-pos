import { describe, expect, it } from "vitest";
import {
  guessMapping,
  parsePrice,
  previewPriceList,
  previewSummary,
  rowsFromGrid,
  rowsToApply,
} from "@/lib/purchases/priceList";

describe("lista de precios del proveedor", () => {
  it("sugiere el mapeo por encabezado", () => {
    const m = guessMapping(["Código", "Descripción", "EAN", "Precio Lista", "Unidades x bulto"]);
    expect(m).toEqual({ supplier_sku: 0, name: 1, barcode: 2, cost: 3, units: 4 });
  });

  it("lee precios con formato argentino y anglosajón", () => {
    expect(parsePrice("$ 1.234,56")).toBe(1234.56);
    expect(parsePrice("1,234.56")).toBe(1234.56);
    expect(parsePrice("12,5")).toBe(12.5);
    expect(parsePrice("1.234.567")).toBe(1234567);
    expect(parsePrice(99.9)).toBe(99.9);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("consultar")).toBeNull();
  });

  const grid = [
    ["Código", "Descripción", "EAN", "Precio"],
    ["Y-1", "Yerba 1 kg", "", "1.500,00"],
    ["", "Sin código", "", "10"],
    ["X-9", "Producto nuevo", "", "300"],
    ["", "Fideos", "7790001", "800"],
    ["Y-2", "Azúcar", "", "consultar"],
    ["", "", "", ""],
    ["Y-3", "Arroz", "", "450"],
  ];

  it("arma filas y marca errores por fila", () => {
    const rows = rowsFromGrid(grid, guessMapping(grid[0]!));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ line: 2, supplier_sku: "Y-1", cost: 1500, error: null });
    expect(rows[1]!.error).toMatch(/Sin código/);
    expect(rows[4]!.error).toMatch(/Costo/);
  });

  it("cruza por código del proveedor y por código de barras, con diferencia en %", () => {
    const rows = rowsFromGrid(grid, guessMapping(grid[0]!));
    const preview = previewPriceList(
      rows,
      [
        { id: "sp1", product_id: "p1", variant_id: null, supplier_sku: "Y-1", list_cost: 1200, currency: "ARS", units_per_purchase: 1 },
        { id: "sp3", product_id: "p3", variant_id: null, supplier_sku: "Y-3", list_cost: 450, currency: "ARS", units_per_purchase: 1 },
      ],
      [
        { id: "p1", name: "Yerba", sku: null, barcode: null },
        { id: "p2", name: "Fideos", sku: null, barcode: "7790001" },
        { id: "p3", name: "Arroz", sku: null, barcode: null },
      ],
      { currency: "ARS" },
    );
    const by = (line: number) => preview.find((r) => r.line === line)!;
    expect(by(2)).toMatchObject({ status: "update", old_cost: 1200, new_cost: 1500, change_pct: 25 });
    expect(by(4).status).toBe("unmatched");
    expect(by(5)).toMatchObject({ status: "link", product_id: "p2" });
    expect(by(8).status).toBe("same");
    expect(previewSummary(preview)).toMatchObject({ update: 1, same: 1, link: 1, unmatched: 1, invalid: 2, avgChange: 25 });

    expect(rowsToApply(preview, false)).toEqual([
      { product_id: "p1", variant_id: null, supplier_sku: "Y-1", list_cost: 1500, units_per_purchase: null },
    ]);
    expect(rowsToApply(preview, true)).toHaveLength(2);
  });

  it("aplica la bonificación de la lista", () => {
    const rows = rowsFromGrid([["cod", "precio"], ["A", "1000"]], { supplier_sku: 0, cost: 1 });
    const p = previewPriceList(
      rows,
      [{ id: "s", product_id: "p", variant_id: null, supplier_sku: "A", list_cost: 900, currency: "ARS", units_per_purchase: 1 }],
      [],
      { currency: "ARS", discountPct: 10 },
    );
    expect(p[0]).toMatchObject({ status: "same", new_cost: 900 });
  });
});
