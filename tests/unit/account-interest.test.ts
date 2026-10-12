import { describe, it, expect } from "vitest";
import { accrueInterest, interestStart, type InterestConfig } from "@/lib/account/interest";

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

  it("diario: un período por día", () => {
    const r = accrueInterest({
      ...charge,
      asOf: "2026-10-20",
      cfg: { ...base, period: "daily", rate_pct: 0.1 },
    });
    // 16, 17, 18, 19, 20 → 5 días × 0.1% × 1000 = 5
    expect(r).toEqual({ period: "2026-10-20", units: 5, amount: 5 });
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
