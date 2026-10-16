import { describe, expect, it } from "vitest";
import {
  BANK_PRESETS,
  bankPreset,
  findStatementHeader,
  guessStatementMapping,
  mappingReady,
  statementDate,
  statementRowsToLines,
  statementTotals,
} from "@/lib/treasury/bankStatement";

// Extracto bancario (F23 · H152, ADR-162): presets, mapeo y renglones.

describe("presets de bancos", () => {
  it("hay presets de los bancos más usados y uno genérico al final", () => {
    const keys = BANK_PRESETS.map((p) => p.key);
    for (const k of ["galicia", "santander", "bbva", "macro", "nacion", "provincia", "mercadopago", "otro"]) {
      expect(keys).toContain(k);
    }
    expect(keys[keys.length - 1]).toBe("otro");
    expect(bankPreset("no-existe").key).toBe("otro");
    for (const p of BANK_PRESETS) expect(p.hint.length).toBeGreaterThan(10);
  });

  it("Galicia: débitos y créditos separados, sin columna de importe", () => {
    const header = ["Fecha", "Descripción", "Origen", "Débitos", "Créditos", "Número de Comprobante", "Saldo"];
    const m = guessStatementMapping(header, "galicia");
    expect(m.date).toBe(0);
    expect(m.description).toBe(1);
    expect(m.debit).toBe(3);
    expect(m.credit).toBe(4);
    expect(m.reference).toBe(5);
    expect(m.balance).toBe(6);
    expect(m.amount).toBeUndefined();
    expect(mappingReady(m)).toBe(true);
  });

  it("Nación: una sola columna de importe con signo", () => {
    const m = guessStatementMapping(["Fecha", "Comprobante", "Concepto", "Importe", "Saldo"], "nacion");
    expect(m).toMatchObject({ date: 0, reference: 1, description: 2, amount: 3, balance: 4 });
  });

  it("Mercado Pago: créditos y débitos netos del reporte de dinero disponible", () => {
    const m = guessStatementMapping(
      ["DATE", "SOURCE_ID", "DESCRIPTION", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT", "BALANCE_AMOUNT"],
      "mercadopago",
    );
    expect(m).toMatchObject({ date: 0, reference: 1, description: 2, credit: 3, debit: 4, balance: 5 });
  });

  it("encuentra el encabezado aunque el archivo tenga un preámbulo", () => {
    const grid = [
      ["Banco Galicia"],
      ["Cuenta Corriente en Pesos 1234-5"],
      [""],
      ["Fecha", "Descripción", "Débitos", "Créditos", "Saldo"],
      ["01/10/2026", "TRANSF RECIBIDA", "", "1.500,00", "10.000,00"],
    ];
    expect(findStatementHeader(grid, "galicia")).toBe(3);
    expect(mappingReady({ date: 0 })).toBe(false);
  });
});

describe("renglones del extracto", () => {
  it("fecha argentina en distintos formatos", () => {
    expect(statementDate("01/10/2026")).toBe("2026-10-01");
    expect(statementDate("2026-10-01")).toBe("2026-10-01");
    expect(statementDate("1/9/26")).toBe("2026-09-01");
    expect(statementDate("")).toBeNull();
    expect(statementDate("no es fecha")).toBeNull();
  });

  it("débitos negativos, créditos positivos, saldo y referencia; omite saldos y filas vacías", () => {
    const map = { date: 0, description: 1, debit: 2, credit: 3, balance: 4, reference: 5 };
    const r = statementRowsToLines(
      [
        ["30/09/2026", "Saldo anterior", "", "", "8.500,00", ""],
        ["01/10/2026", "TRANSF RECIBIDA", "", "1.500,00", "10.000,00", "op-1"],
        ["02/10/2026", "COMISION MANTENIMIENTO", "150,00", "", "9.850,00", ""],
        ["", "", "", "", "", ""],
        ["03/10/2026", "SIN IMPORTE", "", "", "9.850,00", ""],
      ],
      map,
    );
    expect(r[0]!.skip).toMatch(/saldo/i);
    expect(r[1]!.line).toEqual({ date: "2026-10-01", description: "TRANSF RECIBIDA", reference: "op-1", amount: 1500, balance: 10000 });
    expect(r[2]!.line?.amount).toBe(-150);
    expect(r[3]!.skip).toBeTruthy();
    expect(r[4]!.skip).toBe("Sin importe");
    expect(r[1]!.row).toBe(3);
  });

  it("importe con signo en una columna", () => {
    const r = statementRowsToLines([["2026-10-05", "PAGO PROVEEDOR", "-2.000,50"]], { date: 0, description: 1, amount: 2 });
    expect(r[0]!.line?.amount).toBe(-2000.5);
  });

  it("totales de la vista previa", () => {
    const t = statementTotals([
      { date: "2026-10-02", description: null, reference: null, amount: 100, balance: null },
      { date: "2026-10-01", description: null, reference: null, amount: -40.5, balance: null },
    ]);
    expect(t).toEqual({ in: 100, out: 40.5, count: 2, from: "2026-10-01", to: "2026-10-02" });
  });
});
