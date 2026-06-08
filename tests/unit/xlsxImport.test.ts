import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsx";
import {
  parseXlsx,
  validRows,
  countRows,
  type ImportColumn,
} from "@/lib/utils/xlsxImport";

interface Row {
  name: string;
  qty: number | null;
  flag: boolean | null;
}

const SPEC: ImportColumn[] = [
  { header: "name", key: "name", type: "text", required: true },
  { header: "qty", key: "qty", type: "number", aliases: ["cantidad"] },
  { header: "flag", key: "flag", type: "boolean" },
];

async function bufFrom(
  rows: Array<Record<string, unknown>>,
  headers = ["name", "qty", "flag"],
) {
  const wb = buildWorkbook([
    {
      name: "S",
      columns: headers.map((h) => ({ header: h, key: h })),
      rows,
    },
  ]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parseXlsx (helper genérico)", () => {
  it("tipa números y booleanos y respeta required", async () => {
    const buf = await bufFrom([
      { name: "ok", qty: "3", flag: "si" },
      { name: "", qty: "1", flag: "no" },
    ]);
    const res = await parseXlsx<Row>(buf, SPEC);
    expect(res.fatalError).toBeNull();
    const ok = validRows(res);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.qty).toBe(3);
    expect(ok[0]!.flag).toBe(true);
    expect(res.rows[1]!.errors.join(" ")).toMatch(/name/i);
  });

  it("reporta error de tipo en celdas no numéricas / no booleanas", async () => {
    const buf = await bufFrom([{ name: "x", qty: "abc", flag: "quizas" }]);
    const res = await parseXlsx<Row>(buf, SPEC);
    expect(countRows(res).invalid).toBe(1);
    const e = res.rows[0]!.errors.join(" ");
    expect(e).toMatch(/no es un número/i);
    expect(e).toMatch(/no es sí\/no/i);
  });

  it("resuelve columnas por alias", async () => {
    const buf = await bufFrom([{ name: "x", cantidad: "9" }], ["name", "cantidad"]);
    const res = await parseXlsx<Row>(buf, SPEC);
    expect(validRows(res)[0]!.qty).toBe(9);
  });

  it("detecta duplicados por dedupeKey", async () => {
    const buf = await bufFrom([
      { name: "Pepe" },
      { name: "pepe" }, // case-insensitive
    ]);
    const res = await parseXlsx<Row>(buf, SPEC, { dedupeKey: "name" });
    expect(res.rows[1]!.errors.join(" ")).toMatch(/duplicado/i);
  });

  it("fatalError cuando falta una columna requerida", async () => {
    const buf = await bufFrom([{ qty: "1" }], ["qty"]);
    const res = await parseXlsx<Row>(buf, SPEC);
    expect(res.fatalError).toMatch(/name/i);
  });

  it("fatalError ante un archivo corrupto", async () => {
    const bad = new TextEncoder().encode("xxx").buffer;
    const res = await parseXlsx<Row>(bad, SPEC);
    expect(res.fatalError).toBeTruthy();
  });
});
