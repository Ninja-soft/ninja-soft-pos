import { describe, it, expect } from "vitest";
import { buildWorkbook, type XlsxColumn } from "@/lib/utils/xlsx";
import {
  parseProductsXlsx,
  PRODUCT_IMPORT_COLUMNS,
} from "@/modules/products/import";
import { validRows, countRows } from "@/lib/utils/xlsxImport";

async function xlsxBuffer(
  rows: Array<Record<string, unknown>>,
  columns: XlsxColumn[] = PRODUCT_IMPORT_COLUMNS,
) {
  const wb = buildWorkbook([{ name: "Productos", columns, rows }]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parseProductsXlsx", () => {
  it("lee filas válidas y marca las inválidas con error por fila", async () => {
    const buf = await xlsxBuffer([
      { name: "Coca 500", price: 800, stock: 10, unit: "un", category: "Bebidas" },
      { name: "", price: 100 }, // sin nombre → error
      { name: "Sin precio", price: "" }, // precio faltante → error
      { name: "Precio texto", price: "abc" }, // precio inválido → error
    ]);
    const res = await parseProductsXlsx(buf);
    expect(res.fatalError).toBeNull();
    const { valid, invalid } = countRows(res);
    expect(valid).toBe(1);
    expect(invalid).toBe(3);
    const ok = validRows(res);
    expect(ok[0]!.name).toBe("Coca 500");
    expect(ok[0]!.price).toBe(800);
  });

  it("respeta defaults de unidad, stock, IVA y track_stock", async () => {
    const buf = await xlsxBuffer([{ name: "Item", price: 50 }]);
    const ok = validRows(await parseProductsXlsx(buf));
    expect(ok[0]!.unit).toBe("un");
    expect(ok[0]!.stock).toBe(0);
    expect(ok[0]!.tax_rate).toBe(21);
    expect(ok[0]!.track_stock).toBe(true);
  });

  it("parsea marca, IVA y track_stock cuando vienen", async () => {
    const buf = await xlsxBuffer([
      {
        name: "Remera",
        price: 5000,
        brand: "Nike",
        tax_rate: 10.5,
        track_stock: "no",
      },
    ]);
    const ok = validRows(await parseProductsXlsx(buf));
    expect(ok[0]!.brand).toBe("Nike");
    expect(ok[0]!.tax_rate).toBe(10.5);
    expect(ok[0]!.track_stock).toBe(false);
  });

  it("admite precio con coma decimal (es-AR)", async () => {
    // price sin type "money" → exceljs lo escribe como string crudo "1.234,50".
    const buf = await xlsxBuffer(
      [{ name: "Item", price: "1.234,50" }],
      [
        { header: "name", key: "name" },
        { header: "price", key: "price" },
      ],
    );
    const ok = validRows(await parseProductsXlsx(buf));
    expect(ok[0]!.price).toBe(1234.5);
  });

  it("marca barcodes duplicados dentro del archivo", async () => {
    const buf = await xlsxBuffer([
      { name: "A", price: 1, barcode: "777" },
      { name: "B", price: 2, barcode: "777" },
    ]);
    const res = await parseProductsXlsx(buf);
    expect(countRows(res).valid).toBe(1);
    expect(res.rows[1]!.errors.join(" ")).toMatch(/duplicado/i);
  });

  it("devuelve fatalError si falta la columna name", async () => {
    const buf = await xlsxBuffer(
      [{ price: 100 }],
      [{ header: "price", key: "price", type: "money" }],
    );
    const res = await parseProductsXlsx(buf);
    expect(res.fatalError).toBeTruthy();
    expect(res.rows.length).toBe(0);
  });

  it("no rompe con un archivo que no es xlsx", async () => {
    const bad = new TextEncoder().encode("esto no es un xlsx").buffer;
    const res = await parseProductsXlsx(bad);
    expect(res.fatalError).toBeTruthy();
    expect(res.rows.length).toBe(0);
  });
});
