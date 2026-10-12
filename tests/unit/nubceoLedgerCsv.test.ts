import { describe, expect, it } from "vitest";
import {
  ledgerTotals,
  mapColumns,
  parseAmount,
  parseDate,
  parseLedgerCsv,
  splitCsvLine,
} from "@/lib/integrations/nubceo/ledgerCsv";

describe("lector de asientos exportados de NubCeo", () => {
  it("importes y fechas argentinas", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1234.56")).toBe(1234.56);
    expect(parseAmount("-1,5")).toBe(-1.5);
    expect(parseAmount("(100,00)")).toBe(-100);
    expect(parseAmount("$ 2.000")).toBe(2000);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("abc")).toBeNaN();
    expect(parseDate("05/10/2026")).toBe("2026-10-05");
    expect(parseDate("2026-10-05T03:00:00.000-03:00")).toBe("2026-10-05");
    expect(parseDate("31/02/2026")).toBe("");
    expect(parseDate("1-3-26")).toBe("2026-03-01");
  });

  it("comillas y separadores", () => {
    expect(splitCsvLine('a;"b;c";"d ""e"""', ";")).toEqual(["a", "b;c", 'd "e"']);
  });

  it("encabezados en castellano, con tildes y en cualquier orden", () => {
    const c = mapColumns(["Fecha", "Número", "Código de cuenta", "Cuenta contable", "Centro de costo", "Debe", "Haber"]);
    expect(c).toMatchObject({ date: 0, number: 1, account_code: 2, account_name: 3, cost_center: 4, debit: 5, credit: 6 });
  });

  it("agrupa por asiento con Debe y Haber", () => {
    const csv = [
      "Fecha;Número;Categoría;Código de cuenta;Cuenta contable;Debe;Haber",
      "20/05/2025;1;Liquidación;1.1.01;Banco;202.698,93;",
      "20/05/2025;1;Liquidación;4.1.01;Ventas;;202.698,93",
      "21/05/2025;2;Liquidación;1.1.01;Banco;100;",
      "21/05/2025;2;Liquidación;5.1.01;Comisiones;;90",
    ].join("\n");
    const r = parseLedgerCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.rows).toBe(4);
    expect(r.headers).toHaveLength(2);
    const h = r.headers[0]!;
    expect([h.nubceo_id, h.number, h.date, h.category, h.status, h.currency]).toEqual([
      "csv:1:2025-05-20",
      "1",
      "2025-05-20",
      "Liquidación",
      "not_confirmed",
      "ARS",
    ]);
    expect(h.entries.map((e) => e.amount)).toEqual([202698.93, -202698.93]);
    expect(ledgerTotals(h.entries)).toEqual({ debit: 202698.93, credit: 202698.93 });
    expect(r.unbalanced).toEqual(["2"]);
  });

  it("importe con signo, id propio y estado", () => {
    const csv = [
      "id,number,date,ledgerCategory,status,account code,account name,amount,costCenterCode",
      "7cba,1,2025-05-20,settlement,confirmed,Sale-100,Sales,-50.5,CCC",
      "7cba,1,2025-05-20,settlement,confirmed,Bank-1,Bank,50.5,",
    ].join("\r\n");
    const r = parseLedgerCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.headers).toHaveLength(1);
    expect(r.headers[0]).toMatchObject({ nubceo_id: "7cba", status: "confirmed", category: "settlement" });
    expect(r.headers[0]!.entries[0]).toMatchObject({ account_code: "Sale-100", account_name: "Sales", amount: -50.5, cost_center: "CCC" });
    expect(r.unbalanced).toEqual([]);
  });

  it("errores claros por renglón y por columnas faltantes", () => {
    expect(parseLedgerCsv("Fecha;Cuenta\n01/01/2026;x").errors).toEqual([
      "Falta la columna de número o id del asiento.",
      "Falta la columna de importe (o Debe y Haber).",
    ]);
    const r = parseLedgerCsv("Fecha;Número;Cuenta;Importe\nayer;1;x;10\n01/01/2026;2;x;diez\n01/01/2026;3;x;10");
    expect(r.errors).toEqual(["Renglón 2: fecha inválida.", "Renglón 3: importe inválido."]);
    expect(r.headers).toHaveLength(1);
    expect(parseLedgerCsv("").errors).toEqual(["El archivo no tiene renglones."]);
  });
});
