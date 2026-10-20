// F24 · H160 (ADR-179): cobros ampliados. Recibo con varios medios, cheque y
// e-cheq a la cartera, retenciones sufridas en el recibo, efectivo en dólares
// y planes de tarjeta por día de la semana.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocatePayment } from "@/lib/account/allocation";
import {
  chequeForCartera,
  fillReceiptAmounts,
  needsMultiReceipt,
  receiptLineError,
  receiptTotals,
  toReceiptRpcLines,
  type ReceiptLine,
} from "@/lib/account/receipt";
import { checkoutTotals } from "@/lib/pos/checkoutMath";
import { settleUsd, usdNeeded, usdToArs } from "@/lib/pos/usd";
import { resolveTenders, type TenderContext } from "@/lib/pos/tenders";
import { arWeekday, isPlanActive, toSalePayments, weekdaysLabel } from "@/modules/pos/api";
import { countableMethods } from "@/lib/cash/arqueo";

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/20270117100000_h160_cobros.sql"), "utf8");
const fn = (name: string) => {
  const at = SQL.indexOf(`function ${name}(`);
  const i = at > -1 ? at : SQL.indexOf(`function public.${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  return SQL.slice(i, SQL.indexOf("$$;", SQL.indexOf("$$", i) + 2));
};

describe("Criterio H160: $100.000 con efectivo, e-cheq y retención de IIBB", () => {
  const customer = { id: "c1", name: "Fiambrería Don José" };
  const lines: ReceiptLine[] = [
    { kind: "payment", method: "cash", amount: 60000 },
    {
      kind: "payment",
      method: "echeq",
      amount: 38000,
      cheque: { number: "00012345", bank_name: "Banco Galicia", payment_date: "2026-11-20", drawer_cuit: "20-12345678-6" },
    },
    { kind: "retention", tax: "iibb", amount: 2000, jurisdiction: "902", certificate: "A-0001" },
  ];

  it("las líneas cuadran con lo imputado y la deuda queda en cero", () => {
    const t = receiptTotals(lines, 100000, 10);
    expect(t).toMatchObject({ linesTotal: 100000, total: 100000, diff: 0, rounding: 0, balanced: true });
    expect(lines.map(receiptLineError)).toEqual([null, null, null]);
    expect(needsMultiReceipt(lines, t)).toBe(true);

    // Cada línea (también la retención) es un cobro que cancela deuda: el
    // servidor imputa FIFO lo mismo que allocatePayment.
    const debt = [{ id: "v1", kind: "charge" as const, due_date: "2026-10-01", created_at: "2026-09-01", open: 100000 }];
    const r = allocatePayment(debt, t.linesTotal + t.rounding);
    expect(r.unapplied).toBe(0);
    const balance = debt[0]!.open - r.allocations.reduce((a, x) => a + x.amount, 0);
    expect(balance).toBe(0);
  });

  it("el e-cheq entra a la cartera como cheque de terceros en cartera", () => {
    const c = chequeForCartera(lines[1] as Extract<ReceiptLine, { kind: "payment" }>, customer);
    expect(c).toEqual({
      kind: "third_party",
      status: "en_cartera",
      is_echeq: true,
      number: "00012345",
      bank_name: "Banco Galicia",
      payment_date: "2026-11-20",
      amount: 38000,
      drawer_cuit: "20123456786",
      received_from_customer_id: "c1",
      received_from: "Fiambrería Don José",
    });
    expect(chequeForCartera(lines[0] as Extract<ReceiptLine, { kind: "payment" }>, customer)).toBeNull();
  });

  it("el payload del recibo lleva el cheque y la retención con su jurisdicción", () => {
    expect(toReceiptRpcLines(lines)).toEqual([
      { kind: "payment", method: "cash", amount: 60000 },
      {
        kind: "payment",
        method: "echeq",
        amount: 38000,
        cheque: { number: "00012345", payment_date: "2026-11-20", bank_name: "Banco Galicia", drawer_cuit: "20123456786" },
      },
      { kind: "retention", tax: "iibb", amount: 2000, jurisdiction: "902", certificate: "A-0001" },
    ]);
  });

  it("el servidor hace lo mismo: cheque en cartera, retención sufrida y una sola numeración", () => {
    const body = fn("account_collect_multi");
    expect(body).toMatch(/insert into cheques[\s\S]*?'en_cartera', v_cust\.id, left\(v_cust\.name, 120\), v_id/);
    expect(body).toMatch(/perform tax_suffered_register\(jsonb_build_object\([\s\S]*?'cc_movement_id', v_id/);
    expect(body).toMatch(/case when v_main is null then v_receipt end/);
    expect(body).toMatch(/case when v_main is null then v_key end/);
    expect(body).toMatch(/perform account_reconcile\(v_cust\.id\)/);
    expect(body).toMatch(/assert_payment_method_allowed\(v_method, v_tenant\)/);
    // Retenciones: sólo dueño o encargado (y lo que exige tax_suffered_register).
    expect(body).toMatch(/v_has_ret and v_role not in \('owner', 'manager'\)/);
    // Idempotente.
    expect(body).toMatch(/idempotency_key = v_key[\s\S]*?'idempotent', true/);
  });
});

describe("Recibo con varios medios", () => {
  it("redondeo dentro de la tolerancia, fuera no", () => {
    const l: ReceiptLine[] = [
      { kind: "payment", method: "cash", amount: 50000 },
      { kind: "payment", method: "transfer", amount: 49992 },
    ];
    expect(receiptTotals(l, 100000, 10)).toMatchObject({ diff: 8, rounding: 8, balanced: true });
    expect(receiptTotals(l, 100000, 5)).toMatchObject({ diff: 8, rounding: 0, balanced: false });
    // De más: ajuste en contra del cliente.
    expect(receiptTotals(l, 99990, 10)).toMatchObject({ diff: -2, rounding: -2, balanced: true });
    // Sin total: cancela lo que suman los medios.
    expect(receiptTotals(l, null)).toMatchObject({ total: 99992, diff: 0, balanced: true });
  });

  it("la primera línea vacía toma lo que falta", () => {
    expect(fillReceiptAmounts([null], 1000)).toEqual([1000]);
    expect(fillReceiptAmounts([600, null, null], 1000)).toEqual([600, 400, 0]);
    expect(fillReceiptAmounts([1200, null], 1000)).toEqual([1200, 0]);
  });

  it("un solo medio común sigue por account_collect", () => {
    const one: ReceiptLine[] = [{ kind: "payment", method: "cash", amount: 100 }];
    expect(needsMultiReceipt(one, receiptTotals(one, 100))).toBe(false);
    expect(needsMultiReceipt(one, receiptTotals(one, 105, 10))).toBe(true);
    const chq: ReceiptLine[] = [{ kind: "payment", method: "cheque", amount: 100, cheque: { number: "1", payment_date: "2026-11-01" } }];
    expect(needsMultiReceipt(chq, receiptTotals(chq, 100))).toBe(true);
  });

  it("valida el cheque y la jurisdicción como el servidor", () => {
    expect(receiptLineError({ kind: "payment", method: "cheque", amount: 10, cheque: { number: " ", payment_date: "2026-11-01" } })).toBe(
      "cheque_data_required",
    );
    expect(receiptLineError({ kind: "payment", method: "echeq", amount: 10, cheque: { number: "1", payment_date: "" } })).toBe(
      "payment_date_required",
    );
    expect(
      receiptLineError({ kind: "payment", method: "cheque", amount: 10, cheque: { number: "1", payment_date: "2026-11-01", drawer_cuit: "20123456789" } }),
    ).toBe("invalid_cuit");
    expect(receiptLineError({ kind: "retention", tax: "iibb", amount: 10 })).toBe("suffered_jurisdiction_required");
    expect(receiptLineError({ kind: "retention", tax: "ganancias", amount: 10 })).toBeNull();
    expect(receiptLineError({ kind: "payment", method: "cash", amount: 0 })).toBe("invalid_amount");
  });

  it("migración: medios nuevos, tolerancia y anulación del recibo completo", () => {
    expect(SQL).toMatch(/cam_method_check check \([\s\S]*?'cheque', 'echeq', 'retention', 'rounding'\)/);
    expect(SQL).toMatch(/receipt_rounding_tolerance numeric not null default 10/);
    expect(fn("account_collect_multi")).toMatch(/abs\(v_diff\) > v_tol then\s+raise exception 'receipt_mismatch'/);
    // El redondeo va a "Diferencias de redondeo".
    expect(fn("acc_sync_cc_movement")).toMatch(/m\.method = 'rounding'[\s\S]*?acc_account_for\(p_tenant, 'redondeo', '\*', v_store\)/);
    // Una línea sola no se anula; el recibo arrastra cheque, retención y caja.
    expect(fn("trg_cam_receipt_line_guard")).toMatch(/raise exception 'receipt_void_whole'/);
    const v = fn("trg_cam_receipt_void");
    expect(v).toMatch(/update cheques set status = 'anulado' where cc_movement_id = new\.id and status = 'en_cartera'/);
    expect(v).toMatch(/update tax_suffered_entries\s+set status = 'voided'/);
    expect(v).toMatch(/'account_payment_void'/);
    // El cheque anulado revierte su ingreso a cartera.
    expect(fn("acc_sync_cheque")).toMatch(/c\.status = 'anulado'[\s\S]*?acc_post_reversal\(p_tenant, 'cheque', c\.id, 'receive', 'void'/);
    // account_collect y create_sale no se reescriben.
    expect(SQL).not.toMatch(/function account_collect\(/);
    expect(SQL).not.toMatch(/function create_sale\(/);
    expect(SQL).not.toMatch(/or is_internal\(\)/);
  });
});

describe("Cheque, e-cheq y dólares en el POS", () => {
  const ctx = (features?: Record<string, boolean>): TenderContext => ({
    providers: [],
    features,
    hasCustomer: false,
    storeCreditBalance: 0,
  });
  const ids = (c: TenderContext) => resolveTenders(c).map((t) => t.id);

  it("sólo con la feature confirmada (tesoreria / efectivo_usd)", () => {
    expect(ids(ctx())).not.toContain("cheque");
    expect(ids(ctx({ tesoreria: false, efectivo_usd: false }))).not.toContain("cash_usd");
    expect(ids(ctx({ tesoreria: true }))).toEqual(expect.arrayContaining(["cheque", "echeq"]));
    expect(ids(ctx({ efectivo_usd: true }))).toContain("cash_usd");
  });

  it("el gating real está en el servidor", () => {
    const k = fn("payment_method_plan_key");
    expect(k).toMatch(/when 'cheque'\s+then 'tesoreria'/);
    expect(k).toMatch(/when 'echeq'\s+then 'tesoreria'/);
    expect(k).toMatch(/when 'cash_usd'\s+then 'efectivo_usd'/);
    // Copia de la definición de Talo (no se pierde ningún medio).
    expect(k).toMatch(/when 'talo'\s+then 'talo'/);
    expect(SQL).toMatch(/'ualabis', 'cheque', 'echeq', 'cash_usd'\)\)/);
    expect(SQL).toMatch(/\('efectivo_usd', 'Efectivo en dólares'[\s\S]*?'pagos', false/);
  });

  it("los datos viajan en card_voucher y el trigger los pasa a la cartera", () => {
    expect(
      toSalePayments([
        { method: "echeq", amount: 38000, cheque: { number: "9", payment_date: "2026-11-20" } },
        { method: "cash_usd", amount: 55000, usd: { amount: 50, rate: 1200 } },
        { method: "cash", amount: 10 },
      ]),
    ).toEqual([
      { method: "echeq", amount: 38000, card_voucher: { cheque: { number: "9", payment_date: "2026-11-20" } } },
      { method: "cash_usd", amount: 55000, card_voucher: { usd: { amount: 50, rate: 1200 } } },
      { method: "cash", amount: 10 },
    ]);
    const after = fn("trg_payments_h160_after");
    expect(after).toMatch(/insert into cheques[\s\S]*?'en_cartera', s\.customer_id/);
    expect(after).toMatch(/'expense', v_chg, 'cash'/);
    expect(fn("trg_payments_h160_extras")).toMatch(/raise exception 'usd_insufficient'/);
  });

  it("dólares: cotización, vuelto en pesos y pago parcial", () => {
    expect(usdToArs(50, 1200)).toBe(60000);
    expect(settleUsd(50, 1200, 55000)).toEqual({ ars: 60000, amount: 55000, change: 5000, covers: true });
    expect(settleUsd(40, 1200, 55000)).toEqual({ ars: 48000, amount: 48000, change: 0, covers: false });
    expect(usdNeeded(55000, 1200)).toBe(46);
    // El vuelto de la hoja suma el de los dólares (en pesos).
    const t = checkoutTotals({
      base: 55000,
      rounding: 0,
      lines: [{ method: "cash_usd", amount: 55000, surcharge: 0, received: 60000 }],
    });
    expect(t).toMatchObject({ settled: true, change: 5000 });
  });

  it("el arqueo espera los dólares en dólares", () => {
    expect(fn("cash_shift_expected_by_method")).toMatch(/select 'cash_usd', sum\(round\(coalesce\(\(p\.metadata -> 'usd' ->> 'amount'\)/);
    expect(countableMethods({ cash_usd: 50, debit: 1000 }).find((m) => m.method === "cash_usd")?.label).toBe(
      "Dólares (en US$)",
    );
  });
});

describe("Planes de tarjeta por día de la semana", () => {
  // 2026-10-20 15:00 UTC = martes 12:00 en Argentina.
  const tuesday = new Date(Date.UTC(2026, 9, 20, 15, 0));
  // 2026-10-21 02:00 UTC = martes 23:00 en Argentina (miércoles en UTC).
  const tuesdayNight = new Date(Date.UTC(2026, 9, 21, 2, 0));

  it("filtra por el día de Argentina", () => {
    expect(arWeekday(tuesday)).toBe(2);
    expect(arWeekday(tuesdayNight)).toBe(2);
    const plan = { valid_from: null, valid_until: null, weekdays: [2, 4] };
    expect(isPlanActive(plan, tuesday)).toBe(true);
    expect(isPlanActive({ ...plan, weekdays: [3] }, tuesday)).toBe(false);
    expect(isPlanActive({ ...plan, weekdays: null }, tuesday)).toBe(true);
    expect(weekdaysLabel([4, 2])).toBe("Mar y Jue");
    expect(weekdaysLabel(null)).toBeNull();
    expect(SQL).toMatch(/weekdays <@ array\[0,1,2,3,4,5,6\]::smallint\[\]/);
  });
});
