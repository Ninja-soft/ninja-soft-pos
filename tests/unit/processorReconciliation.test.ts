import { describe, expect, it } from "vitest";
import {
  dailySeries,
  feeBreakdown,
  filterLines,
  guessMapping,
  moneyState,
  parseAmount,
  parseArDate,
  parseCsv,
  rowsToLines,
  summarize,
  summarySentences,
  toImportPayload,
  xlsxLineRows,
  type SettlementLineRow,
} from "@/lib/reports/processorReconciliation";

const NOW = new Date("2026-10-12T15:00:00Z");

const line = (over: Partial<SettlementLineRow> & { id: string }): SettlementLineRow => ({
  provider_key: "mercadopago",
  scope_store_id: null,
  external_id: over.id,
  order_id: null,
  external_reference: null,
  kind: "payment",
  status: "approved",
  operation_at: "2026-10-10T15:00:00Z",
  release_date: null,
  released: false,
  gross: 1000,
  fee: 50,
  taxes: 10,
  net: 940,
  refunded: 0,
  payment_method: "visa",
  payment_type: "credit_card",
  card_brand: "Visa",
  last4: "1234",
  installments: 1,
  lote: null,
  cupon: null,
  autorizacion: null,
  comercio: null,
  terminal: null,
  description: null,
  payer: null,
  fee_detail: [],
  payment_id: null,
  intent_id: null,
  sale_id: null,
  match_status: "matched",
  match_method: "provider_id",
  diff_amount: 0,
  review_note: null,
  reviewed_at: null,
  ...over,
});

describe("resumen para el dueño", () => {
  const lines = [
    line({ id: "a", released: true }),
    line({ id: "b", release_date: "2026-10-20T15:00:00Z", gross: 2000, fee: 100, taxes: 20, net: 1880 }),
    line({ id: "c", release_date: "2026-10-15T15:00:00Z", match_status: "missing_in_pos" }),
    line({ id: "d", match_status: "amount_diff", refunded: 400, gross: 1000, fee: 0, taxes: 0, net: 600, released: true }),
  ];
  const s = summarize(lines, [{ payment_id: "p", sale_id: "s", intent_id: null, provider_key: "mercadopago", amount: 300, created_at: "" }], NOW);

  it("suma vendido, cobrado, acreditado y pendiente", () => {
    expect(s.sold).toBe(4600);
    expect(s.fees).toBe(200);
    expect(s.taxes).toBe(40);
    expect(s.charged).toBe(240);
    expect(s.released).toBe(1540);
    expect(s.pending).toBe(2820);
    expect(s.nextRelease).toBe("2026-10-15T15:00:00Z");
    expect(s.pendingByDay.map((d) => d.amount)).toEqual([940, 1880]);
    expect(s.counts).toEqual({ matched: 2, amount_diff: 1, missing_in_pos: 1, ignored: 0, pos_only: 1 });
    expect(s.amounts.pos_only).toBe(300);
    expect(s.costPct).toBe(5.22);
  });

  it("arma las frases en lenguaje simple", () => {
    const f = summarySentences(s, "mercadopago", (n) => `$${n}`, (iso) => iso.slice(0, 10));
    expect(f[0]).toBe("Vendiste $4600 con Mercado Pago.");
    expect(f[1]).toContain("te cobró $240 de comisiones e impuestos");
    expect(f[2]).toBe("Te acreditó $1540.");
    expect(f[3]).toBe("Falta acreditar $2820, lo próximo el 2026-10-15.");
    expect(f[4]).toBe("Hay 3 cobros para revisar.");
    expect(summarySentences(summarize([]), "payway", String, String)).toEqual(["No hay cobros de Payway en este período."]);
  });

  it("estado de la plata y filtros", () => {
    expect(moneyState(lines[0]!, NOW)).toBe("released");
    expect(moneyState(lines[1]!, NOW)).toBe("pending");
    expect(moneyState(line({ id: "x", release_date: "2026-10-01T00:00:00Z" }), NOW)).toBe("released");
    expect(moneyState(line({ id: "y" }), NOW)).toBe("unknown");
    expect(filterLines(lines, "exceptions", NOW).map((l) => l.id)).toEqual(["c", "d"]);
    expect(filterLines(lines, "pending_money", NOW).map((l) => l.id)).toEqual(["b", "c"]);
    expect(filterLines(lines, "pos_only", NOW)).toEqual([]);
  });

  it("series y desglose de comisiones", () => {
    const d = dailySeries(lines);
    expect(d.days).toHaveLength(1);
    expect(d.fees[0]).toBe(200);
    expect(
      feeBreakdown([
        line({ id: "f", fee_detail: [{ label: "Comisión de Mercado Pago", amount: 30, kind: "fee" }, { label: "IVA", amount: 6, kind: "tax" }] }),
        line({ id: "g" }),
      ]),
    ).toEqual([
      { label: "Comisiones", value: 50 },
      { label: "Comisión de Mercado Pago", value: 30 },
      { label: "Impuestos", value: 10 },
      { label: "IVA", value: 6 },
    ]);
  });

  it("filas del XLSX", () => {
    const rows = xlsxLineRows([lines[3]!], () => "0001-00000012", NOW);
    expect(rows[0]).toMatchObject({ estado: "Diferencia de monto", plata: "Acreditado", venta: "0001-00000012", devuelto: 400 });
  });
});

describe("importación de archivos", () => {
  it("parsea números argentinos e internacionales", () => {
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
    expect(parseAmount("$ -12,5")).toBe(-12.5);
    expect(parseAmount("(100,00)")).toBe(-100);
    expect(parseAmount("1.234.567")).toBe(1234567);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(42)).toBe(42);
  });

  it("parsea fechas en hora de Argentina", () => {
    expect(parseArDate("10/10/2026 14:30")).toBe("2026-10-10T17:30:00.000Z");
    expect(parseArDate("10/10/26")).toBe("2026-10-10T15:00:00.000Z");
    expect(parseArDate("2026-10-10")).toBe("2026-10-10T15:00:00.000Z");
    expect(parseArDate("31/02/2026")).toBeNull();
    expect(parseArDate("")).toBeNull();
  });

  it("CSV con punto y coma y comillas", () => {
    expect(parseCsv('Fecha;Importe;"Nota; con punto"\n10/10/2026;"1.000,00";x\r\n\n')).toEqual([
      ["Fecha", "Importe", "Nota; con punto"],
      ["10/10/2026", "1.000,00", "x"],
    ]);
  });

  it("sugiere el mapeo por encabezado y arma las líneas", () => {
    const header = ["Fecha de operación", "Nro. Lote", "Cupón", "Nro. Comercio", "Importe bruto", "Arancel", "Retenciones", "Importe neto", "Fecha de pago"];
    const map = guessMapping(header);
    expect(map).toMatchObject({ operation_at: 0, lote: 1, cupon: 2, comercio: 3, gross: 4, fee: 5, taxes: 6, net: 7, release_date: 8 });
    const res = rowsToLines("payway", [
      ["10/10/2026", "015", "0042", "12345678", "1.000,00", "-18,00", "-3,78", "978,22", "12/10/2026"],
      ["sin fecha", "", "", "", "1", "", "", "", ""],
    ], map);
    expect(res[0]!.line).toMatchObject({ provider_key: "payway", gross: 1000, fee: 18, taxes: 3.78, net: 978.22, lote: "015", cupon: "0042", comercio: "12345678" });
    expect(res[0]!.line!.fee_detail).toHaveLength(2);
    expect(res[1]).toMatchObject({ line: null, error: "Fecha inválida", row: 3 });
    const payload = toImportPayload([res[0]!.line!]);
    expect(payload[0]).not.toHaveProperty("line_key");
  });

  it("sin neto lo calcula", () => {
    const res = rowsToLines("otro", [["10/10/2026", "500", "10"]], { operation_at: 0, gross: 1, fee: 2 });
    expect(res[0]!.line!.net).toBe(490);
  });
});
