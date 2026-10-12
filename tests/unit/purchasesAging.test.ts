import { describe, expect, it } from "vitest";
import {
  accountBalance,
  agingBySupplier,
  bucketFor,
  daysBetween,
  ledgerWithRunning,
  supplierAging,
  type AccountEntry,
} from "@/lib/purchases/aging";
import {
  defaultDueDate,
  formatInvoiceNumber,
  invoiceTotals,
  parseInvoiceNumber,
  paymentApplied,
  suggestedLetter,
  validateInvoice,
  type InvoiceDraft,
} from "@/lib/purchases/invoices";
import { formatCuit, isValidAlias, isValidCbu, whatsappLink } from "@/lib/purchases/suppliers";

const e = (
  doc_id: string,
  entry_type: AccountEntry["entry_type"],
  doc_date: string,
  due_date: string,
  amount_ars: number,
  supplier_id = "s1",
): AccountEntry => ({ doc_id, entry_type, doc_label: doc_id, doc_date, due_date, amount_ars, supplier_id });

describe("cuenta corriente de proveedores: saldo y aging", () => {
  const today = "2026-10-12";
  const entries = [
    e("F1", "invoice", "2026-06-01", "2026-06-30", 1000), // 104 días
    e("F2", "invoice", "2026-08-20", "2026-09-01", 500), // 41 días
    e("F3", "invoice", "2026-10-01", "2026-10-31", 300), // a vencer
    e("NC1", "credit_note", "2026-09-10", "2026-09-10", -200),
    e("P1", "payment", "2026-09-15", "2026-09-15", -900),
  ];

  it("saldo = deuda menos pagos y notas de crédito", () => {
    expect(accountBalance(entries)).toBe(700);
  });

  it("aplica créditos FIFO por vencimiento y agrupa lo abierto por atraso", () => {
    const r = supplierAging(entries, today);
    // 1100 de crédito cancelan F1 (1000) y 100 de F2
    expect(r.open.map((d) => [d.doc_id, d.open])).toEqual([
      ["F2", 400],
      ["F3", 300],
    ]);
    expect(r.buckets).toEqual({ current: 300, d1_30: 0, d31_60: 400, d61_90: 0, d90_plus: 0 });
    expect(r.overdue).toBe(400);
    expect(r.credit).toBe(0);
    expect(r.balance).toBe(700);
  });

  it("saldo a favor cuando se pagó de más", () => {
    const r = supplierAging([e("F1", "invoice", "2026-10-01", "2026-10-01", 100), e("P", "payment", "2026-10-02", "2026-10-02", -150)], today);
    expect(r.open).toEqual([]);
    expect(r.credit).toBe(50);
    expect(r.balance).toBe(-50);
  });

  it("buckets por días de atraso", () => {
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(30)).toBe("d1_30");
    expect(bucketFor(31)).toBe("d31_60");
    expect(bucketFor(90)).toBe("d61_90");
    expect(bucketFor(91)).toBe("d90_plus");
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("agrupa por proveedor y arma el saldo acumulado", () => {
    const all = [...entries, e("X1", "invoice", "2026-10-01", "2026-10-05", 50, "s2")];
    const by = agingBySupplier(all, today);
    expect(by.get("s1")?.balance).toBe(700);
    expect(by.get("s2")?.buckets.d1_30).toBe(50);
    const led = ledgerWithRunning(entries);
    expect(led.map((r) => r.running)).toEqual([1000, 1500, 1300, 400, 700]);
  });
});

describe("comprobantes de compra", () => {
  const base: InvoiceDraft = {
    kind: "invoice",
    letter: "A",
    point_of_sale: 3,
    number: 1234,
    issue_date: "2026-10-01",
    due_date: "2026-10-31",
    vat_lines: [
      { rate: 21, net: 1000, vat: 210 },
      { rate: 10.5, net: 200, vat: 21 },
    ],
    exempt_amount: 50,
    non_taxed_amount: 0,
    other_taxes: [{ kind: "percepcion_iibb", jurisdiction: "Buenos Aires", amount: 30 }],
    total: 1511,
  };

  it("suma neto por alícuota, IVA, exento y percepciones", () => {
    expect(invoiceTotals(base)).toEqual({ net: 1200, vat: 231, other: 30, total: 1511 });
    expect(validateInvoice(base).errors).toEqual([]);
  });

  it("el total tiene que cerrar", () => {
    expect(validateInvoice({ ...base, total: 1500 }).errors.join(" ")).toMatch(/no coincide/);
  });

  it("B y C no discriminan IVA", () => {
    const v = validateInvoice({ ...base, letter: "C" });
    expect(v.errors.join(" ")).toMatch(/no discriminan IVA/);
    const ok = validateInvoice({
      ...base,
      letter: "C",
      vat_lines: [{ rate: 0, net: 1000, vat: 0 }],
      exempt_amount: 0,
      other_taxes: [],
      total: 1000,
    });
    expect(ok.errors).toEqual([]);
  });

  it("avisa (sin bloquear) si el IVA no coincide con el neto", () => {
    const v = validateInvoice({ ...base, vat_lines: [{ rate: 21, net: 1000, vat: 200 }], other_taxes: [], exempt_amount: 0, total: 1200 });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(" ")).toMatch(/no coincide con el neto/);
  });

  it("rechaza alícuotas fuera del catálogo y vencimiento anterior", () => {
    const v = validateInvoice({ ...base, vat_lines: [{ rate: 19, net: 100, vat: 19 }], due_date: "2026-09-01", total: 199 });
    expect(v.errors.join(" ")).toMatch(/Alícuota/);
    expect(v.errors.join(" ")).toMatch(/vencimiento/);
  });

  it("número, vencimiento y letra sugerida", () => {
    expect(formatInvoiceNumber("A", 3, 1234)).toBe("A 00003-00001234");
    expect(parseInvoiceNumber("0003-00001234")).toEqual({ pos: 3, number: 1234 });
    expect(parseInvoiceNumber("abc")).toBeNull();
    expect(defaultDueDate("2026-10-01", 30)).toBe("2026-10-31");
    expect(suggestedLetter("monotributo", true)).toBe("C");
    expect(suggestedLetter("responsable_inscripto", true)).toBe("A");
    expect(suggestedLetter("responsable_inscripto", false)).toBe("B");
    expect(suggestedLetter("exterior", true)).toBeNull();
  });

  it("un pago cancela neto pagado más retenciones", () => {
    expect(paymentApplied(950, [{ kind: "ganancias", amount: 50 }])).toBe(1000);
  });
});

describe("datos del proveedor", () => {
  it("CBU con dígitos verificadores y alias", () => {
    expect(isValidCbu("0170099200000000000017")).toBe(true);
    expect(isValidCbu("0170099300000000000017")).toBe(false);
    expect(isValidCbu("123")).toBe(false);
    expect(isValidAlias("ninja.pos.mp")).toBe(true);
    expect(isValidAlias("abc")).toBe(false);
  });

  it("formatea CUIT y arma el link de WhatsApp", () => {
    expect(formatCuit("20123456786")).toBe("20-12345678-6");
    expect(whatsappLink("011 1234-5678", "hola")).toBe("https://wa.me/541112345678?text=hola");
    expect(whatsappLink("12", "x")).toBeNull();
  });
});
