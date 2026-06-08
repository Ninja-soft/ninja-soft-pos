import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsx";
import {
  parseCustomersXlsx,
  CUSTOMER_IMPORT_COLUMNS,
} from "@/modules/customers/import";
import { validRows, countRows } from "@/lib/utils/xlsxImport";

async function xlsxBuffer(rows: Array<Record<string, unknown>>) {
  const wb = buildWorkbook([
    { name: "Clientes", columns: CUSTOMER_IMPORT_COLUMNS, rows },
  ]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parseCustomersXlsx", () => {
  it("lee clientes válidos y marca sin nombre con error", async () => {
    const buf = await xlsxBuffer([
      { name: "Juan Pérez", document_number: "30123456", email: "j@e.com" },
      { name: "", phone: "111" },
    ]);
    const res = await parseCustomersXlsx(buf);
    expect(res.fatalError).toBeNull();
    expect(countRows(res).valid).toBe(1);
    expect(countRows(res).invalid).toBe(1);
    expect(validRows(res)[0]!.name).toBe("Juan Pérez");
  });

  it("normaliza tipo de documento e IVA por etiqueta a enum interno", async () => {
    const buf = await xlsxBuffer([
      {
        name: "Empresa SA",
        document_type: "DNI",
        document_number: "30123456",
        iva_condition: "Consumidor Final",
      },
    ]);
    const ok = validRows(await parseCustomersXlsx(buf));
    expect(ok[0]!.document_type).toBe("dni");
    expect(ok[0]!.iva_condition).toBe("consumidor_final");
  });

  it("rechaza tipo de documento desconocido con error por fila", async () => {
    const buf = await xlsxBuffer([
      { name: "X", document_type: "Patente", document_number: "1" },
    ]);
    const res = await parseCustomersXlsx(buf);
    expect(countRows(res).invalid).toBe(1);
    expect(res.rows[0]!.errors.join(" ")).toMatch(/documento no reconocido/i);
  });

  it("valida dígito verificador de CUIT", async () => {
    const buf = await xlsxBuffer([
      { name: "Mala", document_type: "CUIT", document_number: "20111111110" },
      { name: "Buena", document_type: "CUIT", document_number: "20111111112" },
    ]);
    const res = await parseCustomersXlsx(buf);
    // 20-11111111-2 es un CUIT con DV válido; el otro no.
    const errs = res.rows.map((r) => r.errors.join(" "));
    expect(errs[0]).toMatch(/CUIT inválido/i);
  });

  it("valida email", async () => {
    const buf = await xlsxBuffer([
      { name: "A", email: "no-es-email" },
    ]);
    const res = await parseCustomersXlsx(buf);
    expect(res.rows[0]!.errors.join(" ")).toMatch(/email inválido/i);
  });

  it("con requireDoc exige tipo y número de documento", async () => {
    const buf = await xlsxBuffer([
      { name: "Sin doc" },
      { name: "Con doc", document_type: "DNI", document_number: "30123456" },
    ]);
    const res = await parseCustomersXlsx(buf, true);
    expect(countRows(res).valid).toBe(1);
    expect(res.rows[0]!.errors.join(" ")).toMatch(/documento/i);
  });

  it("marca documentos duplicados dentro del archivo", async () => {
    const buf = await xlsxBuffer([
      { name: "A", document_number: "30123456" },
      { name: "B", document_number: "30123456" },
    ]);
    const res = await parseCustomersXlsx(buf);
    expect(res.rows[1]!.errors.join(" ")).toMatch(/duplicado/i);
  });
});
