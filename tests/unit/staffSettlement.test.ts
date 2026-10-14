// =============================================================================
// F21 · ADR-121: motor de liquidación del staff
// (supabase/functions/_shared/staff/settlement.ts). Cubre participaciones con
// vigencias, reglas por cliente, comisiones de alta, gastos (proporcionales,
// eximidos, asignados, USD, anual prorrateado, por cliente), contracargos y
// pagos tardíos, saldo negativo y redondeos exactos al centavo.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  HOUSE,
  allocate,
  bpOf,
  checkInvariant,
  computeSettlement,
  explainBase,
  explainLine,
  occurrenceDates,
  projectedItems,
  sharesOverflow,
  spreadParts,
  type MoneyItem,
  type SettlementInput,
  type StaffExpense,
} from "@/supabase/functions/_shared/staff/settlement";
import { addMonths, periodLabel } from "@/supabase/functions/_shared/staff/dates";
import { checkMpPayout, normalizeMpOperationId, parseMpPayment } from "@/supabase/functions/_shared/staff/mpPayout";

const JUAN = "juan";
const ANA = "ana";
const LEO = "leo";
const T_A = "tenant-a";
const T_Z = "tenant-z";

const base = (over: Partial<SettlementInput> = {}): SettlementInput => ({
  period: "2026-10-01",
  settings: { houseAbsorbsExpenses: true, negativeCarry: true, incomeTaxReserveBp: 0 },
  members: [
    { id: JUAN, name: "Juan" },
    { id: ANA, name: "Ana" },
  ],
  shares: [
    { member_id: JUAN, share_bp: 4000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
    { member_id: ANA, share_bp: 3000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
  ],
  clientRules: [],
  appliedSignupRuleIds: [],
  items: [],
  expenses: [],
  fxRates: [],
  adjustments: [],
  carryIn: [],
  ...over,
});

const pay = (id: string, tenant: string, date: string, amount: number, fee = 0): MoneyItem => ({
  source: "payment",
  id,
  tenant_id: tenant,
  tenant_name: tenant === T_Z ? "Kiosco Z" : "Kiosco A",
  date,
  amount_cents: amount,
  fee_cents: fee,
});
const rev = (id: string, tenant: string, date: string, amount: number): MoneyItem => ({
  source: "reversal",
  id,
  tenant_id: tenant,
  date,
  amount_cents: -amount,
  fee_cents: 0,
});

const expense = (over: Partial<StaffExpense>): StaffExpense => ({
  id: "exp",
  name: "Servidor",
  category: "servidores",
  amount_cents: 100_000,
  currency: "ARS",
  recurrence: "monthly",
  interval_n: null,
  start_date: "2026-01-10",
  end_date: null,
  spread_months: 1,
  allocation: "proportional",
  member_id: null,
  tenant_id: null,
  custom: [],
  exemptions: [],
  period_amounts: [],
  ...over,
});

const line = (r: ReturnType<typeof computeSettlement>, id: string) => r.lines.find((l) => l.member_id === id)!;

describe("allocate (resto mayor)", () => {
  it("suma exacto y desempata por resto y orden", () => {
    const m = allocate(100, [
      { key: "a", w: 1 },
      { key: "b", w: 1 },
      { key: "c", w: 1 },
    ])!;
    expect([...m.values()]).toEqual([34, 33, 33]);
  });
  it("negativos: mismo reparto con signo", () => {
    const m = allocate(-100, [
      { key: "a", w: 1 },
      { key: "b", w: 1 },
      { key: "c", w: 1 },
    ])!;
    expect([...m.values()].reduce((s, x) => s + x, 0)).toBe(-100);
    expect(m.get("a")).toBe(-34);
  });
  it("pesos en cero → null", () => {
    expect(allocate(10, [{ key: "a", w: 0 }])).toBeNull();
  });
  it("montos grandes sin perder precisión", () => {
    const m = allocate(987_654_321_987, [
      { key: "a", w: 3333 },
      { key: "b", w: 3333 },
      { key: "c", w: 3334 },
    ])!;
    expect([...m.values()].reduce((s, x) => s + x, 0)).toBe(987_654_321_987);
  });
  it("fuzz: siempre suma el total", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const total = rnd(2_000_000) - 1_000_000;
      const ws = Array.from({ length: 1 + rnd(6) }, (_, k) => ({ key: `k${k}`, w: rnd(10_000) + 1 }));
      const m = allocate(total, ws)!;
      expect([...m.values()].reduce((s, x) => s + x, 0)).toBe(total);
    }
  });
  it("bpOf redondea mitades lejos del cero", () => {
    expect(bpOf(5, 5000)).toBe(3);
    expect(bpOf(-5, 5000)).toBe(-3);
    expect(bpOf(1_000_000, 350)).toBe(35_000);
  });
});

describe("participaciones", () => {
  it("reparte el cobrado neto: 40 % Juan, 30 % Ana, 30 % la casa", () => {
    const r = computeSettlement(base({ items: [pay("p1", T_A, "2026-10-05", 1_000_000)] }));
    expect(line(r, JUAN).income_cents).toBe(400_000);
    expect(line(r, ANA).income_cents).toBe(300_000);
    expect(r.house.income_cents).toBe(300_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("cobrado neto = cobrado − comisiones − reintegros − reserva", () => {
    const r = computeSettlement(
      base({
        settings: { houseAbsorbsExpenses: true, negativeCarry: true, incomeTaxReserveBp: 350 },
        items: [pay("p1", T_A, "2026-10-05", 1_000_000, 60_000), rev("r1", T_A, "2026-10-20", 100_000)],
      }),
    );
    expect(r.base.gross_cents).toBe(1_000_000);
    expect(r.base.fees_cents).toBe(60_000);
    expect(r.base.reversals_cents).toBe(100_000);
    expect(r.base.net_cents).toBe(840_000);
    expect(r.base.reserve_cents).toBe(bpOf(940_000, 350) + bpOf(-100_000, 350));
    expect(r.base.distributable_cents + r.base.reserve_cents).toBe(840_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("cambio a mitad de mes: cada pago usa la participación del día", () => {
    const r = computeSettlement(
      base({
        shares: [
          { member_id: JUAN, share_bp: 4000, expense_bp: null, valid_from: "2026-01-01", valid_to: "2026-10-14" },
          { member_id: JUAN, share_bp: 5000, expense_bp: null, valid_from: "2026-10-15", valid_to: null },
          { member_id: ANA, share_bp: 3000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
        ],
        items: [pay("p1", T_A, "2026-10-05", 100_000), pay("p2", T_A, "2026-10-20", 100_000)],
      }),
    );
    expect(line(r, JUAN).income_cents).toBe(40_000 + 50_000);
    expect(line(r, JUAN).share_bp_start).toBe(4000);
    expect(line(r, JUAN).share_bp_end).toBe(5000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("alguien que entra a mitad de mes cobra sólo desde su alta", () => {
    const r = computeSettlement(
      base({
        members: [
          { id: JUAN, name: "Juan" },
          { id: ANA, name: "Ana" },
          { id: LEO, name: "Leo" },
        ],
        shares: [
          { member_id: JUAN, share_bp: 4000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
          { member_id: ANA, share_bp: 3000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
          { member_id: LEO, share_bp: 1000, expense_bp: null, valid_from: "2026-10-16", valid_to: null },
        ],
        items: [pay("p1", T_A, "2026-10-01", 100_000), pay("p2", T_A, "2026-10-31", 100_000)],
      }),
    );
    expect(line(r, LEO).income_cents).toBe(10_000);
    expect(r.house.income_cents).toBe(30_000 + 20_000);
  });

  it("sharesOverflow detecta más de 100 % en algún día", () => {
    expect(sharesOverflow(base().shares)).toBeNull();
    expect(
      sharesOverflow([
        ...base().shares,
        { member_id: LEO, share_bp: 4000, expense_bp: null, valid_from: "2026-11-01", valid_to: null },
      ]),
    ).toEqual({ day: "2026-11-01", total_bp: 11_000 });
  });
});

describe("reglas por cliente", () => {
  it("+10 % para Ana en el cliente Z (sale de la casa)", () => {
    const r = computeSettlement(
      base({
        clientRules: [{ id: "r1", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: 1000, valid_from: "2026-01-01", valid_to: null }],
        items: [pay("p1", T_A, "2026-10-05", 100_000), pay("p2", T_Z, "2026-10-06", 100_000)],
      }),
    );
    const ana = line(r, ANA);
    expect(ana.income_cents).toBe(30_000 + 40_000);
    expect(ana.by_tenant.find((t) => t.tenant_id === T_Z)).toMatchObject({ cents: 40_000, bp: 4000, rule: "bonus_bp" });
    expect(r.house.income_cents).toBe(30_000 + 20_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("% especial que reemplaza el suyo en un cliente", () => {
    const r = computeSettlement(
      base({
        clientRules: [{ id: "r1", member_id: JUAN, tenant_id: T_Z, kind: "override_bp", value: 1000, valid_from: "2026-01-01", valid_to: null }],
        items: [pay("p2", T_Z, "2026-10-06", 100_000)],
      }),
    );
    expect(line(r, JUAN).income_cents).toBe(10_000);
    expect(r.house.income_cents).toBe(60_000);
  });

  it("regla fuera de vigencia no aplica", () => {
    const r = computeSettlement(
      base({
        clientRules: [{ id: "r1", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: 1000, valid_from: "2026-10-10", valid_to: null }],
        items: [pay("p2", T_Z, "2026-10-06", 100_000)],
      }),
    );
    expect(line(r, ANA).income_cents).toBe(30_000);
  });

  it("si un cliente supera el 100 % se reduce en proporción y avisa", () => {
    const r = computeSettlement(
      base({
        clientRules: [{ id: "r1", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: 6000, valid_from: "2026-01-01", valid_to: null }],
        items: [pay("p2", T_Z, "2026-10-06", 100_001)],
      }),
    );
    expect(r.warnings.join(" ")).toMatch(/se redujeron/);
    expect(r.house.income_cents).toBe(0);
    expect(line(r, JUAN).income_cents + line(r, ANA).income_cents).toBe(100_001);
    expect(checkInvariant(r)).toBe(true);
  });

  it("comisión de alta fija: una sola vez, la paga la casa", () => {
    const rule = { id: "s1", member_id: JUAN, tenant_id: T_Z, kind: "signup_fixed" as const, value: 50_000, valid_from: "2026-10-01", valid_to: "2026-12-31" };
    const r = computeSettlement(base({ clientRules: [rule], items: [pay("p2", T_Z, "2026-10-06", 100_000)] }));
    expect(line(r, JUAN).signup_cents).toBe(50_000);
    expect(line(r, JUAN).signup_rule_ids).toEqual(["s1"]);
    expect(r.house.signup_cents).toBe(-50_000);
    expect(checkInvariant(r)).toBe(true);
    const again = computeSettlement(
      base({ period: "2026-11-01", clientRules: [rule], appliedSignupRuleIds: ["s1"], items: [pay("p3", T_Z, "2026-11-06", 100_000)] }),
    );
    expect(line(again, JUAN).signup_cents).toBe(0);
  });

  it("comisión de alta en % del primer cobro, sólo dentro de la vigencia", () => {
    const rule = { id: "s2", member_id: ANA, tenant_id: T_Z, kind: "signup_bp" as const, value: 5000, valid_from: "2026-10-10", valid_to: null };
    const before = computeSettlement(base({ clientRules: [rule], items: [pay("p2", T_Z, "2026-10-06", 100_000)] }));
    expect(line(before, ANA).signup_cents).toBe(0);
    const inside = computeSettlement(base({ clientRules: [rule], items: [pay("p2", T_Z, "2026-10-16", 100_000, 4_000)] }));
    expect(line(inside, ANA).signup_cents).toBe(48_000);
  });
});

describe("gastos", () => {
  const items = [pay("p1", T_A, "2026-10-05", 1_000_000)];

  it("proporcional: Juan 40, Ana 30, la casa 30", () => {
    const r = computeSettlement(base({ items, expenses: [expense({})] }));
    expect(line(r, JUAN).expense_cents).toBe(40_000);
    expect(line(r, ANA).expense_cents).toBe(30_000);
    expect(r.house.expense_cents).toBe(30_000);
    expect(r.to_share_cents).toBe(900_000);
    expect(line(r, JUAN).net_cents).toBe(360_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("Ana eximida: Juan y la casa lo absorben renormalizado (40/70 y 30/70)", () => {
    const r = computeSettlement(base({ items, expenses: [expense({ exemptions: [{ member_id: ANA, valid_from: null, valid_to: null }] })] }));
    expect(line(r, ANA).expense_cents).toBe(0);
    expect(line(r, JUAN).expense_cents).toBe(57_143);
    expect(r.house.expense_cents).toBe(42_857);
  });

  it("la casa no absorbe gastos: sólo las personas (40/70 y 30/70)", () => {
    const r = computeSettlement(
      base({ items, settings: { houseAbsorbsExpenses: false, negativeCarry: true, incomeTaxReserveBp: 0 }, expenses: [expense({})] }),
    );
    expect(line(r, JUAN).expense_cents).toBe(57_143);
    expect(line(r, ANA).expense_cents).toBe(42_857);
    expect(r.house.expense_cents).toBe(0);
  });

  it("% de gastos menor que su participación: Ana cobra 30 % y absorbe 10 %", () => {
    const r = computeSettlement(
      base({
        items,
        shares: [
          { member_id: JUAN, share_bp: 4000, expense_bp: null, valid_from: "2026-01-01", valid_to: null },
          { member_id: ANA, share_bp: 3000, expense_bp: 1000, valid_from: "2026-01-01", valid_to: null },
        ],
        expenses: [expense({})],
      }),
    );
    expect(line(r, ANA).income_cents).toBe(300_000);
    expect(line(r, ANA).expense_cents).toBe(10_000);
    expect(r.house.expense_cents).toBe(50_000);
  });

  it("100 % a una persona, a la casa, o porcentajes a medida", () => {
    const one = computeSettlement(base({ items, expenses: [expense({ allocation: "single", member_id: ANA })] }));
    expect(line(one, ANA).expense_cents).toBe(100_000);
    expect(line(one, JUAN).expense_cents).toBe(0);
    const house = computeSettlement(base({ items, expenses: [expense({ allocation: "house" })] }));
    expect(house.house.expense_cents).toBe(100_000);
    const custom = computeSettlement(
      base({
        items,
        expenses: [
          expense({
            allocation: "custom",
            custom: [
              { member_id: JUAN, share_bp: 2500 },
              { member_id: ANA, share_bp: 2500 },
              { member_id: null, share_bp: 5000 },
            ],
          }),
        ],
      }),
    );
    expect(line(custom, JUAN).expense_cents).toBe(25_000);
    expect(custom.house.expense_cents).toBe(50_000);
    for (const r of [one, house, custom]) expect(checkInvariant(r)).toBe(true);
  });

  it("asignado a alguien que ya no está → la casa, con aviso", () => {
    const r = computeSettlement(base({ items, expenses: [expense({ allocation: "single", member_id: "fantasma" })] }));
    expect(r.house.expense_cents).toBe(100_000);
    expect(r.warnings.join(" ")).toMatch(/ya no está/);
    expect(checkInvariant(r)).toBe(true);
  });

  it("gasto en USD con la cotización del mes", () => {
    const r = computeSettlement(
      base({
        items,
        expenses: [expense({ currency: "USD", amount_cents: 2_340 })],
        fxRates: [{ period: "2026-10-01", currency: "USD", rate: 1_455.5 }],
      }),
    );
    expect(r.expenses[0]!.amount_cents).toBe(Math.round(2_340 * 1_455.5));
    expect(r.expenses[0]!.fx_rate).toBe(1_455.5);
    expect(checkInvariant(r)).toBe(true);
  });

  it("USD sin cotización del mes: usa la anterior y avisa; sin ninguna, error", () => {
    const prior = computeSettlement(
      base({ items, expenses: [expense({ currency: "USD", amount_cents: 1_000 })], fxRates: [{ period: "2026-08-01", currency: "USD", rate: 1_300 }] }),
    );
    expect(prior.expenses[0]!.amount_cents).toBe(1_300_000);
    expect(prior.warnings.join(" ")).toMatch(/agosto 2026/);
    const none = computeSettlement(base({ items, expenses: [expense({ currency: "USD", amount_cents: 1_000 })] }));
    expect(none.errors.length).toBe(1);
    expect(none.expenses).toHaveLength(0);
  });

  it("anual prorrateado en 12: cuotas exactas y vuelve a empezar al renovar", () => {
    const e = expense({ recurrence: "yearly", amount_cents: 1_200_007, start_date: "2026-03-15", spread_months: 12 });
    let total = 0;
    for (let k = 0; k < 12; k++) {
      const p = addMonths("2026-03-01", k);
      const r = computeSettlement(base({ period: p, items: [pay(`p${k}`, T_A, p, 1_000_000)], expenses: [e] }));
      total += r.expenses_cents;
      expect(r.expenses[0]!.occurrences[0]).toMatchObject({ installment: k + 1, of: 12 });
    }
    expect(total).toBe(1_200_007);
    const before = computeSettlement(base({ period: "2026-02-01", expenses: [e] }));
    expect(before.expenses_cents).toBe(0);
    const renewal = computeSettlement(base({ period: "2027-03-01", expenses: [e] }));
    expect(renewal.expenses[0]!.occurrences[0]).toMatchObject({ date: "2027-03-15", installment: 1 });
  });

  it("anual sin prorrateo: entero en el mes en que se paga", () => {
    const e = expense({ recurrence: "yearly", amount_cents: 1_200_000, start_date: "2026-10-03" });
    expect(computeSettlement(base({ expenses: [e] })).expenses_cents).toBe(1_200_000);
    expect(computeSettlement(base({ period: "2026-11-01", expenses: [e] })).expenses_cents).toBe(0);
  });

  it("mensual con fecha de fin y monto distinto en un mes (0 = no hubo)", () => {
    const e = expense({ end_date: "2026-11-30", period_amounts: [{ period: "2026-10-01", amount_cents: 150_000 }] });
    expect(computeSettlement(base({ expenses: [e] })).expenses_cents).toBe(150_000);
    expect(computeSettlement(base({ period: "2026-12-01", expenses: [e] })).expenses_cents).toBe(0);
    const skip = expense({ period_amounts: [{ period: "2026-10-01", amount_cents: 0 }] });
    expect(computeSettlement(base({ expenses: [skip] })).expenses).toHaveLength(0);
  });

  it("cada N días: puede caer dos veces en el mes; cada N meses salta meses", () => {
    const d = expense({ recurrence: "every_n_days", interval_n: 15, start_date: "2026-10-01" });
    expect(computeSettlement(base({ expenses: [d] })).expenses_cents).toBe(300_000);
    const m = expense({ recurrence: "every_n_months", interval_n: 3, start_date: "2026-07-20" });
    expect(computeSettlement(base({ expenses: [m] })).expenses_cents).toBe(100_000);
    expect(computeSettlement(base({ period: "2026-11-01", expenses: [m] })).expenses_cents).toBe(0);
  });

  it("gasto atribuible a un cliente: lo pagan quienes cobran de ese negocio", () => {
    const r = computeSettlement(
      base({
        items,
        clientRules: [{ id: "r1", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: 1000, valid_from: "2026-01-01", valid_to: null }],
        expenses: [expense({ allocation: "client", tenant_id: T_Z })],
      }),
    );
    expect(line(r, JUAN).expense_cents).toBe(40_000);
    expect(line(r, ANA).expense_cents).toBe(40_000);
    expect(r.house.expense_cents).toBe(20_000);
  });

  it("todos eximidos y la casa no absorbe: lo absorbe la casa con aviso", () => {
    const r = computeSettlement(
      base({
        items,
        settings: { houseAbsorbsExpenses: false, negativeCarry: true, incomeTaxReserveBp: 0 },
        expenses: [
          expense({
            exemptions: [
              { member_id: JUAN, valid_from: null, valid_to: null },
              { member_id: ANA, valid_from: null, valid_to: null },
            ],
          }),
        ],
      }),
    );
    expect(r.house.expense_cents).toBe(100_000);
    expect(r.warnings.length).toBe(1);
  });

  it("occurrenceDates: el 31 cae el último día de los meses cortos", () => {
    expect(occurrenceDates({ recurrence: "monthly", interval_n: null, start_date: "2026-01-31", end_date: null }, "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(spreadParts(10, 3)).toEqual([4, 3, 3]);
    expect(spreadParts(-10, 3)).toEqual([-4, -3, -3]);
  });
});

describe("contracargos, pagos tardíos y saldo negativo", () => {
  it("contracargo de un pago ya liquidado: se descuenta en la próxima liquidación", () => {
    const r = computeSettlement(
      base({
        period: "2026-11-01",
        clientRules: [{ id: "r1", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: 1000, valid_from: "2026-01-01", valid_to: null }],
        items: [pay("p9", T_A, "2026-11-03", 500_000), rev("r9", T_Z, "2026-11-10", 100_000)],
      }),
    );
    expect(r.base.reversals_cents).toBe(100_000);
    expect(line(r, ANA).income_cents).toBe(150_000 - 40_000);
    expect(checkInvariant(r)).toBe(true);
  });

  it("pago con fecha de un mes cerrado entra como 'de meses ya cerrados'", () => {
    const r = computeSettlement(base({ period: "2026-11-01", items: [pay("late", T_A, "2026-10-28", 200_000)] }));
    expect(r.base.late_net_cents).toBe(200_000);
    expect(r.item_ids).toEqual([{ source: "payment", id: "late" }]);
  });

  it("ítems de un mes posterior no entran", () => {
    const r = computeSettlement(base({ items: [pay("next", T_A, "2026-11-02", 200_000)] }));
    expect(r.base.gross_cents).toBe(0);
    expect(r.item_ids).toEqual([]);
  });

  it("neto negativo: no se paga y pasa al mes siguiente (pase con la casa)", () => {
    const r = computeSettlement(base({ items: [pay("p1", T_A, "2026-10-05", 10_000)], expenses: [expense({ allocation: "single", member_id: ANA })] }));
    const ana = line(r, ANA);
    expect(ana.net_cents).toBe(3_000 - 100_000);
    expect(ana.payable_cents).toBe(0);
    expect(ana.carry_out_cents).toBe(-97_000);
    expect(checkInvariant(r)).toBe(true);
    const next = computeSettlement(
      base({ period: "2026-11-01", items: [pay("p2", T_A, "2026-11-05", 1_000_000)], carryIn: [{ member_id: ANA, amount_cents: -97_000 }] }),
    );
    expect(line(next, ANA).net_cents).toBe(300_000 - 97_000);
    expect(next.house.carry_in_cents).toBe(97_000);
    expect(checkInvariant(next)).toBe(true);
  });

  it("sin arrastre: el negativo lo condona la casa", () => {
    const r = computeSettlement(
      base({
        settings: { houseAbsorbsExpenses: true, negativeCarry: false, incomeTaxReserveBp: 0 },
        items: [pay("p1", T_A, "2026-10-05", 10_000)],
        expenses: [expense({ allocation: "single", member_id: ANA })],
      }),
    );
    expect(line(r, ANA).carry_out_cents).toBe(0);
    expect(r.house.forgiven_cents).toBe(97_000);
    expect(r.house.cash_cents).toBe(r.to_share_cents - line(r, JUAN).payable_cents);
  });

  it("ajustes manuales: pase entre la persona y la casa", () => {
    const r = computeSettlement(
      base({
        items: [pay("p1", T_A, "2026-10-05", 100_000)],
        adjustments: [
          { id: "a1", member_id: JUAN, amount_cents: 5_000, reason: "Corrección de septiembre" },
          { id: "a2", member_id: ANA, amount_cents: -2_000, reason: "Adelanto" },
        ],
      }),
    );
    expect(line(r, JUAN).net_cents).toBe(45_000);
    expect(line(r, ANA).net_cents).toBe(28_000);
    expect(r.house.adjustment_cents).toBe(-3_000);
    expect(checkInvariant(r)).toBe(true);
  });
});

describe("invariante con datos al azar", () => {
  it("personas + casa = a repartir − gastos, al centavo", () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 200; i++) {
      const items: MoneyItem[] = Array.from({ length: 1 + rnd(12) }, (_, k) =>
        rnd(5) === 0
          ? rev(`r${k}`, rnd(2) ? T_A : T_Z, `2026-10-${String(1 + rnd(31)).padStart(2, "0")}`, 1 + rnd(90_000))
          : pay(`p${k}`, rnd(2) ? T_A : T_Z, `2026-10-${String(1 + rnd(31)).padStart(2, "0")}`, 1 + rnd(900_000), rnd(30_000)),
      );
      const r = computeSettlement(
        base({
          settings: { houseAbsorbsExpenses: rnd(2) === 0, negativeCarry: rnd(2) === 0, incomeTaxReserveBp: rnd(800) },
          shares: [
            { member_id: JUAN, share_bp: rnd(5000), expense_bp: rnd(2) ? null : rnd(5000), valid_from: "2026-01-01", valid_to: "2026-10-12" },
            { member_id: JUAN, share_bp: rnd(5000), expense_bp: null, valid_from: "2026-10-13", valid_to: null },
            { member_id: ANA, share_bp: rnd(5000), expense_bp: null, valid_from: "2026-01-01", valid_to: null },
          ],
          clientRules: [
            { id: "b", member_id: ANA, tenant_id: T_Z, kind: "bonus_bp", value: rnd(4000), valid_from: "2026-10-05", valid_to: null },
            { id: "s", member_id: JUAN, tenant_id: T_A, kind: "signup_bp", value: rnd(3000), valid_from: "2026-01-01", valid_to: null },
          ],
          items,
          expenses: [
            expense({ id: "e1", amount_cents: 1 + rnd(300_000) }),
            expense({ id: "e2", allocation: "client", tenant_id: T_Z, amount_cents: 1 + rnd(100_000), exemptions: [{ member_id: ANA, valid_from: "2026-10-20", valid_to: null }] }),
            expense({ id: "e3", currency: "USD", amount_cents: 1 + rnd(5_000), recurrence: "yearly", start_date: "2026-04-09", spread_months: 12 }),
          ],
          fxRates: [{ period: "2026-04-01", currency: "USD", rate: 1_000 + rnd(500) + rnd(100) / 100 }],
          adjustments: [{ id: "a", member_id: JUAN, amount_cents: rnd(20_000) - 10_000, reason: "x" }],
          carryIn: [{ member_id: ANA, amount_cents: -rnd(10_000) }],
        }),
      );
      expect(checkInvariant(r), JSON.stringify(r.base)).toBe(true);
      for (const e of r.expenses) expect(e.split.reduce((s, x) => s + x.cents, 0)).toBe(e.amount_cents);
    }
  });
});

describe("proyección y explicación", () => {
  it("projectedItems aplica la tasa de cobro y la comisión estimada", () => {
    const items = projectedItems(
      [
        { tenant_id: T_A, tenant_name: "Kiosco A", expected_cents: 855_000, cycle: "monthly", due_date: "2026-11-10" },
        { tenant_id: T_Z, tenant_name: "Kiosco Z", expected_cents: 0, cycle: "monthly", due_date: "2026-11-01" },
      ],
      "2026-11-01",
      9000,
      600,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ amount_cents: 769_500, fee_cents: 46_170, date: "2026-11-10", source: "projected" });
    const r = computeSettlement(base({ period: "2026-11-01", items }));
    expect(r.item_ids).toEqual([]);
    expect(line(r, JUAN).income_cents).toBe(bpOf(769_500 - 46_170, 4000));
  });

  it("explica la base y cada línea paso a paso", () => {
    const r = computeSettlement(base({ items: [pay("p1", T_A, "2026-10-05", 1_000_000, 50_000)], expenses: [expense({})] }));
    const steps = explainBase(r, 0);
    expect(steps.map((s) => s.label)).toEqual(["Cobrado en el mes", "Comisiones de cobro", "Cobrado neto", "Gasto: Servidor", "A repartir"]);
    expect(steps.at(-1)!.cents).toBe(r.to_share_cents);
    const juan = explainLine(line(r, JUAN));
    expect(juan.at(-1)).toMatchObject({ label: "Neto", cents: line(r, JUAN).net_cents });
    expect(periodLabel("2026-10-01")).toBe("octubre 2026");
    expect(HOUSE).toBe("__house__");
  });
});

describe("Mercado Pago: operación del pago al staff", () => {
  const raw = {
    id: 123456789012,
    status: "approved",
    status_detail: "accredited",
    transaction_amount: 250000.5,
    currency_id: "ARS",
    date_created: "2026-11-05T10:00:00.000-03:00",
    date_approved: "2026-11-05T10:00:02.000-03:00",
    operation_type: "money_transfer",
    payment_method_id: "account_money",
    payer: { id: 111, email: "pagos@ninjasoft.ar", first_name: "Ninja", last_name: "Soft", identification: { type: "CUIT", number: "30712345679" } },
    collector_id: 222,
    point_of_interaction: { transaction_data: { bank_info: { collector: { account_holder_name: "Ana Pérez", long_name: "Banco Galicia" } } } },
  };

  it("parsea el resumen sin datos sensibles", () => {
    const s = parseMpPayment(raw)!;
    expect(s).toMatchObject({ id: "123456789012", amount_cents: 25_000_050, status: "approved", collector_id: "222" });
    expect(s.payer.name).toBe("Ninja Soft");
    expect(s.counterpart.name).toBe("Ana Pérez");
    expect(parseMpPayment({})).toBeNull();
  });

  it("controla estado, moneda, monto y dirección", () => {
    const s = parseMpPayment(raw)!;
    expect(checkMpPayout(s, { expected_cents: 25_000_050, own_user_id: "111" })).toEqual({ ok: true, direction: "outgoing", issues: [] });
    const wrong = checkMpPayout(s, { expected_cents: 20_000_000, own_user_id: "222" });
    expect(wrong.ok).toBe(false);
    expect(wrong.direction).toBe("incoming");
    expect(wrong.issues).toHaveLength(2);
    expect(checkMpPayout({ ...s, status: "pending" }, { expected_cents: 25_000_000, own_user_id: null, tolerance_cents: 100 }).issues).toHaveLength(1);
  });

  it("normaliza el número de operación", () => {
    expect(normalizeMpOperationId(" 1234-5678-90 ")).toBe("1234567890");
    expect(normalizeMpOperationId("abc")).toBeNull();
  });
});
