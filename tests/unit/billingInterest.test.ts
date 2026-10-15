// F20-9 (H135 · ADR-128): cálculo puro de punitorios. Es el espejo exacto de
// platform_interest_schedule (la prueba de PGlite compara 300 casos al azar
// entre las dos implementaciones); acá van los casos con números a mano.
import { describe, expect, it } from "vitest";
import {
  addDays,
  formatBp,
  interestSchedule,
  parsePercentToBp,
  simulateInterest,
  type InterestPolicy,
} from "@/lib/billing/interest";

const P5: InterestPolicy = { monthlyRateBp: 500, graceDays: 0, method: "daily_prorata", capBp: null, minAmountCents: 0 };
// Lunes 03/08/2026: hábil y sin feriados cerca.
const DUE = "2026-08-03";

describe("interestSchedule · diario", () => {
  it("criterio de la spec: $ 50.000 vencidos hace 45 días al 5 % mensual = $ 3.750", () => {
    const r = interestSchedule({ policy: P5, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 45) });
    expect(r.daysOverdue).toBe(45);
    expect(r.accruedCents).toBe(375_000);
    // Un mes calendario por fila: 28 días de agosto y 17 de septiembre.
    expect(r.months).toEqual([
      { month: "2026-08", accruedCents: 233_333, liquidatedCents: 233_333 },
      { month: "2026-09", accruedCents: 141_667, liquidatedCents: 141_667 },
    ]);
    expect(r.liquidatedCents).toBe(375_000);
  });

  it("sin mora el día del vencimiento; 1 día al día siguiente", () => {
    expect(interestSchedule({ policy: P5, dueDate: DUE, originalCents: 3_000_000, asOf: DUE }).accruedCents).toBe(0);
    // 3.000.000 × 5 % / 30 = 5.000 centavos por día.
    expect(interestSchedule({ policy: P5, dueDate: DUE, originalCents: 3_000_000, asOf: addDays(DUE, 1) }).accruedCents).toBe(5_000);
  });

  it("los días de gracia corren el inicio", () => {
    const r = interestSchedule({ policy: { ...P5, graceDays: 5 }, dueDate: DUE, originalCents: 3_000_000, asOf: addDays(DUE, 10) });
    expect(r.daysOverdue).toBe(5);
    expect(r.accruedCents).toBe(25_000);
  });

  it("un pago parcial baja el interés de los días que siguen", () => {
    const sinPago = interestSchedule({ policy: P5, dueDate: DUE, originalCents: 3_000_000, asOf: addDays(DUE, 10) });
    const conPago = interestSchedule({
      policy: P5,
      dueDate: DUE,
      originalCents: 3_000_000,
      asOf: addDays(DUE, 10),
      reductions: [{ date: addDays(DUE, 6), cents: 1_500_000 }],
    });
    // 5 días con 3.000.000 (5.000/día) y 5 con 1.500.000 (2.500/día).
    expect(sinPago.accruedCents).toBe(50_000);
    expect(conPago.accruedCents).toBe(37_500);
  });

  it("saldado: no devenga más", () => {
    const r = interestSchedule({
      policy: P5,
      dueDate: DUE,
      originalCents: 3_000_000,
      asOf: addDays(DUE, 30),
      reductions: [{ date: addDays(DUE, 2), cents: 3_000_000 }],
    });
    expect(r.accruedCents).toBe(5_000);
  });

  it("tope sobre el capital original", () => {
    const r = interestSchedule({ policy: { ...P5, capBp: 2000 }, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 300) });
    expect(r.capCents).toBe(1_000_000);
    expect(r.accruedCents).toBe(1_000_000);
    expect(r.capReached).toBe(true);
    // Los meses después del tope quedan en 0.
    expect(r.months.at(-1)?.accruedCents).toBe(0);
  });

  it("mínimo por mes: debajo no se liquida y pasa al siguiente", () => {
    const pol = { ...P5, monthlyRateBp: 100, minAmountCents: 60_000 };
    const r = interestSchedule({ policy: pol, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 45) });
    // Agosto 46.667 (< 60.000) pasa a septiembre: 46.667 + 28.333 = 75.000.
    expect(r.months).toEqual([
      { month: "2026-08", accruedCents: 46_667, liquidatedCents: 0 },
      { month: "2026-09", accruedCents: 28_333, liquidatedCents: 75_000 },
    ]);
    expect(r.pendingCents).toBe(0);
    const corto = interestSchedule({ policy: pol, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 20) });
    expect(corto.liquidatedCents).toBe(0);
    expect(corto.pendingCents).toBe(corto.accruedCents);
  });

  it("pausas [desde, hasta) y devengo desde una fecha", () => {
    const base = { policy: P5, dueDate: DUE, originalCents: 3_000_000, asOf: addDays(DUE, 10) };
    expect(interestSchedule({ ...base, pauses: [{ from: addDays(DUE, 4), to: addDays(DUE, 8) }] }).accruedCents).toBe(30_000);
    expect(interestSchedule({ ...base, pauses: [{ from: addDays(DUE, 6), to: null }] }).accruedCents).toBe(25_000);
    expect(interestSchedule({ ...base, accrueFrom: addDays(DUE, 9) }).accruedCents).toBe(10_000);
  });

  it("tasa 0 o capital 0: nada", () => {
    expect(interestSchedule({ policy: { ...P5, monthlyRateBp: 0 }, dueDate: DUE, originalCents: 100, asOf: addDays(DUE, 60) }).months).toEqual([]);
    expect(interestSchedule({ policy: P5, dueDate: DUE, originalCents: 0, asOf: addDays(DUE, 60) }).accruedCents).toBe(0);
  });
});

describe("interestSchedule · por mes empezado", () => {
  const PM: InterestPolicy = { ...P5, method: "per_month_started" };
  it("cada bloque de 30 días empezado cobra el mes entero", () => {
    expect(interestSchedule({ policy: PM, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 1) }).accruedCents).toBe(250_000);
    expect(interestSchedule({ policy: PM, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 30) }).accruedCents).toBe(250_000);
    expect(interestSchedule({ policy: PM, dueDate: DUE, originalCents: 5_000_000, asOf: addDays(DUE, 45) }).accruedCents).toBe(500_000);
  });
  it("el bloque cobra sobre el capital de su primer día", () => {
    const r = interestSchedule({
      policy: PM,
      dueDate: DUE,
      originalCents: 5_000_000,
      asOf: addDays(DUE, 45),
      reductions: [{ date: addDays(DUE, 20), cents: 4_000_000 }],
    });
    expect(r.accruedCents).toBe(250_000 + 50_000);
  });
});

describe("simulateInterest", () => {
  it("corre un vencimiento en fin de semana al próximo día hábil, como el cron", () => {
    const r = simulateInterest({ policy: P5, capitalCents: 3_000_000, dueDate: "2026-08-01", asOf: "2026-08-05" });
    expect(r.effectiveDue).toBe("2026-08-03");
    expect(r.shifted).toBe(true);
    expect(r.daysOverdue).toBe(2);
  });
  it("respeta los feriados cargados", () => {
    const r = simulateInterest({ policy: P5, capitalCents: 3_000_000, dueDate: "2026-10-12", asOf: "2026-10-20", holidays: ["2026-10-12"] });
    expect(r.effectiveDue).toBe("2026-10-13");
  });
});

describe("formatos", () => {
  it("puntos básicos", () => {
    expect(formatBp(300)).toBe("3 %");
    expect(formatBp(250)).toBe("2,5 %");
    expect(formatBp(null)).toBe("Sin tope");
    expect(parsePercentToBp("3")).toBe(300);
    expect(parsePercentToBp("2,5")).toBe(250);
    expect(parsePercentToBp("abc")).toBeNull();
  });
});
