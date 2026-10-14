import { describe, expect, it } from "vitest";
import {
  accountMrr,
  addonsMonthly,
  applyExclusions,
  collectionRisk,
  exclusionReason,
  formatCompactArs,
  logoChurn,
  mrrAt,
  mrrSummary,
  newTenants,
  periodsFor,
  planMonthly,
  ratio,
  statusAt,
  trend,
  trialConversion,
  trialsSummary,
  usageRisk,
  type KpiAccount,
  type StatusChange,
} from "@/lib/internal/saasKpis";

const NOW = new Date("2026-10-13T12:00:00Z");

function acc(over: Partial<KpiAccount> & { tenantId: string }): KpiAccount {
  return {
    name: over.tenantId,
    createdAt: "2026-01-01T00:00:00Z",
    trialEndsAt: null,
    status: "active",
    billingCycle: "monthly",
    isLifetime: false,
    plan: { monthly_price_ars: 60000, yearly_price_ars: 0 },
    planKey: "start",
    planName: "Start",
    addons: [],
    discounts: [],
    ...over,
  };
}

describe("MRR por cuenta", () => {
  it("anual = anual / 12; si el anual vale 0, el mensual", () => {
    expect(planMonthly({ monthly_price_ars: 100, yearly_price_ars: 1080 }, "yearly")).toBe(90);
    expect(planMonthly({ monthly_price_ars: 100, yearly_price_ars: 0 }, "yearly")).toBe(100);
    expect(planMonthly({ monthly_price_ars: 100, yearly_price_ars: 1080 }, "monthly")).toBe(100);
  });

  it("suma addons comprados y vigentes, ignora los regalados y los vencidos", () => {
    const addons = [
      { status: "active", source: "purchased", monthly_price_ars: 15000 },
      { status: "active", source: "granted", monthly_price_ars: null, catalog_price_ars: 15000 },
      { status: "cancelled", source: "purchased", monthly_price_ars: 5000, cancel_at_period_end: true, current_period_end: "2026-10-20" },
      { status: "cancelled", source: "purchased", monthly_price_ars: 7000, cancel_at_period_end: true, current_period_end: "2026-10-01" },
    ];
    expect(addonsMonthly(addons, NOW)).toBe(20000);
  });

  it("aplica descuentos vigentes: porcentaje y después fijo, nunca negativo", () => {
    const a = acc({
      tenantId: "t",
      addons: [{ status: "active", source: "purchased", monthly_price_ars: 40000 }],
      discounts: [
        { kind: "percent", value: 10, valid_from: "2026-01-01", valid_until: null },
        { kind: "fixed", value: 5000, valid_from: "2026-01-01", valid_until: null },
        { kind: "fixed", value: 99999, valid_from: "2026-01-01", valid_until: "2026-02-01" },
        { kind: "percent", value: 50, valid_from: "2026-01-01", valid_until: null, deleted_at: "2026-05-01" },
      ],
    });
    // (60000 + 40000) × 0,9 − 5000
    expect(accountMrr(a, NOW)).toBe(85000);
    const free = acc({ tenantId: "f", discounts: [{ kind: "percent", value: 100, valid_from: null, valid_until: null }] });
    expect(accountMrr(free, NOW)).toBe(0);
  });
});

describe("exclusiones y resumen", () => {
  const accounts = [
    acc({ tenantId: "pago" }),
    acc({ tenantId: "anual", billingCycle: "yearly", plan: { monthly_price_ars: 100000, yearly_price_ars: 960000 } }),
    acc({ tenantId: "vencido", status: "past_due" }),
    acc({ tenantId: "vitalicio", isLifetime: true, plan: { monthly_price_ars: 220000, yearly_price_ars: 0 } }),
    acc({ tenantId: "prueba", isTest: true }),
    acc({ tenantId: "borrado", deletedAt: "2026-09-01T00:00:00Z" }),
    acc({ tenantId: "trial", status: "trial" }),
    acc({ tenantId: "suspendido", status: "suspended" }),
  ];

  it("lifetime, prueba y borrados quedan afuera", () => {
    expect(exclusionReason(accounts[3]!)).toBe("lifetime");
    expect(exclusionReason(accounts[4]!)).toBe("test");
    expect(exclusionReason(accounts[5]!)).toBe("deleted");
  });

  it("MRR, ARR, ARPA y MRR en riesgo coinciden con el cálculo a mano", () => {
    const s = mrrSummary(accounts, new Set(["pago"]), NOW);
    // 60000 + 80000 + 60000
    expect(s.mrr).toBe(200000);
    expect(s.arr).toBe(2400000);
    expect(s.paidAccounts).toBe(3);
    expect(s.arpa).toBeCloseTo(66666.67, 1);
    // past_due (60000) + débito rechazado (60000)
    expect(s.mrrAtRisk).toBe(120000);
    expect(s.byPlan.reduce((x, p) => x + p.accounts, 0)).toBe(3);
  });

  it("caso de la captura: 4 Enterprise, 3 lifetime y uno de prueba → MRR 0", () => {
    const ent = { monthly_price_ars: 220000, yearly_price_ars: 0 };
    const four = [
      acc({ tenantId: "a", isLifetime: true, plan: ent }),
      acc({ tenantId: "b", isLifetime: true, plan: ent }),
      acc({ tenantId: "c", isLifetime: true, plan: ent }),
      acc({ tenantId: "qa", isTest: true, plan: ent }),
    ];
    expect(mrrSummary(four, new Set(), NOW).mrr).toBe(0);
  });
});

describe("estado reconstruido y churn", () => {
  const changes: StatusChange[] = [
    { tenant_id: "baja", at: "2026-10-05T00:00:00Z", from: "active", to: "cancelled" },
    { tenant_id: "susp-vieja", at: "2026-08-20T00:00:00Z", from: "past_due", to: "suspended" },
    { tenant_id: "susp-nueva", at: "2026-10-10T00:00:00Z", from: "past_due", to: "suspended" },
    { tenant_id: "nueva-paga", at: "2026-10-03T00:00:00Z", from: "trial", to: "active" },
    // Un UPDATE posterior sin cambio de estado no aparece (lo filtra la RPC).
  ];
  const accounts = [
    acc({ tenantId: "baja", status: "cancelled" }),
    acc({ tenantId: "susp-vieja", status: "suspended" }),
    acc({ tenantId: "susp-nueva", status: "suspended" }),
    acc({ tenantId: "nueva-paga", status: "active" }),
    acc({ tenantId: "estable", status: "active" }),
    acc({ tenantId: "estable2", status: "active" }),
    acc({ tenantId: "estable3", status: "active" }),
    acc({ tenantId: "creada-despues", status: "active", createdAt: "2026-10-08T00:00:00Z" }),
  ];
  const { current } = periodsFor("mes", NOW);

  it("statusAt toma el estado anterior al primer cambio posterior", () => {
    expect(statusAt(accounts[0]!, changes, current.start)).toBe("active");
    expect(statusAt(accounts[3]!, changes, current.start)).toBe("trial");
    expect(statusAt(accounts[4]!, changes, current.start)).toBe("active");
    expect(statusAt(accounts[7]!, changes, current.start)).toBeNull();
  });

  it("logo churn: canceladas y suspendidas hace más de 30 días sobre las pagas al inicio", () => {
    const r = logoChurn(accounts, changes, current);
    // Pagas al 1/10: baja, susp-nueva (past_due), estable×3 → 5. susp-vieja ya estaba suspendida.
    expect(r.den).toBe(5);
    expect(r.tenants).toEqual(["baja"]);
    expect(r.pct).toBe(20);
  });

  it("MRR al inicio reconstruido para la tendencia", () => {
    expect(mrrAt(accounts, changes, current.start)).toBe(5 * 60000);
  });

  it("muestra chica: menos de 5 en el denominador devuelve n/d", () => {
    expect(ratio(4, 4).pct).toBeNull();
    expect(ratio(0, 0).pct).toBeNull();
    expect(ratio(1, 5).pct).toBe(20);
  });
});

describe("conversión trial → pago por cohorte", () => {
  const { current } = periodsFor("mes", NOW);
  const accounts = [
    acc({ tenantId: "pago-a-tiempo", status: "active", trialEndsAt: "2026-10-02T00:00:00Z" }),
    acc({ tenantId: "pago-tarde", status: "active", trialEndsAt: "2026-10-02T00:00:00Z" }),
    acc({ tenantId: "no-pago", status: "cancelled", trialEndsAt: "2026-10-05T00:00:00Z" }),
    acc({ tenantId: "otro-mes", status: "active", trialEndsAt: "2026-09-02T00:00:00Z" }),
    acc({ tenantId: "pago-antes", status: "active", trialEndsAt: "2026-10-09T00:00:00Z" }),
    acc({ tenantId: "sin-pago-aun", status: "trial", trialEndsAt: "2026-10-12T00:00:00Z" }),
  ];
  const payments = [
    { tenant_id: "pago-a-tiempo", amount: 60000, at: "2026-10-06T00:00:00Z" },
    { tenant_id: "pago-tarde", amount: 60000, at: "2026-10-11T00:00:00Z" },
    { tenant_id: "pago-antes", amount: 60000, at: "2026-10-01T00:00:00Z" },
    { tenant_id: "otro-mes", amount: 60000, at: "2026-10-01T00:00:00Z" },
  ];

  it("cuenta sólo la cohorte cuyo trial terminó en el período", () => {
    const r = trialConversion(accounts, payments, current);
    expect(r.den).toBe(5);
    expect(r.num).toBe(2);
    expect(r.pct).toBe(40);
  });

  it("ya no da 100 % con 4 activos y 0 cancelados", () => {
    const four = [1, 2, 3, 4].map((i) => acc({ tenantId: `x${i}` }));
    expect(trialConversion(four, [], current)).toEqual({ num: 0, den: 0, pct: null });
  });
});

describe("trials, nuevos y riesgo", () => {
  it("trials activos y por vencer en 7 días", () => {
    const r = trialsSummary(
      [
        acc({ tenantId: "a", status: "trial", trialEndsAt: "2026-10-15T00:00:00Z" }),
        acc({ tenantId: "b", status: "trial", trialEndsAt: "2026-11-15T00:00:00Z" }),
        acc({ tenantId: "c", status: "trial", isTest: true, trialEndsAt: "2026-10-15T00:00:00Z" }),
      ],
      NOW,
    );
    expect(r).toEqual({ active: 2, endingIn7d: 1 });
  });

  it("nuevos negocios sin los de prueba", () => {
    const { current } = periodsFor("mes", NOW);
    expect(
      newTenants(
        [
          acc({ tenantId: "a", createdAt: "2026-10-02T00:00:00Z" }),
          acc({ tenantId: "b", createdAt: "2026-10-02T00:00:00Z", isTest: true }),
          acc({ tenantId: "c", createdAt: "2026-09-02T00:00:00Z" }),
        ],
        current,
      ),
    ).toBe(1);
  });

  it("riesgo de cobro: mora y débito rechazado, ordenado por días", () => {
    const r = collectionRisk(
      [
        acc({ tenantId: "mora", status: "past_due" }),
        acc({ tenantId: "susp", status: "suspended" }),
        acc({ tenantId: "rechazo", status: "active" }),
        acc({ tenantId: "ok", status: "active" }),
        acc({ tenantId: "vitalicio", status: "past_due", isLifetime: true }),
      ],
      new Map([
        ["mora", "2026-10-11T12:00:00Z"],
        ["susp", "2026-10-01T12:00:00Z"],
      ]),
      [
        { tenant_id: "rechazo", at: "2026-10-10T00:00:00Z" },
        { tenant_id: "ok", at: "2026-08-01T00:00:00Z" },
      ],
      NOW,
    );
    expect(r.map((x) => x.tenantId)).toEqual(["susp", "mora", "rechazo"]);
    expect(r[1]!.reasons).toContain("2 días de mora");
  });

  it("riesgo de uso: salud < 60 en pagas o trials; trial sin ventas a los 7 días es conversión", () => {
    const r = usageRisk(
      [
        { account: acc({ tenantId: "baja-salud" }), score: 50, reasons: ["Sin ventas hace 121 días"], hasSales: true },
        { account: acc({ tenantId: "sana" }), score: 90, reasons: [], hasSales: true },
        { account: acc({ tenantId: "vitalicio", isLifetime: true }), score: 10, reasons: [], hasSales: false },
        {
          account: acc({ tenantId: "trial-quieto", status: "trial", createdAt: "2026-10-01T00:00:00Z" }),
          score: 70,
          reasons: ["Todavía no vendió"],
          hasSales: false,
        },
      ],
      NOW,
    );
    expect(r.map((x) => [x.tenantId, x.kind])).toEqual([
      ["baja-salud", "uso"],
      ["trial-quieto", "conversion"],
    ]);
  });
});

describe("formato y tendencia", () => {
  it("compacto sin desbordar", () => {
    expect(formatCompactArs(880000)).toBe("$ 880 k");
    expect(formatCompactArs(10560000)).toBe("$ 10,56 M");
    expect(formatCompactArs(12500)).toBe("$ 12,5 k");
    expect(formatCompactArs(950)).toBe("$ 950");
    expect(formatCompactArs(0)).toBe("$ 0");
  });

  it("tendencia contra el período anterior", () => {
    expect(trend(120, 100)).toBe(20);
    expect(trend(80, 100)).toBe(-20);
    expect(trend(5, 0)).toBeNull();
  });

  it("períodos: mes actual contra el anterior completo", () => {
    const { current, previous } = periodsFor("mes", NOW);
    expect(current.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(previous.end.toISOString()).toBe(current.start.toISOString());
    const ant = periodsFor("anterior", NOW);
    expect(ant.current.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("exclusiones de la cobranza (F20-1, §22 #7)", () => {
  it("negocios del staff, exentos y de prueba no cuentan en el MRR ni como nuevos", () => {
    const base = [
      acc({ tenantId: "cliente" }),
      acc({ tenantId: "staff", createdAt: "2026-10-02T00:00:00Z" }),
      acc({ tenantId: "exento" }),
      acc({ tenantId: "qa", createdAt: "2026-10-03T00:00:00Z" }),
    ];
    const accounts = applyExclusions(base, [
      { tenant_id: "staff", reason: "staff_owned" },
      { tenant_id: "exento", reason: "exempt" },
      { tenant_id: "qa", reason: "test" },
    ]);
    expect(accounts.map((a) => exclusionReason(a))).toEqual([null, "staff", "exempt", "test"]);
    expect(mrrSummary(accounts, new Set(), NOW).paidAccounts).toBe(1);
    expect(newTenants(accounts, { start: new Date("2026-10-01T00:00:00Z"), end: NOW })).toBe(0);
  });

  it("sin filas de exclusión devuelve las cuentas tal cual", () => {
    const accounts = [acc({ tenantId: "a" })];
    expect(applyExclusions(accounts, null)).toBe(accounts);
  });
});
