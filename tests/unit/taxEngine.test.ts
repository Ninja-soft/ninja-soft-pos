import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import {
  allocate,
  computeSaleTaxes,
  perceptionAmount,
  priceToFinal,
  resolvePerceptionRate,
  roundHalf,
  type InternalTax,
} from "@/lib/tax/engine";
import { EMPTY_WORLD, resolveUnitPrice, type PricingWorld } from "@/lib/prices/resolve";
import { TAX_CASES, TAX_PRODUCTS, matrixLineInputs } from "../fixtures/taxMatrix";

// Motor de impuestos (ADR-068): el lado TS de la matriz de paridad. El lado SQL
// corre la MISMA matriz en tests/integration/rls-impuestos.test.ts.

describe("computeSaleTaxes · matriz de paridad", () => {
  for (const c of TAX_CASES) {
    it(c.name, () => {
      const r = computeSaleTaxes({
        lines: matrixLineInputs(c),
        total: c.total,
        discriminates: c.emitter === "responsable_inscripto",
        internalEnabled: true,
      });
      expect(
        r.lines.map((l) => ({ code: l.rateCode, taxed: l.taxedTotal, net: l.net, iva: l.iva, internal: l.internal })),
      ).toEqual(c.expected.lines);
      expect(r.iva.map((g) => ({ code: g.code, base: g.base, amount: g.amount }))).toEqual(c.expected.iva);
      expect(r.netTaxed).toBe(c.expected.netTaxed);
      expect(r.netExempt).toBe(c.expected.netExempt);
      expect(r.netUntaxed).toBe(c.expected.netUntaxed);
      expect(r.ivaTotal).toBe(c.expected.ivaTotal);
      expect(r.internalTotal).toBe(c.expected.internalTotal);
    });
  }

  it("cada línea cierra: precio final = neto + IVA + internos, y la suma da el total", () => {
    for (const c of TAX_CASES) {
      const r = computeSaleTaxes({
        lines: matrixLineInputs(c),
        total: c.total,
        discriminates: c.emitter === "responsable_inscripto",
        internalEnabled: true,
      });
      let sum = 0;
      for (const l of r.lines) {
        expect(roundHalf((l.net + l.iva + l.internal) * 100)).toBe(roundHalf(l.taxedTotal * 100));
        sum += roundHalf(l.taxedTotal * 100);
      }
      expect(sum).toBe(roundHalf(c.total * 100));
    }
  });

  it("el IVA de cada alícuota difiere de base × alícuota en un centavo como mucho (AlicIva)", () => {
    for (const c of TAX_CASES) {
      const r = computeSaleTaxes({
        lines: matrixLineInputs(c),
        total: c.total,
        discriminates: true,
        internalEnabled: true,
      });
      for (const g of r.iva) {
        expect(Math.abs(roundHalf(g.amount * 100) - roundHalf(g.base * g.rate))).toBeLessThanOrEqual(1);
      }
    }
  });

  it("sin la feature de internos no se discriminan", () => {
    const c = TAX_CASES.find((x) => x.name.startsWith("internos 20"))!;
    const r = computeSaleTaxes({ lines: matrixLineInputs(c), total: c.total, discriminates: true, internalEnabled: false });
    expect(r.internalTotal).toBe(0);
    expect(r.lines[0]).toMatchObject({ net: 1652.89, iva: 347.11 });
  });

  it("venta en cero (sesión de pack) no rompe", () => {
    const r = computeSaleTaxes({
      lines: [{ gross: 0, quantity: 1, rateCode: "21" }],
      total: 0,
      discriminates: true,
      internalEnabled: true,
    });
    expect(r.lines[0]).toMatchObject({ taxedTotal: 0, net: 0, iva: 0 });
    expect(r.iva).toEqual([{ code: "21", arcaId: 5, rate: 21, base: 0, amount: 0 }]);
  });
});

describe("allocate (resto mayor)", () => {
  it("reparte exacto y desempata por la primera línea", () => {
    expect(allocate(2500, [1000, 1000, 1000])).toEqual([834, 833, 833]);
    expect(allocate(100, [1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14]);
  });
  it("sin pesos o sin total, todo en cero", () => {
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [10, 20])).toEqual([0, 0]);
  });
  it("totales grandes sin perder precisión", () => {
    const r = allocate(99_999_999_999, [33_333_333_333, 33_333_333_333, 33_333_333_334]);
    expect(r.reduce((a, b) => a + b, 0)).toBe(99_999_999_999);
  });
});

describe("priceToFinal (resolver)", () => {
  const base = { rateCode: "21" as const, discriminates: true, internalEnabled: true, listIncludesIva: true };
  const pct: InternalTax = { mode: "pct", base: "price", rate: 20, amount: null, included: true };

  it("lista con IVA y sin internos: no cambia", () => {
    expect(priceToFinal(1210, base)).toBe(1210);
  });
  it("lista neta: suma el IVA de la alícuota", () => {
    expect(priceToFinal(1000, { ...base, listIncludesIva: false })).toBe(1210);
    expect(priceToFinal(1000, { ...base, rateCode: "10.5", listIncludesIva: false })).toBe(1105);
    expect(priceToFinal(500, { ...base, rateCode: "exento", listIncludesIva: false })).toBe(500);
    expect(priceToFinal(1000, { ...base, discriminates: false, listIncludesIva: false })).toBe(1000);
  });
  it("internos sobre precio: el final es el mismo cargue como cargue", () => {
    // N = 1000, internos 25 % efectivo = 250, IVA 210.
    expect(priceToFinal(1210, { ...base, internal: { ...pct, included: false } })).toBe(1460);
    expect(priceToFinal(1250, { ...base, internal: pct, listIncludesIva: false })).toBe(1460);
    expect(priceToFinal(1000, { ...base, internal: { ...pct, included: false }, listIncludesIva: false })).toBe(1460);
    expect(priceToFinal(1460, { ...base, internal: pct })).toBe(1460);
  });
  it("internos fijos y sobre costo adicionales", () => {
    const fixed: InternalTax = { mode: "fixed", base: "price", rate: null, amount: 100, included: false };
    expect(priceToFinal(1400, { ...base, internal: fixed })).toBe(1500);
    const cost: InternalTax = { mode: "pct", base: "cost", rate: 10, amount: null, included: false };
    expect(priceToFinal(1210, { ...base, internal: cost, unitCost: 400 })).toBe(1250);
  });
  it("sin la feature, los internos no suman", () => {
    expect(priceToFinal(1210, { ...base, internalEnabled: false, internal: { ...pct, included: false } })).toBe(1210);
  });
});

describe("percepciones", () => {
  it("alícuota: padrón, por condición, general y exclusión", () => {
    expect(resolvePerceptionRate({ usesPadron: true, padronRate: 1.5, condition: "responsable_inscripto", defaultRate: 3 })).toBe(1.5);
    expect(resolvePerceptionRate({ usesPadron: true, padronRate: null, condition: "responsable_inscripto", defaultRate: 3 })).toBe(3);
    expect(resolvePerceptionRate({ usesPadron: true, padronRate: null, condition: "x", defaultRate: null })).toBeNull();
    expect(
      resolvePerceptionRate({
        usesPadron: false,
        padronRate: null,
        condition: "no_categorizado",
        ratesByCondition: { no_categorizado: 10.5 },
        defaultRate: 3,
      }),
    ).toBe(10.5);
    expect(
      resolvePerceptionRate({ usesPadron: true, padronRate: 1.5, condition: "x", defaultRate: null, exemptionPct: 50 }),
    ).toBe(0.75);
    expect(resolvePerceptionRate({ usesPadron: true, padronRate: 0, condition: "x", defaultRate: 3 })).toBe(0);
  });

  it("monto con base y mínimos", () => {
    const b = { netTaxed: 11289.22, net: 11589.22, total: 14000 };
    expect(perceptionAmount({ baseKind: "net_taxed", rate: 3, minBase: 0, minAmount: 0 }, b)).toEqual({
      base: 11289.22,
      amount: 338.68,
    });
    expect(perceptionAmount({ baseKind: "net", rate: 1.5, minBase: 0, minAmount: 0 }, b)).toEqual({
      base: 11589.22,
      amount: 173.84,
    });
    expect(perceptionAmount({ baseKind: "total", rate: 1, minBase: 20000, minAmount: 0 }, b)).toBeNull();
    expect(perceptionAmount({ baseKind: "net", rate: 0.01, minBase: 0, minAmount: 50 }, b)).toBeNull();
  });
});

describe("resolveUnitPrice con impuestos (ADR-068)", () => {
  const world = (over: Partial<PricingWorld> = {}): PricingWorld => ({
    ...EMPTY_WORLD,
    lists: [
      { id: "neta", name: "Mayorista neto", channel: "custom", adjustment_pct: null, prices_include_tax: false, pos_selectable: true },
    ],
    items: [{ price_list_id: "neta", product_id: "p", variant_id: null, price: 1000 }],
    tax: {
      discriminates: true,
      internalEnabled: true,
      products: {
        p: { rate_code: "21", mode: "none", base: "price", rate: null, amount: null, included: true, cost: null, variants: { v: "10.5" } },
        f: { rate_code: "21", mode: "fixed", base: "price", rate: null, amount: 100, included: false, cost: null },
      },
    },
    ...over,
  });

  it("lista neta: suma el IVA del producto o de la variante", () => {
    expect(resolveUnitPrice(world(), { productId: "p", basePrice: 1210, listId: "neta" }).price).toBe(1210);
    expect(resolveUnitPrice(world(), { productId: "p", variantId: "v", basePrice: 1210, listId: "neta" }).price).toBe(1105);
  });

  it("internos adicionales se suman aunque no haya lista", () => {
    expect(resolveUnitPrice(world(), { productId: "f", basePrice: 1400 }).price).toBe(1500);
  });

  it("sin datos fiscales el precio de lista es el final (compatibilidad)", () => {
    expect(resolveUnitPrice(world({ tax: null }), { productId: "p", basePrice: 1210, listId: "neta" }).price).toBe(1000);
  });
});

// Generador del sembrado SQL para correr la matriz en PGlite a mano:
//   TAX_MATRIX_SQL=ruta.sql pnpm exec vitest run tests/unit/taxEngine.test.ts
const out = process.env.TAX_MATRIX_SQL;
if (out) {
  const T = "11111111-1111-1111-1111-111111111111";
  const q = (v: unknown) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
  const lines: string[] = [];
  for (const p of TAX_PRODUCTS) {
    const it = p.internal;
    lines.push(
      `insert into products (id, tenant_id, name, price, cost, tax_rate_code, internal_tax_mode, internal_tax_base, internal_tax_rate, internal_tax_amount, internal_tax_included, has_variants) values (${q(p.id)}, '${T}', ${q(p.name)}, ${p.price}, ${p.cost ?? "null"}, ${q(p.rate_code)}, ${q(it?.mode ?? "none")}, ${q(it?.base ?? "price")}, ${it?.rate ?? "null"}, ${it?.amount ?? "null"}, ${it?.included ?? true}, ${Boolean(p.variants)});`,
    );
    for (const v of p.variants ?? []) {
      lines.push(
        `insert into product_variants (id, tenant_id, product_id, option1, tax_rate_code) values (${q(v.id)}, '${T}', ${q(p.id)}, ${q(v.key)}, ${q(v.rate_code)});`,
      );
    }
  }
  lines.push("create temp table tax_out(i int, got jsonb);");
  TAX_CASES.forEach((c, i) => {
    lines.push(`update tax_settings set iva_condition = ${q(c.emitter)} where tenant_id = '${T}';`);
    const items = c.items.map((it) => {
      const p = it.product ? TAX_PRODUCTS.find((x) => x.key === it.product)! : null;
      const v = p && it.variant ? p.variants?.find((x) => x.key === it.variant) : null;
      return { product_id: p?.id ?? null, variant_id: v?.id ?? null, quantity: it.quantity, unit_price: it.unit_price, discount: it.discount ?? 0 };
    });
    lines.push(`insert into tax_out values (${i}, sale_tax_preview(${q(JSON.stringify(items))}::jsonb, ${c.total}));`);
  });
  lines.push("select i, got -> 'lines' as lines, got -> 'iva' as iva, got ->> 'net_taxed' as nt, got ->> 'iva_total' as it, got ->> 'internal_total' as int from tax_out order by i;");
  writeFileSync(out, lines.join("\n") + "\n");
}
