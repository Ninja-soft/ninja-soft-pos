// Prorrateo de la cobranza de la plataforma (F20-10 · H136 · ADR-131): espejo
// de platform_prorate_cents y platform_proration_core (la prueba de PGlite
// compara casos al azar contra el SQL).
import { describe, expect, it } from "vitest";
import {
  addMonthsYmd,
  daysBetween,
  percentToBp,
  prorateCents,
  prorationKind,
  prorationQuote,
  type ProrationQuoteInput,
} from "@/lib/billing/proration";
import { prorationCents } from "@/lib/billing/ledger";

const base: ProrationQuoteInput = {
  fromCycle: "monthly",
  toCycle: "monthly",
  fromCycleCents: 6_000_000,
  toCycleCents: 9_000_000,
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  today: "2026-10-11",
  percentBp: 0,
  charged: true,
};

describe("prorateCents", () => {
  it("proporcional a los días que quedan", () => {
    expect(prorateCents(9_000_000, 0, 20, 30)).toBe(6_000_000);
    expect(prorateCents(6_000_000, 1000, 20, 30)).toBe(3_600_000);
  });

  it("redondea al centavo, mitad para arriba", () => {
    // 100 × 1 / 3 = 33,33 → 33; 100 × 2 / 3 = 66,67 → 67; 1 × 1 / 2 = 0,5 → 1.
    expect(prorateCents(100, 0, 1, 3)).toBe(33);
    expect(prorateCents(100, 0, 2, 3)).toBe(67);
    expect(prorateCents(1, 0, 1, 2)).toBe(1);
  });

  it("nunca más que el período ni con datos inválidos", () => {
    expect(prorateCents(9_000, 0, 45, 30)).toBe(9_000);
    expect(prorateCents(0, 0, 10, 30)).toBe(0);
    expect(prorateCents(9_000, 0, 0, 30)).toBe(0);
    expect(prorateCents(9_000, 0, 10, 0)).toBe(0);
    expect(prorateCents(9_000, 10000, 10, 30)).toBe(0);
  });

  it("importes grandes sin perder precisión", () => {
    expect(prorateCents(10_000_000_000, 1250, 183, 365)).toBe(4_386_986_301);
  });

  it("mismo resultado que el prorrateo de F20-1 (prorationCents)", () => {
    const old = prorationCents({
      oldCycleAmount: 60000,
      newCycleAmount: 90000,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      today: "2026-10-11",
      percentOff: 10,
    });
    const q = prorationQuote({ ...base, percentBp: percentToBp(10) });
    expect(q.chargeCents).toBe(old?.totalCents);
    expect(q.debitCents).toBe(old?.debitCents);
    expect(q.creditCents).toBe(old?.creditCents);
  });
});

describe("fechas", () => {
  it("suma meses como Postgres (fin de mes)", () => {
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonthsYmd("2026-10-14", 12)).toBe("2027-10-14");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });
});

describe("prorationQuote", () => {
  it("upgrade inmediato: cargo por la diferencia que vence con el próximo cobro", () => {
    const q = prorationQuote(base);
    expect(q.kind).toBe("upgrade");
    expect(q.timing).toBe("immediate");
    expect(q.effect).toBe("charge");
    expect(q).toMatchObject({ days: 30, daysLeft: 20, debitCents: 6_000_000, creditCents: 4_000_000, chargeCents: 2_000_000 });
  });

  it("upgrade sin el cargo del período generado: sin prorrateo (sale con el plan nuevo)", () => {
    const q = prorationQuote({ ...base, charged: false });
    expect(q.effect).toBe("none");
    expect(q.chargeCents).toBe(0);
  });

  it("upgrade programado al fin del período: sin plata", () => {
    const q = prorationQuote({ ...base, timing: "period_end" });
    expect(q.effect).toBe("scheduled");
    expect(q.effectiveOn).toBe("2026-10-31");
  });

  it("downgrade: por defecto al fin del período; inmediato deja a favor lo no usado", () => {
    const d = { ...base, fromCycleCents: 9_000_000, toCycleCents: 6_000_000 };
    expect(prorationQuote(d)).toMatchObject({ kind: "downgrade", timing: "period_end", effect: "scheduled", bonusCents: 0 });
    expect(prorationQuote({ ...d, timing: "immediate" })).toMatchObject({ effect: "credit", bonusCents: 2_000_000 });
  });

  it("mismo precio: sin movimientos, inmediato", () => {
    const q = prorationQuote({ ...base, toCycleCents: 6_000_000 });
    expect(q).toMatchObject({ kind: "lateral", timing: "immediate", effect: "none" });
  });

  it("mensual a anual: período nuevo desde hoy y lo no usado baja el cargo anual", () => {
    const q = prorationQuote({ ...base, toCycle: "yearly", toCycleCents: 60_000_000, newPeriodSubtotalCents: 60_000_000 });
    expect(q.kind).toBe("cycle_up");
    expect(q.effect).toBe("charge");
    expect(q.appliedCreditCents).toBe(4_000_000);
    expect(q.chargeCents).toBe(56_000_000);
    expect(q.newPeriod).toEqual({ start: "2026-10-11", end: "2027-10-11" });
  });

  it("anual a mensual inmediato: cargo mensual y lo no usado del anual a favor", () => {
    const q = prorationQuote({
      ...base,
      fromCycle: "yearly",
      toCycle: "monthly",
      fromCycleCents: 72_000_000,
      toCycleCents: 6_000_000,
      periodStart: "2026-01-01",
      periodEnd: "2027-01-01",
      today: "2026-10-11",
      timing: "immediate",
      newPeriodSubtotalCents: 6_000_000,
    });
    expect(q.kind).toBe("cycle_down");
    expect(q.effect).toBe("charge_and_credit");
    expect(q.chargeCents).toBe(6_000_000);
    expect(q.bonusCents).toBe(prorateCents(72_000_000, 0, 82, 365));
    expect(q.newPeriod?.end).toBe("2026-11-11");
  });

  it("anual a mensual por defecto: al fin del período", () => {
    const q = prorationQuote({ ...base, fromCycle: "yearly", toCycle: "monthly" });
    expect(q).toMatchObject({ kind: "cycle_down", timing: "period_end", effect: "scheduled" });
  });

  it("cambio de ciclo sin cargo previo: sin crédito", () => {
    const q = prorationQuote({ ...base, toCycle: "yearly", toCycleCents: 60_000_000, charged: false });
    expect(q.creditCents).toBe(0);
    expect(q.chargeCents).toBe(60_000_000);
  });

  it("clasifica el tipo de cambio", () => {
    expect(prorationKind({ fromCycle: "monthly", toCycle: "yearly", fromCycleCents: 1, toCycleCents: 1 })).toBe("cycle_up");
    expect(prorationKind({ fromCycle: "yearly", toCycle: "monthly", fromCycleCents: 1, toCycleCents: 1 })).toBe("cycle_down");
    expect(prorationKind({ fromCycle: "monthly", toCycle: "monthly", fromCycleCents: 2, toCycleCents: 1 })).toBe("downgrade");
  });
});
