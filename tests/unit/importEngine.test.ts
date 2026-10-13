import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildWorkbook } from "@/lib/utils/xlsxWorkbook";
import {
  normalizeHeader,
  parseImportGrid,
  parseXlsx,
  toIsoDay,
  toNumber,
  type ImportColumn,
} from "@/lib/utils/xlsxImport";
import {
  buildOutcomes,
  buildPayloads,
  chunk,
  countOutcomes,
  errorReportSheets,
  mergeServerResults,
  parseImportFile,
  templateSheets,
} from "@/lib/import/engine";
import { importErrorMessage, importNoteMessage } from "@/lib/import/messages";
import type { ImportDefinition, ServerImportResult } from "@/lib/import/types";
import { IMPORT_DEFINITIONS } from "@/modules/imports/registry";

// Motor único de importación XLSX (TX-4, ADR-078).

interface Row {
  name: string;
  qty: number | null;
  active: boolean | null;
  day: string | null;
  store: string | null;
}

const COLS: ImportColumn[] = [
  { header: "Nombre", key: "name", required: true, aliases: ["name"] },
  { header: "Cantidad", key: "qty", type: "number" },
  { header: "Activo", key: "active", type: "boolean" },
  { header: "Fecha", key: "day", type: "date" },
  { header: "Sucursal", key: "store" },
];

const DEF: ImportDefinition<Row> = {
  entity: "stock",
  rpc: "import_stock",
  title: "Prueba",
  singular: "fila",
  plural: "filas",
  sheetName: "Datos",
  fileSlug: "prueba",
  intro: "Intro.",
  matchRule: "Regla.",
  fields: () => COLS.map((c) => ({ ...c, help: `Ayuda ${c.header}` })).map((f) =>
    f.key === "store" ? { ...f, options: ["Centro", "Norte"] } : f,
  ),
  example: () => [{ name: "Ejemplo", qty: 1, active: "Sí", day: "01/02/2026", store: "Centro" }],
  schema: () =>
    z
      .object({ qty: z.number().max(100, "Máximo 100.").nullable() })
      .passthrough(),
  dedupeKey: ["name", "store"],
  preview: [{ header: "Nombre", cell: (r) => r.name }],
  toPayload: ({ day, ...rest }) => ({ ...rest, effective_at: day }),
  invalidate: [],
};

describe("normalizeHeader", () => {
  it("ignora mayúsculas, acentos, guiones bajos, asterisco y paréntesis", () => {
    expect(normalizeHeader("Código de Barras *")).toBe("codigo de barras");
    expect(normalizeHeader("codigo_de_barras")).toBe("codigo de barras");
    expect(normalizeHeader("  IVA %  (opcional) ")).toBe("iva %");
    expect(normalizeHeader("Stock-Mínimo")).toBe("stock minimo");
  });
});

describe("conversiones", () => {
  it("números con coma decimal, signo $ y punto decimal de Excel", () => {
    expect(toNumber("1.234,50")).toBe(1234.5);
    expect(toNumber("$ 1.500,00")).toBe(1500);
    expect(toNumber("1.125")).toBe(1.125);
    expect(toNumber("abc")).toBeNull();
  });
  it("fechas dd/mm/aaaa, ISO y fechas imposibles", () => {
    expect(toIsoDay("5/3/2026")).toBe("2026-03-05");
    expect(toIsoDay("2026-03-05T00:00:00.000Z")).toBe("2026-03-05");
    expect(toIsoDay("31/02/2026")).toBeNull();
  });
});

describe("parseImportGrid", () => {
  const grid = {
    cells: [
      ["Plantilla de prueba"], // título arriba de la tabla
      ["NOMBRE *", "cantidad", "ACTIVO", "fecha", "Sucursal", "Columna extra"],
      ["Yerba", "3", "si", "05/03/2026", "Centro", "x"],
      ["", "", "", "", "", ""], // fila vacía: se saltea
      ["", "2", "", "", "", ""], // sin nombre
      ["Azúcar", "dos", "quizás", "30/02/2026", "", ""], // tipos inválidos
      ["Yerba", "1", "", "", "centro", ""], // duplicado (nombre + sucursal)
      ["Arroz", "500", "", "", "", ""], // Zod: máximo 100
    ],
    rowNumbers: [1, 2, 3, 4, 6, 7, 9, 10],
  };

  const res = parseImportGrid<Row>(grid, COLS, { dedupeKey: ["name", "store"], schema: DEF.schema!({}) });

  it("ubica la fila de encabezados y usa el número real de fila", () => {
    expect(res.fatalError).toBeNull();
    expect(res.rows.map((r) => r.rowNumber)).toEqual([3, 6, 7, 9, 10]);
    expect(res.rows[0]!.data).toEqual({ name: "Yerba", qty: 3, active: true, day: "2026-03-05", store: "Centro" });
    expect(res.ignoredHeaders).toEqual(["Columna extra"]);
  });

  it("marca obligatorias, tipos, Zod y duplicados por fila", () => {
    const errs = res.rows.map((r) => r.errors.join(" | "));
    expect(errs[0]).toBe("");
    expect(errs[1]).toMatch(/Falta "Nombre"/);
    expect(errs[2]).toMatch(/"Cantidad" no es un número/);
    expect(errs[2]).toMatch(/"Activo" no es sí\/no/);
    expect(errs[2]).toMatch(/"Fecha" no es una fecha válida/);
    expect(errs[3]).toMatch(/Duplicado en el archivo \(igual a la fila 3\)/);
    expect(errs[4]).toMatch(/"Cantidad": Máximo 100\./);
  });

  it("error general si falta una columna obligatoria o no hay datos", () => {
    expect(parseImportGrid([["Cantidad"], ["1"]], COLS).fatalError).toMatch(/Faltan columnas obligatorias: "Nombre"/);
    expect(parseImportGrid([["Nombre"], ["", ""]], COLS).fatalError).toMatch(/no tiene filas de datos/);
    expect(parseImportGrid([], COLS).fatalError).toMatch(/vacío/);
  });
});

describe("plantilla y archivo", () => {
  it("la plantilla trae hoja de datos con * y lista desplegable, y hoja Instrucciones", async () => {
    const sheets = templateSheets(DEF);
    expect(sheets.map((s) => s.name)).toEqual(["Datos", "Instrucciones"]);
    expect(sheets[0]!.columns[0]!.header).toBe("Nombre *");
    expect(sheets[0]!.columns.find((c) => c.key === "store")!.options).toEqual(["Centro", "Norte"]);
    expect(sheets[1]!.rows.some((r) => r.col === "Nombre" && r.req === "Sí")).toBe(true);

    const wb = buildWorkbook(sheets);
    const storeCol = sheets[0]!.columns.findIndex((c) => c.key === "store") + 1;
    expect(wb.getWorksheet("Datos")!.getCell(2, storeCol).dataValidation?.type).toBe("list");

    // La plantilla con su ejemplo se vuelve a leer sin errores (hoja de datos, no Instrucciones).
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const back = await parseImportFile(DEF, buf);
    expect(back.fatalError).toBeNull();
    expect(back.rows).toHaveLength(1);
    expect(back.rows[0]!.errors).toEqual([]);
    expect(back.rows[0]!.data.day).toBe("2026-02-01");
  });

  it("cada importación del catálogo: su plantilla de ejemplo es válida", async () => {
    for (const def of IMPORT_DEFINITIONS) {
      const ctx = { priceLists: ["Mayorista"], stores: ["Centro"] };
      const wb = buildWorkbook(templateSheets(def, ctx));
      const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
      const res = await parseImportFile(def, buf, ctx);
      expect(res.fatalError, def.entity).toBeNull();
      for (const r of res.rows) expect(r.errors, `${def.entity} fila ${r.rowNumber}`).toEqual([]);
      expect(def.rpc).toBe(`import_${def.entity}`);
    }
  });

  it("lee una hoja por nombre en un archivo con varias (export de base completa)", async () => {
    const wb = buildWorkbook([
      { name: "Otra", columns: [{ header: "X", key: "x" }], rows: [{ x: 1 }] },
      { name: "Datos", title: "Base completa", columns: [{ header: "Nombre", key: "n" }], rows: [{ n: "Uno" }] },
    ]);
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const res = await parseXlsx<Row>(buf, COLS, { sheetName: "datos" });
    expect(res.rows.map((r) => r.data.name)).toEqual(["Uno"]);
  });
});

describe("lotes y resultado del servidor", () => {
  const parsed = parseImportGrid<Row>(
    [["Nombre", "Fecha"], ["A", "01/01/2026"], [""], ["", ""], ["B", ""], ["C", ""]],
    COLS,
  );

  it("sólo viajan las filas válidas, con su número de fila y el payload de la definición", () => {
    const payloads = buildPayloads(DEF, parsed.rows);
    expect(payloads.map((p) => p._row)).toEqual([2, 5, 6]);
    expect(payloads[0]).toMatchObject({ name: "A", effective_at: "2026-01-01" });
    expect(payloads[0]).not.toHaveProperty("day");
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("une lotes y arma el destino de cada fila con mensajes simples", () => {
    const server = mergeServerResults([
      { applied: false, created: 1, updated: 0, skipped: 0, errors: 0, rows: [{ row: 2, action: "create", message: null }] },
      {
        applied: false,
        created: 0,
        updated: 1,
        skipped: 0,
        errors: 1,
        rows: [
          { row: 5, action: "update", message: "stock_ignored" },
          { row: 6, action: "error", message: "feature_not_in_plan: listas_precios" },
        ],
      },
    ] as ServerImportResult[]);
    expect(server).toMatchObject({ created: 1, updated: 1, errors: 1 });
    const withLocalError = [...parsed.rows, { rowNumber: 9, data: { name: "" } as Row, errors: ["Falta \"Nombre\"."] }];
    const outcomes = buildOutcomes(withLocalError, server);
    expect(outcomes.map((o) => o.action)).toEqual(["create", "update", "error", "error"]);
    expect(outcomes[1]!.messages[0]).toMatch(/importación de stock/);
    expect(outcomes[2]!.messages[0]).toBe("Tu plan no incluye las listas de precios.");
    expect(countOutcomes(outcomes)).toEqual({ create: 1, update: 1, skip: 0, error: 2 });

    const report = errorReportSheets(DEF, outcomes);
    expect(report[0]!.rows.map((r) => r.__row)).toEqual([6, 9]);
    expect(report[0]!.columns.slice(0, 2).map((c) => c.header)).toEqual(["Fila", "Motivo"]);
  });

  it("antes de revisar en el servidor todas las válidas figuran como a crear", () => {
    expect(countOutcomes(buildOutcomes(parsed.rows, null))).toEqual({ create: 3, update: 0, skip: 0, error: 0 });
  });
});

describe("mensajes", () => {
  it("traduce códigos, límites de plan y constraints", () => {
    expect(importErrorMessage("import_product_not_found")).toMatch(/SKU o código de barras/);
    expect(importErrorMessage("plan_limit: max_stores")).toMatch(/máximo de sucursales/);
    expect(importErrorMessage('duplicate key value violates unique constraint "products_tenant_sku_idx"')).toMatch(/SKU/);
    expect(importErrorMessage("forbidden")).toMatch(/dueño o un encargado/);
    expect(importErrorMessage("algo raro")).toMatch(/algo raro/);
    expect(importNoteMessage("unchanged")).toMatch(/Sin cambios/);
    expect(importNoteMessage(null)).toBeNull();
  });
});
