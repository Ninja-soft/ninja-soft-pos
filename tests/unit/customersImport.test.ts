import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsx";
import {
  parseCustomersXlsx,
  CUSTOMER_IMPORT_COLUMNS,
} from "@/modules/customers/import";

async function xlsxBuffer(rows: Array<Record<string, unknown>>) {
  const wb = buildWorkbook([
    { name: "Clientes", columns: CUSTOMER_IMPORT_COLUMNS, rows },
  ]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parseCustomersXlsx", () => {
  it("lee clientes válidos y omite sin nombre", async () => {
    const buf = await xlsxBuffer([
      { name: "Juan Pérez", document_number: "30123456", email: "j@e.com" },
      { name: "", phone: "111" },
    ]);
    const res = await parseCustomersXlsx(buf);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]!.name).toBe("Juan Pérez");
    expect(res.rows[0]!.document_number).toBe("30123456");
    expect(res.errors.length).toBe(1);
  });
});
