import { describe, expect, it } from "vitest";
import {
  allocateFifo,
  billingErrorMessage,
  billingTotal,
  daysOverdue,
  formatCents,
  formatDay,
  formatPeriod,
  paidPeriodAnchor,
  parsePesosToCents,
  prorationCents,
  statementTotals,
  toCents,
} from "@/lib/billing/ledger";

// Espejo de los casos probados contra Postgres (PGlite) para las migraciones
// 20261113100000/100100: los dos cálculos tienen que dar lo mismo.

describe("billingTotal (subscription_billing_total con descuentos)", () => {
  const pro = { cycle: "monthly", planMonthly: 90000, planYearly: 0, at: "2026-10-14" };

  it("aplica los descuentos: porcentaje sobre el bruto y después el fijo", () => {
    const r = billingTotal({
      ...pro,
      addons: [{ status: "active", source: "purchased", monthly_price_ars: 15000 }],
      discounts: [
        { kind: "percent", value: 10, valid_from: "2026-01-01", valid_until: null },
        { kind: "fixed", value: 5000, valid_from: "2026-01-01", valid_until: null },
      ],
    });
    expect(r.gross).toBe(105000);
    expect(r.discount).toBe(15500);
    expect(r.total).toBe(89500);
  });

  it("ignora descuentos borrados, futuros o vencidos y addons bonificados", () => {
    const r = billingTotal({
      ...pro,
      addons: [{ status: "active", source: "granted", monthly_price_ars: null, catalog_price_ars: 15000 }],
      discounts: [
        { kind: "percent", value: 50, valid_from: "2026-01-01", valid_until: null, deleted_at: "2026-02-01" },
        { kind: "percent", value: 20, valid_from: "2026-11-01", valid_until: null },
        { kind: "fixed", value: 1000, valid_from: "2026-01-01", valid_until: "2026-10-13" },
      ],
    });
    expect(r.total).toBe(90000);
    expect(r.discount).toBe(0);
  });

  it("anual: usa el precio anual y multiplica addons y fijos por 12", () => {
    const r = billingTotal({
      cycle: "yearly",
      planMonthly: 140000,
      planYearly: 1400000,
      at: "2026-10-14",
      addons: [{ status: "active", source: "purchased", monthly_price_ars: 15000 }],
      discounts: [{ kind: "fixed", value: 1000, valid_from: "2026-01-01", valid_until: null }],
    });
    expect(r.planAmount).toBe(1400000);
    expect(r.addonsAmount).toBe(180000);
    expect(r.total).toBe(1400000 + 180000 - 12000);
  });

  it("anual sin precio anual cargado: mensual × 12", () => {
    const r = billingTotal({ cycle: "yearly", planMonthly: 60000, planYearly: 0, at: "2026-10-14", addons: [], discounts: [] });
    expect(r.total).toBe(720000);
  });

  it("los porcentajes topean en 100 % y el total nunca es negativo", () => {
    const r = billingTotal({
      ...pro,
      addons: [],
      discounts: [
        { kind: "percent", value: 80, valid_from: null, valid_until: null },
        { kind: "percent", value: 70, valid_from: null, valid_until: null },
        { kind: "fixed", value: 99999, valid_from: null, valid_until: null },
      ],
    });
    expect(r.percentOff).toBe(100);
    expect(r.total).toBe(0);
  });

  it("redondea el porcentaje al centavo", () => {
    const r = billingTotal({
      cycle: "monthly",
      planMonthly: 33333.33,
      planYearly: 0,
      at: "2026-10-14",
      addons: [],
      discounts: [{ kind: "percent", value: 7, valid_from: null, valid_until: null }],
    });
    expect(toCents(r.discount)).toBe(233333);
    expect(toCents(r.total)).toBe(3333333 - 233333);
  });
});

describe("prorrateo de upgrade (se suma al próximo cobro)", () => {
  it("cobra la diferencia por los días que quedan", () => {
    const p = prorationCents({
      oldCycleAmount: 60000,
      newCycleAmount: 90000,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      today: "2026-10-11",
    });
    expect(p).toEqual({ debitCents: 6000000, creditCents: 4000000, totalCents: 2000000, daysLeft: 20, daysTotal: 30 });
  });

  it("respeta el descuento porcentual vigente", () => {
    const p = prorationCents({
      oldCycleAmount: 60000,
      newCycleAmount: 90000,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      today: "2026-10-11",
      percentOff: 10,
    });
    expect(p?.totalCents).toBe(1800000);
  });

  it("downgrade, período terminado o sin días: no hay prorrateo", () => {
    const base = { periodStart: "2026-10-01", periodEnd: "2026-10-31", today: "2026-10-11" };
    expect(prorationCents({ ...base, oldCycleAmount: 90000, newCycleAmount: 60000 })).toBeNull();
    expect(prorationCents({ ...base, oldCycleAmount: 60000, newCycleAmount: 90000, today: "2026-10-31" })).toBeNull();
    expect(prorationCents({ ...base, oldCycleAmount: 60000, newCycleAmount: 90000, periodEnd: "2026-10-01" })).toBeNull();
  });

  it("si el cambio es el primer día, prorratea el período entero", () => {
    const p = prorationCents({
      oldCycleAmount: 60000,
      newCycleAmount: 90000,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      today: "2026-09-30",
    });
    expect(p?.daysLeft).toBe(30);
    expect(p?.totalCents).toBe(3000000);
  });
});

describe("período pago (pago durante la prueba)", () => {
  const now = new Date("2026-10-14T12:00:00Z");

  it("si paga durante la prueba, el período empieza al terminar la prueba", () => {
    expect(
      paidPeriodAnchor({
        status: "trial",
        trialEndsAt: "2026-10-24T12:00:00Z",
        currentPeriodStart: null,
        currentPeriodEnd: "2026-10-20T12:00:00Z",
        now,
      }).toISOString(),
    ).toBe("2026-10-24T12:00:00.000Z");
  });

  it("si la prueba ya venció o no es prueba, ancla en el vencimiento anterior", () => {
    expect(
      paidPeriodAnchor({
        status: "trial",
        trialEndsAt: "2026-10-10T12:00:00Z",
        currentPeriodStart: null,
        currentPeriodEnd: "2026-10-10T12:00:00Z",
        now,
      }).toISOString(),
    ).toBe("2026-10-10T12:00:00.000Z");
    expect(
      paidPeriodAnchor({
        status: "past_due",
        trialEndsAt: null,
        currentPeriodStart: "2026-09-01T03:00:00Z",
        currentPeriodEnd: "2026-10-01T03:00:00Z",
        now,
      }).toISOString(),
    ).toBe("2026-10-01T03:00:00.000Z");
  });
});

describe("imputación FIFO", () => {
  it("paga el cargo más viejo primero y deja parcial el siguiente", () => {
    const out = allocateFifo(
      [
        { id: "nov", open: 6000000, due: "2026-11-01" },
        { id: "oct", open: 6000000, due: "2026-10-01" },
      ],
      [{ id: "pago", open: 9000000, date: "2026-11-05" }],
    );
    expect(out).toEqual([
      { credit: "pago", debit: "oct", amount: 6000000 },
      { credit: "pago", debit: "nov", amount: 3000000 },
    ]);
  });

  it("los punitorios van antes que los cargos, aunque venzan después", () => {
    const out = allocateFifo(
      [
        { id: "cargo", open: 1000, due: "2026-09-01" },
        { id: "punitorio", open: 200, due: "2026-10-01", kind: "interest" },
      ],
      [{ id: "pago", open: 500, date: "2026-10-05" }],
    );
    expect(out[0]).toEqual({ credit: "pago", debit: "punitorio", amount: 200 });
    expect(out[1]).toEqual({ credit: "pago", debit: "cargo", amount: 300 });
  });

  it("el excedente queda como saldo a favor y varios créditos se aplican en orden", () => {
    const out = allocateFifo(
      [{ id: "c1", open: 1000, due: "2026-10-01" }],
      [
        { id: "bonif", open: 300, date: "2026-10-02" },
        { id: "pago", open: 5000, date: "2026-10-01" },
      ],
    );
    expect(out).toEqual([{ credit: "pago", debit: "c1", amount: 1000 }]);
  });
});

describe("estado de cuenta", () => {
  it("saldo, vencido por antigüedad, a vencer y a favor", () => {
    const t = statementTotals(
      [
        { amount_cents: 1000, open_cents: 1000, due_date: "2026-10-13", effective_date: "2026-10-13" },
        { amount_cents: 2000, open_cents: 2000, due_date: "2026-08-20", effective_date: "2026-08-20" },
        { amount_cents: 3000, open_cents: 500, due_date: "2026-06-01", effective_date: "2026-06-01" },
        { amount_cents: 4000, open_cents: 4000, due_date: "2026-10-14", effective_date: "2026-10-14" },
        { amount_cents: -2500, open_cents: 0, due_date: null, effective_date: "2026-06-05" },
        { amount_cents: -1000, open_cents: 1000, due_date: null, effective_date: "2026-10-01" },
      ],
      "2026-10-14",
    );
    expect(t.balance).toBe(6500);
    expect(t.overdue).toBe(3500);
    expect(t.upcoming).toBe(4000);
    expect(t.credit).toBe(1000);
    expect(t.aging).toEqual({ d1_30: 1000, d31_60: 2000, d61_90: 0, d90_plus: 500 });
    expect(t.balance).toBe(t.overdue + t.upcoming - t.credit);
  });

  it("días de mora", () => {
    expect(daysOverdue("2026-10-01", "2026-10-14")).toBe(13);
    expect(daysOverdue(null, "2026-10-14")).toBe(0);
    expect(daysOverdue("2026-10-20", "2026-10-14")).toBe(0);
  });
});

describe("formato y mensajes", () => {
  it("formatea centavos y fechas sin correr el día", () => {
    expect(formatCents(8950000)).toBe("$ 89.500,00");
    expect(formatCents(-150)).toBe("−$ 1,50");
    expect(formatCents(100, { signed: true })).toBe("+$ 1,00");
    expect(formatDay("2026-10-01")).toBe("01/10/2026");
    expect(formatPeriod("2026-10-01", "2026-11-01")).toBe("01/10/2026 al 31/10/2026");
  });

  it("lee importes escritos a mano", () => {
    expect(parsePesosToCents("12.500")).toBe(1250000);
    expect(parsePesosToCents("12500,5")).toBe(1250050);
    expect(parsePesosToCents("$ 1.234,56")).toBe(123456);
    expect(parsePesosToCents("89500.25")).toBe(8950025);
    expect(parsePesosToCents("0")).toBeNull();
    expect(parsePesosToCents("abc")).toBeNull();
    expect(parsePesosToCents("1,234,5")).toBeNull();
  });

  it("traduce los errores de las RPC", () => {
    expect(billingErrorMessage(new Error("cap_per_month_exceeded"))).toMatch(/tope mensual/);
    expect(billingErrorMessage({ message: "forbidden" })).toMatch(/permiso/);
    expect(billingErrorMessage(new Error("Could not find the function public.internal_billing_overview"))).toMatch(/migración/);
  });
});
