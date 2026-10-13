// Retenciones como agente (F18 · H106, ADR-079): cálculo puro con la matriz
// compartida con la integración (paridad con _tax_retention_compute).
import { describe, expect, it } from "vitest";
import {
  basesFromAllocations,
  computeRetentions,
  effectiveGananciasCondition,
  exemptionKey,
  explainRetention,
  pct,
  round2,
  scaleAmount,
  type RetConcept,
  type RetContext,
  type RetLine,
} from "@/lib/tax/retentions";
import { CONCEPTS, RET_CASES, SCALE_RG830, type RetCase } from "../fixtures/retentionMatrix";

function contextOf(c: RetCase): RetContext {
  const bases = c.invoice
    ? basesFromAllocations(
        [{ invoice_id: "inv", amount: c.invoice.alloc }],
        [{ id: "inv", ...c.invoice }],
        0,
      )
    : basesFromAllocations([], [], c.amount ?? 0);
  const gan: RetConcept | null = c.supplier.ganancias_concept
    ? CONCEPTS[`ganancias:${c.supplier.ganancias_concept}`] ?? null
    : null;
  const suss: RetConcept | null = c.supplier.suss_code ? CONCEPTS[`suss:${c.supplier.suss_code}`] ?? null : null;
  const exemptions: Record<string, number> = {};
  for (const e of c.exemptions ?? []) exemptions[exemptionKey(e.tax, e.jurisdiction)] = e.pct;
  return {
    regimes: c.regimes.map((r) => ({ ...r, id: r.key })),
    supplier: c.supplier as RetContext["supplier"],
    bases,
    ganancias: gan,
    suss,
    scale: gan?.uses_scale ? SCALE_RG830 : [],
    prior: c.prior ?? { base: 0, withheld: 0 },
    padronRates: Object.fromEntries(c.regimes.map((r) => [r.key, c.padron?.[r.key] ?? null])),
    exemptions,
  };
}

describe("computeRetentions · matriz compartida con SQL", () => {
  for (const c of RET_CASES) {
    it(c.name, () => {
      const r = computeRetentions(contextOf(c));
      expect(r.total).toBe(c.expectTotal);
      for (const e of c.expect) {
        const l = r.lines.find((x) => x.regime_id === e.key);
        expect(l, e.key).toBeDefined();
        expect({ applies: l!.applies, reason: l!.reason, amount: l!.amount }).toEqual({
          applies: e.applies,
          reason: e.reason,
          amount: e.amount,
        });
        expect(explainRetention(l!).length).toBeGreaterThan(10);
      }
    });
  }
});

describe("Ganancias RG 830 · detalle del acumulado mensual", () => {
  const base = RET_CASES.find((c) => c.name.startsWith("Ganancias descuenta"))!;

  it("guarda acumulado, mínimo, sujeto, retención del mes y lo ya retenido", () => {
    const l = computeRetentions(contextOf(base)).lines[0]!;
    expect(l).toMatchObject({
      prior_base: 100000,
      accumulated_base: 120000,
      non_taxable_min: 67170,
      taxable_base: 52830,
      month_total: 1056.6,
      prior_withheld: 656.6,
      computed: 400,
      amount: 400,
      rate: 2,
      rate_source: "registered",
      accumulates: true,
    });
  });

  it("si lo ya retenido cubre el mes no retiene", () => {
    const l = computeRetentions(contextOf({ ...base, prior: { base: 100000, withheld: 2000 } })).lines[0]!;
    expect(l.reason).toBe("already_withheld");
    expect(l.amount).toBe(0);
    expect(l.computed).toBe(0);
    expect(l.accumulates).toBe(true);
  });

  it("los pagos que no retuvieron acumulan (accumulates) y los monotributistas no", () => {
    const below = RET_CASES.find((c) => c.name.includes("mínimo no sujeto"))!;
    expect(computeRetentions(contextOf(below)).lines[0]!.accumulates).toBe(true);
    const mono = RET_CASES.find((c) => c.name.includes("monotributista"))!;
    expect(computeRetentions(contextOf(mono)).lines[0]!.accumulates).toBe(false);
  });

  it("dos pagos seguidos del mes suman lo mismo que uno solo por el total", () => {
    const one = computeRetentions(contextOf({ ...base, amount: 150000, prior: undefined })).total;
    const first = computeRetentions(contextOf({ ...base, amount: 100000, prior: undefined })).lines[0]!;
    const second = computeRetentions(
      contextOf({ ...base, amount: 50000, prior: { base: 100000, withheld: first.amount } }),
    ).total;
    expect(round2(first.amount + second)).toBe(one);
  });

  it("no inscripto: no descuenta el mínimo salvo que el concepto lo diga", () => {
    const c = RET_CASES.find((x) => x.name.includes("no inscripto: sin mínimo"))!;
    const ctx = contextOf(c);
    expect(computeRetentions(ctx).lines[0]!.non_taxable_min).toBe(0);
    const withMin = { ...ctx, ganancias: { ...ctx.ganancias!, unregistered_min_applies: true } };
    expect(computeRetentions(withMin).lines[0]!.reason).toBe("below_non_taxable");
  });

  it("sin condición cargada se toma como inscripto; monotributo manda", () => {
    expect(
      effectiveGananciasCondition({ iva_condition: "responsable_inscripto", cuit: null, ganancias_condition: null, ganancias_concept: null, suss_code: null }),
    ).toBe("inscripto");
    expect(
      effectiveGananciasCondition({ iva_condition: "monotributo", cuit: null, ganancias_condition: "inscripto", ganancias_concept: null, suss_code: null }),
    ).toBe("monotributo");
  });
});

describe("escala y redondeos", () => {
  it("escala del Anexo VIII por tramo", () => {
    expect(scaleAmount(0, SCALE_RG830)).toBe(0);
    expect(scaleAmount(1000, SCALE_RG830)).toBe(50);
    expect(scaleAmount(8000, SCALE_RG830)).toBe(400);
    expect(scaleAmount(8000.01, SCALE_RG830)).toBe(400);
    expect(scaleAmount(32830, SCALE_RG830)).toBe(3437.7);
    expect(scaleAmount(100000, SCALE_RG830)).toBe(19880);
  });

  it("porcentaje en centavos, mitad hacia arriba, sin errores de coma flotante", () => {
    expect(pct(32830.25, 2)).toBe(656.61);
    expect(pct(0.25, 2)).toBe(0.01);
    expect(pct(0.24, 2)).toBe(0);
    expect(pct(1_000_000_000, 28)).toBe(280_000_000);
    expect(pct(100, 1.755)).toBe(1.76);
    expect(pct(33.33, 3)).toBe(1);
  });

  it("bases desde la imputación: proporción sin IVA, neto gravado, IVA y total", () => {
    const b = basesFromAllocations(
      [{ invoice_id: "a", amount: 60500 }, { invoice_id: "b", amount: 10000 }, { invoice_id: "x", amount: 99 }],
      [
        { id: "a", total: 121000, net_total: 100000, vat_total: 21000, exempt_amount: 0, non_taxed_amount: 0 },
        { id: "b", total: 10000, net_total: 0, vat_total: 0, exempt_amount: 10000, non_taxed_amount: 0 },
      ],
      123,
    );
    expect(b).toEqual({ net: 60000, net_taxed: 50000, total: 70500, vat: 10500 });
    expect(basesFromAllocations([], [], 1234.567)).toEqual({ net: 1234.57, net_taxed: 1234.57, total: 1234.57, vat: 0 });
  });
});

describe("regímenes genéricos", () => {
  const ctx = (over: Partial<RetContext> = {}): RetContext => ({
    regimes: [
      {
        id: "r", tax: "iibb", jurisdiction: "902", name: "IIBB", padron_source: "arba", default_rate: 1,
        rates_by_condition: { monotributo: 3 }, base_kind: "net", min_base: 50000, min_amount: 0,
        applies_to: ["responsable_inscripto", "monotributo"],
      },
    ],
    supplier: { iva_condition: "responsable_inscripto", cuit: "30712345671", ganancias_condition: null, ganancias_concept: null, suss_code: null },
    bases: { net: 100000, net_taxed: 100000, total: 121000, vat: 21000 },
    ganancias: null,
    suss: null,
    scale: [],
    prior: { base: 0, withheld: 0 },
    padronRates: { r: null },
    exemptions: {},
    ...over,
  });
  const one = (c: RetContext): RetLine => computeRetentions(c).lines[0]!;

  it("padrón antes que condición antes que general", () => {
    expect(one(ctx({ padronRates: { r: 2 } }))).toMatchObject({ rate: 2, rate_source: "padron", amount: 2000 });
    expect(
      one(ctx({ supplier: { ...ctx().supplier, iva_condition: "monotributo" } })),
    ).toMatchObject({ rate: 3, rate_source: "condition", amount: 3000 });
    expect(one(ctx())).toMatchObject({ rate: 1, rate_source: "default", amount: 1000 });
  });

  it("padrón en 0 no retiene", () => {
    expect(one(ctx({ padronRates: { r: 0 } })).reason).toBe("no_rate");
  });

  it("exclusión parcial reduce la alícuota y la jurisdicción importa", () => {
    expect(one(ctx({ exemptions: { "iibb:902": 40 } }))).toMatchObject({ rate: 0.6, amount: 600 });
    expect(one(ctx({ exemptions: { "iibb:901": 100 } })).applies).toBe(true);
  });

  it("mínimo de base", () => {
    expect(one(ctx({ bases: { net: 40000, net_taxed: 40000, total: 48400, vat: 8400 } })).reason).toBe("below_min_base");
  });

  it("explica cada motivo en lenguaje simple", () => {
    const l = one(ctx({ padronRates: { r: 2 } }));
    expect(explainRetention(l)).toContain("padrón");
  });
});
