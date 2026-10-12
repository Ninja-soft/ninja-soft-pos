import { describe, expect, it } from "vitest";
import {
  amountInWords,
  autoAllocate,
  headerMethod,
  methodNeedsTreasury,
  openAfter,
  paymentOrderTotals,
  validatePaymentOrder,
  type OpenInvoice,
} from "@/lib/purchases/paymentOrders";
import { supplierAging, type AccountEntry } from "@/lib/purchases/aging";

const docs: OpenInvoice[] = [
  { invoice_id: "b", label: "A 00001-00000002", issue_date: "2026-09-10", due_date: "2026-10-10", amount_ars: 500, open_ars: 500 },
  { invoice_id: "a", label: "A 00001-00000001", issue_date: "2026-09-01", due_date: "2026-10-01", amount_ars: 1000, open_ars: 800 },
  { invoice_id: "c", label: "A 00001-00000003", issue_date: "2026-09-20", due_date: "2026-10-20", amount_ars: 300, open_ars: 0 },
];

const ctx = { openDocs: docs, hasTreasury: true, hasOpenShift: true };

describe("orden de pago: totales e imputación", () => {
  it("total = medios + retenciones; lo no imputado queda a cuenta", () => {
    const t = paymentOrderTotals(
      [{ amount: 700 }, { amount: 250.5 }],
      [{ kind: "iibb", amount: 49.5 }],
      [{ invoice_id: "a", amount: 800 }],
    );
    expect(t).toEqual({ net: 950.5, withholdings: 49.5, total: 1000, allocated: 800, onAccount: 200 });
  });

  it("imputación automática por vencimiento, el más viejo primero, con pago parcial", () => {
    expect(autoAllocate(1000, docs)).toEqual([
      { invoice_id: "a", amount: 800 },
      { invoice_id: "b", amount: 200 },
    ]);
  });

  it("si el pago supera la deuda, imputa todo y el resto queda a cuenta", () => {
    const al = autoAllocate(2000, docs);
    expect(al.reduce((t, a) => t + a.amount, 0)).toBe(1300);
    expect(al.map((a) => a.invoice_id)).toEqual(["a", "b"]);
  });

  it("saldo de cada comprobante después de imputar", () => {
    const m = openAfter(docs, [{ invoice_id: "b", amount: 120.25 }]);
    expect(m.get("b")).toBe(379.75);
    expect(m.get("a")).toBe(800);
  });

  it("valida sobre-imputación por comprobante y por total", () => {
    const over = validatePaymentOrder(
      { lines: [{ method: "transferencia", amount: 1000 }], withholdings: [], allocations: [{ invoice_id: "b", amount: 501 }] },
      ctx,
    );
    expect(over).toContain("Imputaste más que el saldo de un comprobante.");

    const overTotal = validatePaymentOrder(
      { lines: [{ method: "transferencia", amount: 100 }], withholdings: [], allocations: [{ invoice_id: "a", amount: 200 }] },
      ctx,
    );
    expect(overTotal).toContain("Imputaste más que el total de la orden.");

    const unknown = validatePaymentOrder(
      { lines: [{ method: "otro", amount: 10 }], withholdings: [], allocations: [{ invoice_id: "zz", amount: 5 }] },
      ctx,
    );
    expect(unknown).toContain("Hay un comprobante que no se puede imputar.");
  });

  it("efectivo exige caja abierta y los cheques exigen tesorería", () => {
    const noShift = validatePaymentOrder(
      { lines: [{ method: "efectivo", amount: 10 }], withholdings: [], allocations: [] },
      { ...ctx, hasOpenShift: false },
    );
    expect(noShift).toContain("Para pagar en efectivo tenés que tener tu caja abierta.");

    const noTreasury = validatePaymentOrder(
      {
        lines: [{ method: "cheque_propio", amount: 10, treasury_account_id: "x", cheque: { number: "1", payment_date: "2026-11-01" } }],
        withholdings: [],
        allocations: [],
      },
      { ...ctx, hasTreasury: false },
    );
    expect(noTreasury).toContain("Los cheques y las cuentas bancarias requieren Tesorería en tu plan.");
    expect(methodNeedsTreasury("transferencia", false)).toBe(false);
    expect(methodNeedsTreasury("transferencia", true)).toBe(true);
  });

  it("cheque de terceros: tiene que estar en cartera y por su importe", () => {
    const wallet = new Map([["ch1", 200]]);
    const wrong = validatePaymentOrder(
      { lines: [{ method: "cheque_tercero", amount: 150, cheque_id: "ch1" }], withholdings: [], allocations: [] },
      { ...ctx, chequesInWallet: wallet },
    );
    expect(wrong).toContain("El importe del cheque de terceros tiene que ser el del cheque.");
    const ok = validatePaymentOrder(
      { lines: [{ method: "cheque_tercero", amount: 200, cheque_id: "ch1" }], withholdings: [], allocations: [] },
      { ...ctx, chequesInWallet: wallet },
    );
    expect(ok).toEqual([]);
  });

  it("método de la cabecera: único, cheque o mixto", () => {
    expect(headerMethod([{ method: "efectivo" }])).toBe("efectivo");
    expect(headerMethod([{ method: "cheque_tercero" }])).toBe("cheque");
    expect(headerMethod([{ method: "efectivo" }, { method: "transferencia" }])).toBe("mixto");
  });

  it("importe en letras para la orden impresa", () => {
    expect(amountInWords(1250.5)).toBe("mil doscientos cincuenta con 50/100");
    expect(amountInWords(21000)).toBe("veintiún mil con 00/100");
    expect(amountInWords(1_000_000)).toBe("un millón con 00/100");
    expect(amountInWords(100)).toBe("cien con 00/100");
  });
});

describe("aging con imputación explícita", () => {
  const entries: AccountEntry[] = [
    { doc_id: "f1", entry_type: "invoice", doc_label: "F1", doc_date: "2026-09-01", due_date: "2026-09-30", amount_ars: 1000 },
    { doc_id: "f2", entry_type: "invoice", doc_label: "F2", doc_date: "2026-09-15", due_date: "2026-10-15", amount_ars: 500 },
    { doc_id: "p1", entry_type: "payment", doc_label: "OP-1", doc_date: "2026-10-01", due_date: "2026-10-01", amount_ars: -500 },
  ];

  it("sin imputación el pago cancela el más viejo (FIFO)", () => {
    const r = supplierAging(entries, "2026-10-20");
    expect(r.open.map((o) => [o.doc_id, o.open])).toEqual([
      ["f1", 500],
      ["f2", 500],
    ]);
  });

  it("con imputación a F2 el pago cancela F2 y F1 queda entera", () => {
    const r = supplierAging(entries, "2026-10-20", [{ invoice_id: "f2", amount: 500 }]);
    expect(r.open.map((o) => [o.doc_id, o.open])).toEqual([["f1", 1000]]);
    expect(r.balance).toBe(1000);
  });
});
