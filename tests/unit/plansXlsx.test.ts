import { describe, it, expect } from "vitest";
import { buildWorkbook } from "@/lib/utils/xlsxWorkbook";
import { parsePlansXlsx } from "@/modules/pos/plansXlsx";

async function buf(rows: Array<Record<string, unknown>>, headers: string[]) {
  const wb = buildWorkbook([
    { name: "Planes", title: "Planes", columns: headers.map((h) => ({ header: h, key: h })), rows },
  ]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("parsePlansXlsx", () => {
  it("acepta tipo y marca con sus nombres (como los ofrece la lista desplegable)", async () => {
    const { rows, errors } = await parsePlansXlsx(
      await buf(
        [
          { tipo: "Crédito", marca: "Mastercard", cuotas: 3, recargo: 9 },
          { tipo: "Débito", marca: "Visa", cuotas: 1, recargo: 0 },
        ],
        ["tipo", "marca", "cuotas", "recargo"],
      ),
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.base, r.brand, r.installments, r.surcharge_pct])).toEqual([
      ["credito", "master", 3, 9],
      ["debito", "visa", 1, 0],
    ]);
  });

  it("lee el n° de comercio opcional por marca (el primero cargado gana)", async () => {
    const { merchantNumbers } = await parsePlansXlsx(
      await buf(
        [
          { base: "credito", marca: "visa", cuotas: 3, recargo: 9, "n° de comercio": "12.345.678" },
          { base: "credito", marca: "visa", cuotas: 6, recargo: 18, "n° de comercio": "" },
          { base: "debito", marca: "master", cuotas: 1, recargo: 0, "n° de comercio": "" },
        ],
        ["base", "marca", "cuotas", "recargo", "n° de comercio"],
      ),
    );
    expect(merchantNumbers).toEqual({ visa: "12345678" });
  });
});
