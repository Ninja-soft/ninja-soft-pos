// F20-2 (H128 · ADR-126): movimiento de MRR, retención, aging, DSO y
// efectividad sobre lo que devuelve internal_billing_kpis().
import { describe, expect, it } from "vitest";
import {
  agingBuckets,
  collected,
  collectionEffectiveness,
  daysBetween,
  dso,
  monthLabel,
  monthlyMovements,
  mrrMovement,
  mrrStock,
  retention,
  windowMovement,
  type Boundary,
  type SnapshotRow,
} from "@/lib/billing/kpis";

const row = (tenant_id: string, mrr: number, paying = true, status = "active", last?: string): SnapshotRow => ({
  tenant_id,
  mrr_cents: mrr,
  paying,
  status,
  plan_key: "pro",
  last_paying_day: last ?? null,
});
const b = (day: string, rows: SnapshotRow[], available = true, live = false): Boundary => ({ day, rows, available, live });

describe("mrrStock", () => {
  it("suma sólo cuentas pagas y separa la mora", () => {
    const s = mrrStock([row("a", 100), row("b", 50, true, "past_due"), row("c", 70, false, "trial")]);
    expect(s).toEqual({ mrr_cents: 150, accounts: 2, past_due_cents: 50 });
  });
});

describe("mrrMovement", () => {
  const start = b("2026-08-31", [
    row("keep", 1000),
    row("up", 1000),
    row("down", 1000),
    row("gone", 500),
    row("susp", 400),
  ]);
  const end = b("2026-09-30", [
    row("keep", 1000),
    row("up", 1500),
    row("down", 800),
    row("gone", 500, false, "cancelled", "2026-09-10"),
    row("susp", 400, false, "suspended", "2026-09-20"),
    row("new", 900),
    row("back", 700),
    row("trial", 600, false, "trial"),
  ]);
  const first = { keep: "2026-01-01", up: "2026-01-01", down: "2026-01-01", gone: "2026-01-01", susp: "2026-01-01", new: "2026-09-05", back: "2026-03-01" };
  const m = mrrMovement(start, end, first);

  it("clasifica cada cuenta", () => {
    expect(m.new_cents).toBe(900);
    expect(m.reactivation_cents).toBe(700);
    expect(m.expansion_cents).toBe(500);
    expect(m.contraction_cents).toBe(200);
    expect(m.churn_cents).toBe(900);
    expect(m.new_accounts).toBe(1);
    expect(m.reactivated_accounts).toBe(1);
  });

  it("el puente cuadra: inicio + neto = cierre", () => {
    expect(m.start_cents).toBe(3900);
    expect(m.end_cents).toBe(4900);
    expect(m.start_cents + m.net_cents).toBe(m.end_cents);
  });

  it("churn de clientes: cancelada sí; suspendida hace 10 días no (sí entra en el churn de MRR)", () => {
    expect(m.lost_accounts).toBe(2);
    expect(m.churned_accounts).toBe(1);
  });

  it("suspendida hace más de 30 días cuenta como churn de clientes", () => {
    const e2 = b("2026-10-31", [row("x", 0, false, "suspended", "2026-09-15")]);
    const m2 = mrrMovement(b("2026-09-30", [row("x", 100)]), e2, { x: "2026-01-01" });
    expect(m2.churned_accounts).toBe(1);
  });

  it("una cuenta que desaparece del cierre es churn", () => {
    const m3 = mrrMovement(b("2026-09-30", [row("x", 100)]), b("2026-10-31", []), {});
    expect(m3.churn_cents).toBe(100);
    expect(m3.churned_accounts).toBe(1);
  });

  it("sin primer día pago conocido, es nueva", () => {
    const m4 = mrrMovement(b("2026-09-30", []), b("2026-10-31", [row("z", 300)]), {});
    expect(m4.new_cents).toBe(300);
  });
});

describe("retention", () => {
  it("NRR y GRR sobre la cohorte paga al inicio (sin nuevos ni reactivación)", () => {
    const r = retention({
      start_cents: 10000,
      end_cents: 0,
      new_cents: 5000,
      expansion_cents: 1000,
      reactivation_cents: 2000,
      contraction_cents: 500,
      churn_cents: 1500,
      net_cents: 0,
      start_accounts: 10,
      end_accounts: 0,
      new_accounts: 0,
      reactivated_accounts: 0,
      lost_accounts: 2,
      churned_accounts: 1,
    });
    expect(r.nrr).toBe(90);
    expect(r.grr).toBe(80);
    expect(r.grossRevenueChurn).toBe(20);
    expect(r.logoChurn).toBe(10);
  });

  it("sin MRR al inicio no hay retención; con menos de 5 cuentas el logo churn es n/d", () => {
    const base = mrrMovement(b("2026-09-30", [row("a", 100)]), b("2026-10-31", [row("a", 120)]), {});
    const r = retention(base);
    expect(r.nrr).toBe(120);
    expect(r.logoChurn).toBeNull();
    expect(retention(mrrMovement(b("2026-09-30", []), b("2026-10-31", []), {})).nrr).toBeNull();
  });
});

describe("monthlyMovements y windowMovement", () => {
  const bounds = [
    b("2026-07-31", [], false),
    b("2026-08-31", [row("a", 100)]),
    b("2026-09-30", [row("a", 150), row("b", 50)]),
    b("2026-10-14", [row("b", 50)], true, true),
  ];
  it("un mes por par de cierres; sin foto, movimiento null", () => {
    const mm = monthlyMovements(bounds, { a: "2026-01-01", b: "2026-09-02" });
    expect(mm.map((m) => m.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(mm[0]!.movement).toBeNull();
    expect(mm[0]!.end_mrr_cents).toBe(100);
    expect(mm[1]!.movement!.expansion_cents).toBe(50);
    expect(mm[1]!.movement!.new_cents).toBe(50);
    expect(mm[2]!.live).toBe(true);
    expect(mm[2]!.movement!.churn_cents).toBe(150);
  });
  it("la ventana va del primer cierre con foto al último", () => {
    const w = windowMovement(bounds, { a: "2026-01-01", b: "2026-09-02" })!;
    expect(w.start_cents).toBe(100);
    expect(w.end_cents).toBe(50);
    expect(w.churn_cents).toBe(100);
    expect(w.new_cents).toBe(50);
    expect(windowMovement([bounds[0]!], {})).toBeNull();
  });
});

describe("cobranza", () => {
  it("cobrado bruto, reversas, comisiones y neto", () => {
    expect(collected({ month: "2026-10", payments: 3, gross_cents: 10000, fee_cents: 500, reversal_cents: 2000 })).toEqual({
      gross_cents: 10000,
      fee_cents: 500,
      reversal_cents: 2000,
      collected_cents: 8000,
      net_cents: 7500,
    });
    expect(collected(undefined).net_cents).toBe(0);
  });

  it("aging por días de mora (1-30, 31-60, 61-90, +90) y a vencer", () => {
    const a = agingBuckets(
      [
        { tenant_id: "a", due_date: "2026-10-14", open_cents: 1 },
        { tenant_id: "a", due_date: "2026-10-13", open_cents: 10 },
        { tenant_id: "b", due_date: "2026-09-14", open_cents: 100 },
        { tenant_id: "b", due_date: "2026-09-13", open_cents: 1000 },
        { tenant_id: "c", due_date: "2026-07-16", open_cents: 10000 },
        { tenant_id: "c", due_date: "2026-07-15", open_cents: 100000 },
        { tenant_id: "d", due_date: "2026-01-01", open_cents: 0 },
      ],
      "2026-10-14",
    );
    expect(a).toEqual({
      not_due_cents: 1,
      d1_30: 110,
      d31_60: 1000,
      d61_90: 10000,
      d90_plus: 100000,
      overdue_cents: 111110,
      total_cents: 111111,
      tenants_overdue: 3,
    });
  });

  it("DSO = deuda / cargado en 90 días × 90; sin cargos, null", () => {
    expect(dso(5000, 15000)).toBe(30);
    expect(dso(11452000, 14450000)).toBe(71.3);
    expect(dso(100, 0)).toBeNull();
  });

  it("efectividad: imputado con pagos sobre lo que vencía menos lo condonado", () => {
    expect(collectionEffectiveness({ month: "2026-10", due_cents: 10000, forgiven_cents: 2000, collected_cents: 6000 })).toEqual({
      base_cents: 8000,
      collected_cents: 6000,
      pct: 75,
    });
    expect(collectionEffectiveness({ month: "2026-10", due_cents: 0, forgiven_cents: 0, collected_cents: 0 }).pct).toBeNull();
  });
});

describe("formato", () => {
  it("monthLabel y daysBetween", () => {
    expect(monthLabel("2026-10")).toBe("oct 26");
    expect(daysBetween("2026-09-30", "2026-10-31")).toBe(31);
  });
});
