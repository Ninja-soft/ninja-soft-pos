import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsx";
import {
  parseProductsXlsx,
  PRODUCT_IMPORT_COLUMNS,
} from "@/modules/products/import";

async function xlsxBuffer(rows: Array<Record<string, unknown>>) {
  const wb = buildWorkbook([
    { name: "Productos", columns: PRODUCT_IMPORT_COLUMNS, rows },
  ]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parseProductsXlsx", () => {
  it("lee filas válidas y omite las inválidas", async () => {
    const buf = await xlsxBuffer([
      { name: "Coca 500", price: 800, stock: 10, unit: "un", category: "Bebidas" },
      { name: "", price: 100 }, // sin nombre → omitida
      { name: "Sin precio", price: "" }, // precio inválido → omitida
    ]);
    const res = await parseProductsXlsx(buf);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.name).toBe("Coca 500");
    expect(res.rows[0]!.price).toBe(800);
    expect(res.errors.length).toBe(2);
  });

  it("respeta defaults de unidad y stock", async () => {
    const buf = await xlsxBuffer([{ name: "Item", price: 50 }]);
    const res = await parseProductsXlsx(buf);
    expect(res.rows[0]!.unit).toBe("un");
    expect(res.rows[0]!.stock).toBe(0);
  });
});
