import { describe, it, expect } from "vitest";
import {
  accrueDailyInterest,
  accrueInterest,
  interestConcept,
  interestExample,
  interestStart,
  type InterestConfig,
} from "@/lib/account/interest";

// Casos espejo de account_accrue_interest() en SQL.
const base: InterestConfig = {
  enabled: true,
  rate_pct: 3,
  period: "monthly",
  method: "simple",
  grace_days: 5,
  cap_pct: null,
  min_amount: 0,
};

describe("interestStart", () => {
  it("el punitorio corre desde el día siguiente al vencimiento + gracia", () => {
    expect(interestStart("2026-10-10", 5)).toBe("2026-10-16");
    expect(interestStart("2026-10-10", 0)).toBe("2026-10-11");
  });
});

describe("accrueInterest", () => {
  const charge = {
    dueDate: "2026-10-10",
    originalAmount: 1000,
    outstandingPrincipal: 1000,
    unpaidInterest: 0,
    postedInterest: 0,
    lastPeriod: null as string | null,
  };

  it("deshabilitado o dentro de la gracia: nada", () => {
    expect(accrueInterest({ ...charge, asOf: "2026-11-30", cfg: { ...base, enabled: false } })).toBeNull();
    expect(accrueInterest({ ...charge, asOf: "2026-10-15", cfg: base })).toBeNull();
  });

  it("mensual simple: un período por mes o fracción", () => {
    // Inicio 2026-10-16. Al 16/10 empieza el período 1 → 3% de 1000.
    expect(accrueInterest({ ...charge, asOf: "2026-10-16", cfg: base })).toEqual({
      period: "2026-10-16",
      units: 1,
      amount: 30,
    });
    // Al 20/11 ya empezaron 2 períodos (16/10 y 16/11) → 2 unidades.
    expect(accrueInterest({ ...charge, asOf: "2026-11-20", cfg: base })).toEqual({
      period: "2026-11-16",
      units: 2,
      amount: 60,
    });
  });

  it("idempotente: si el último período ya se liquidó, no repite", () => {
    expect(
      accrueInterest({ ...charge, lastPeriod: "2026-11-16", postedInterest: 60, asOf: "2026-11-30", cfg: base }),
    ).toBeNull();
    // Al empezar el período siguiente liquida sólo 1 unidad más.
    expect(
      accrueInterest({ ...charge, lastPeriod: "2026-11-16", postedInterest: 60, asOf: "2026-12-16", cfg: base }),
    ).toEqual({ period: "2026-12-16", units: 1, amount: 30 });
  });

  it("compuesto: capitaliza el interés impago", () => {
    const r = accrueInterest({
      ...charge,
      unpaidInterest: 30,
      postedInterest: 30,
      lastPeriod: "2026-10-16",
      asOf: "2026-11-16",
      cfg: { ...base, method: "compound" },
    });
    // (1000 + 30) * 3% = 30.90
    expect(r).toEqual({ period: "2026-11-16", units: 1, amount: 30.9 });
  });

  it("compuesto con varias unidades de una vez", () => {
    const r = accrueInterest({ ...charge, asOf: "2026-11-16", cfg: { ...base, method: "compound" } });
    // 1000 * (1.03^2 - 1) = 60.90
    expect(r).toEqual({ period: "2026-11-16", units: 2, amount: 60.9 });
  });

  it("respeta el tope sobre el capital original", () => {
    const r = accrueInterest({
      ...charge,
      postedInterest: 490,
      lastPeriod: "2026-10-16",
      asOf: "2027-01-16",
      cfg: { ...base, cap_pct: 50 },
    });
    // Tope 500, ya liquidado 490 → sólo 10.
    expect(r).toEqual({ period: "2027-01-16", units: 3, amount: 10 });
    expect(
      accrueInterest({ ...charge, postedInterest: 500, lastPeriod: "2026-10-16", asOf: "2027-01-16", cfg: { ...base, cap_pct: 50 } }),
    ).toBeNull();
  });

  it("monto mínimo: no liquida montos menores", () => {
    expect(
      accrueInterest({ ...charge, asOf: "2026-10-16", cfg: { ...base, min_amount: 50 } }),
    ).toBeNull();
  });

  it("sin capital pendiente no hay interés", () => {
    expect(accrueInterest({ ...charge, outstandingPrincipal: 0, asOf: "2026-12-01", cfg: base })).toBeNull();
  });
});

describe("accrueDailyInterest (un movimiento por cargo y mes)", () => {
  const daily: InterestConfig = { ...base, period: "daily", rate_pct: 0.1 };
  const charge = {
    dueDate: "2026-10-10",
    originalAmount: 1000,
    outstandingPrincipal: 1000,
    unpaidInterest: 0,
    postedInterest: 0,
    accruedThrough: null as string | null,
    existingMonthAmount: 0,
  };

  it("primer devengo: un solo movimiento del mes con todos los días", () => {
    // 16, 17, 18, 19, 20 → 5 días × 0,1% × 1000 = 5
    expect(accrueDailyInterest({ ...charge, asOf: "2026-10-20", cfg: daily })).toEqual([
      { period: "2026-10-01", through: "2026-10-20", units: 5, amount: 5 },
    ]);
  });

  it("corrida del día siguiente: suma un día al MISMO movimiento del mes", () => {
    expect(
      accrueDailyInterest({
        ...charge,
        accruedThrough: "2026-10-20",
        postedInterest: 5,
        unpaidInterest: 5,
        existingMonthAmount: 5,
        asOf: "2026-10-21",
        cfg: daily,
      }),
    ).toEqual([{ period: "2026-10-01", through: "2026-10-21", units: 1, amount: 1 }]);
  });

  it("idempotente: re-correr el mismo día no suma nada", () => {
    expect(
      accrueDailyInterest({ ...charge, accruedThrough: "2026-10-21", postedInterest: 6, asOf: "2026-10-21", cfg: daily }),
    ).toEqual([]);
  });

  it("cambio de mes: abre el movimiento del mes nuevo", () => {
    expect(
      accrueDailyInterest({ ...charge, accruedThrough: "2026-10-31", postedInterest: 16, asOf: "2026-11-01", cfg: daily }),
    ).toEqual([{ period: "2026-11-01", through: "2026-11-01", units: 1, amount: 1 }]);
  });

  it("corrida atrasada que cruza meses: un movimiento por mes", () => {
    // 16/10 a 31/10 = 16 días; 1/11 a 3/11 = 3 días.
    expect(accrueDailyInterest({ ...charge, asOf: "2026-11-03", cfg: daily })).toEqual([
      { period: "2026-10-01", through: "2026-10-31", units: 16, amount: 16 },
      { period: "2026-11-01", through: "2026-11-03", units: 3, amount: 3 },
    ]);
  });

  it("dentro de la gracia o deshabilitado: nada", () => {
    expect(accrueDailyInterest({ ...charge, asOf: "2026-10-15", cfg: daily })).toEqual([]);
    expect(accrueDailyInterest({ ...charge, asOf: "2026-10-30", cfg: { ...daily, enabled: false } })).toEqual([]);
  });

  it("tope acumulado sobre el capital original", () => {
    expect(
      accrueDailyInterest({
        ...charge,
        accruedThrough: "2026-10-20",
        postedInterest: 48,
        existingMonthAmount: 48,
        asOf: "2026-10-25",
        cfg: { ...daily, cap_pct: 5 },
      }),
    ).toEqual([{ period: "2026-10-01", through: "2026-10-25", units: 5, amount: 2 }]);
  });

  it("mínimo contra el total del mes; un mes cerrado que no llega pasa sus días al siguiente", () => {
    const cfg = { ...daily, min_amount: 10 };
    // Al 20/10: 5 en el mes, menor que 10 → espera.
    expect(accrueDailyInterest({ ...charge, asOf: "2026-10-20", cfg })).toEqual([]);
    // Al 25/10: 10 → liquida.
    expect(accrueDailyInterest({ ...charge, asOf: "2026-10-25", cfg })).toEqual([
      { period: "2026-10-01", through: "2026-10-25", units: 10, amount: 10 },
    ]);
    // Mes ya liquidado (10): un día más se suma aunque sea menor al mínimo.
    expect(
      accrueDailyInterest({ ...charge, accruedThrough: "2026-10-25", postedInterest: 10, existingMonthAmount: 10, asOf: "2026-10-26", cfg }),
    ).toEqual([{ period: "2026-10-01", through: "2026-10-26", units: 1, amount: 1 }]);
    // Vencido el 28/10 con gracia 0: oct tiene 3 días (3) y no llega; pasa a nov.
    expect(
      accrueDailyInterest({ ...charge, dueDate: "2026-10-28", asOf: "2026-11-07", cfg: { ...cfg, grace_days: 0 } }),
    ).toEqual([{ period: "2026-11-01", through: "2026-11-07", units: 10, amount: 10 }]);
  });

  it("compuesto: capitaliza lo impago entre meses", () => {
    const r = accrueDailyInterest({
      ...charge,
      asOf: "2026-11-01",
      cfg: { ...daily, method: "compound", rate_pct: 1 },
    });
    // Oct: 1000 × (1,01^16 − 1) = 172,58; nov: 1172,58 × 1% = 11,73.
    expect(r).toEqual([
      { period: "2026-10-01", through: "2026-10-31", units: 16, amount: 172.58 },
      { period: "2026-11-01", through: "2026-11-01", units: 1, amount: 11.73 },
    ]);
  });
});

describe("interestExample / interestConcept", () => {
  it("la calculadora suma los meses con tasa diaria", () => {
    // 45 días de atraso, gracia 5 → 40 días × 0,1% × 10000 = 400
    expect(interestExample(10000, 45, { ...base, period: "daily", rate_pct: 0.1 })).toBe(400);
  });

  it("concepto del movimiento mensual de tasa diaria", () => {
    expect(interestConcept("2026-10-01", "2026-10-20")).toBe("Punitorio de octubre 2026 (al 20/10)");
    expect(interestConcept("2026-10-16", null)).toBe("Punitorio");
  });
});
