import { describe, it, expect } from "vitest";
import { buildWorkbook, numFmtFor } from "@/lib/utils/xlsxWorkbook";
import { XLSX_ROW_STYLE, xlsxDate, xlsxDay, xlsxFileSlug } from "@/lib/utils/xlsx";

const fillOf = (c: { fill?: unknown }) => (c.fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb;

describe("buildWorkbook · título, bajada y formatos", () => {
  const wb = buildWorkbook([
    {
      name: "Detalle",
      title: "Conciliación • NinjaPos",
      subtitle: "Mi negocio · 01/10/2026 al 12/10/2026",
      columns: [
        { header: "Fecha", key: "fecha", type: "datetime" },
        { header: "Día", key: "dia", type: "date" },
        { header: "Monto", key: "monto", type: "money" },
        { header: "Costo", key: "costo", type: "percent" },
        { header: "Estado", key: "estado", status: { Conciliado: { fill: "E7F4EA", font: "1E6B3A" } } },
      ],
      rows: [
        { fecha: xlsxDate("2026-10-05T13:30:00-03:00"), dia: xlsxDay("2026-10-05"), monto: 1000, costo: 0.052, estado: "Conciliado" },
        { fecha: null, dia: null, monto: 500, costo: 0, estado: "Pendiente" },
        { fecha: null, dia: null, monto: 1500, [XLSX_ROW_STYLE]: "subtotal" },
      ],
      totals: { monto: 1500 },
      totalsLabel: "Total del período",
    },
  ]);
  const ws = wb.getWorksheet("Detalle")!;

  it("pone el título en la fila 1, la bajada en la 2 y los encabezados en la 3", () => {
    expect(ws.getCell(1, 1).value).toBe("Conciliación • NinjaPos");
    expect(ws.getCell(2, 1).value).toBe("Mi negocio · 01/10/2026 al 12/10/2026");
    expect(ws.getCell(3, 1).value).toBe("Fecha");
  });

  it("combina el título y la bajada a lo ancho de la tabla", () => {
    expect(ws.getCell(1, 5).isMerged).toBe(true);
    expect(ws.getCell(2, 5).isMerged).toBe(true);
  });

  it("congela y filtra en la fila de encabezados", () => {
    expect(ws.views?.[0]).toMatchObject({ state: "frozen", ySplit: 3 });
    expect(ws.autoFilter).toMatchObject({ from: { row: 3, column: 1 }, to: { row: 3, column: 5 } });
  });

  it("aplica formatos de fecha con hora, fecha, moneda y porcentaje", () => {
    expect(ws.getCell(4, 1).numFmt).toBe("dd/mm/yyyy hh:mm");
    expect(ws.getCell(4, 2).numFmt).toBe("dd/mm/yyyy");
    expect(ws.getCell(4, 3).numFmt).toBe('"$"#,##0.00');
    expect(ws.getCell(4, 4).numFmt).toBe("0.0%");
    expect(ws.getCell(4, 3).alignment?.horizontal).toBe("right");
  });

  it("pinta la celda de estado según su valor (relleno sutil) y no las otras", () => {
    expect(fillOf(ws.getCell(4, 5))).toBe("FFE7F4EA");
    expect(ws.getCell(4, 5).font?.color?.argb).toBe("FF1E6B3A");
    expect(fillOf(ws.getCell(5, 5))).not.toBe("FFE7F4EA");
  });

  it("marca las filas de subtotal en negrita con fondo neutro", () => {
    expect(ws.getCell(6, 3).font?.bold).toBe(true);
    expect(fillOf(ws.getCell(6, 3))).toBe("FFE9E9EE");
  });

  it("usa el texto de totales pedido", () => {
    expect(ws.getCell(7, 1).value).toBe("Total del período");
    expect(ws.getCell(7, 3).value).toBe(1500);
  });
});

describe("buildWorkbook · varias tablas en una hoja (Resumen)", () => {
  const wb = buildWorkbook([
    {
      name: "Resumen",
      title: "Conciliación",
      columns: [],
      rows: [],
      sections: [
        {
          title: "Resumen del período",
          columns: [
            { header: "Concepto", key: "k", width: 40 },
            { header: "Monto", key: "v", type: "money" },
          ],
          rows: [
            { k: "Vendiste", v: 1000 },
            { k: "Te acreditaron", v: 800 },
          ],
        },
        {
          title: "Por procesador",
          columns: [
            { header: "Procesador", key: "p" },
            { header: "Vendido", key: "v", type: "money" },
          ],
          rows: [{ p: "Mercado Pago", v: 1000 }],
          totals: { v: 1000 },
        },
      ],
    },
  ]);
  const ws = wb.getWorksheet("Resumen")!;

  it("apila las tablas con su título y encabezado", () => {
    // 1 título, (aire) 3 título de sección, 4 encabezado, 5-6 filas
    expect(ws.getCell(1, 1).value).toBe("Conciliación");
    expect(ws.getCell(3, 1).value).toBe("Resumen del período");
    expect(ws.getCell(4, 1).value).toBe("Concepto");
    expect(ws.getCell(5, 2).value).toBe(1000);
    // (aire) 8 título, 9 encabezado, 10 fila, 11 total
    expect(ws.getCell(8, 1).value).toBe("Por procesador");
    expect(ws.getCell(9, 1).value).toBe("Procesador");
    expect(ws.getCell(10, 1).value).toBe("Mercado Pago");
    expect(ws.getCell(11, 1).value).toBe("Total");
    expect(ws.getCell(11, 2).value).toBe(1000);
  });

  it("no lleva autofiltro y deja el ancho más grande pedido", () => {
    expect(ws.autoFilter).toBeFalsy();
    expect(ws.getColumn(1).width).toBe(40);
  });
});

describe("helpers de celdas y nombres", () => {
  it("numFmtFor conoce los tipos nuevos", () => {
    expect(numFmtFor("percent")).toBe("0.0%");
    expect(numFmtFor("datetime")).toBe("dd/mm/yyyy hh:mm");
    expect(numFmtFor("text")).toBeUndefined();
  });

  it("xlsxDate guarda la hora local como la ve el usuario", () => {
    const local = new Date(2026, 9, 5, 13, 30);
    const d = xlsxDate(local)!;
    expect(d.getUTCHours()).toBe(13);
    expect(d.getUTCMinutes()).toBe(30);
    expect(d.getUTCDate()).toBe(5);
    expect(xlsxDate(null)).toBeNull();
    expect(xlsxDate("no es fecha")).toBeNull();
  });

  it("xlsxDay arma la fecha sin hora", () => {
    expect(xlsxDay("2026-10-05")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(xlsxDay("")).toBeNull();
  });

  it("xlsxFileSlug saca tildes, espacios y símbolos", () => {
    expect(xlsxFileSlug("Almacén Doña Ñata & Cía.")).toBe("almacen-dona-nata-cia");
    expect(xlsxFileSlug(null)).toBe("");
  });
});
