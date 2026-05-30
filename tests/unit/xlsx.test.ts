import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsx";

describe("buildWorkbook (export XLSX con diseño)", () => {
  const wb = buildWorkbook(
    [
      {
        name: "Por día",
        title: "Reporte de ventas",
        columns: [
          { header: "Día", key: "day" },
          { header: "Total", key: "total", type: "money" },
          { header: "Ventas", key: "count", type: "number" },
        ],
        rows: [
          { day: "2026-05-01", total: 1000, count: 3 },
          { day: "2026-05-02", total: 2500, count: 5 },
        ],
        totals: { total: 3500, count: 8 },
      },
    ],
    { accent: "EC3F17" },
  );

  const ws = wb.getWorksheet("Por día")!;

  it("crea una hoja por cada sheet", () => {
    expect(wb.worksheets.length).toBe(1);
    expect(ws).toBeDefined();
  });

  it("pone título en la fila 1 y headers en la fila 2", () => {
    expect(ws.getCell(1, 1).value).toBe("Reporte de ventas");
    expect(ws.getCell(2, 1).value).toBe("Día");
    expect(ws.getCell(2, 2).value).toBe("Total");
  });

  it("escribe las filas de datos con su valor", () => {
    expect(ws.getCell(3, 1).value).toBe("2026-05-01");
    expect(ws.getCell(3, 2).value).toBe(1000);
    expect(ws.getCell(4, 3).value).toBe(5);
  });

  it("aplica formato de moneda a columnas money", () => {
    expect(ws.getCell(3, 2).numFmt).toBe('"$"#,##0.00');
  });

  it("agrega fila de totales al pie", () => {
    const totalRow = 2 + 2 + 1; // header(2) + 2 datos + totales
    expect(ws.getCell(totalRow, 1).value).toBe("Total");
    expect(ws.getCell(totalRow, 2).value).toBe(3500);
  });

  it("define autofilter y header congelado en la fila de headers", () => {
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views?.[0]).toMatchObject({ state: "frozen", ySplit: 2 });
  });
});
