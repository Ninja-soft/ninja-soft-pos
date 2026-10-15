// =============================================================================
// ADR-135: cotización del dólar oficial (venta) de ArgentinaDatos. Parseo de la
// API, "la del día o la última anterior", manual > API, rangos del gráfico y
// el uso en el motor de liquidación del staff (F21).
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  daysBetween,
  effectiveDaily,
  parseFxResponse,
  parseFxRow,
  rangeStart,
  rateOn,
  rowsSince,
  type DailyFxRate,
} from "@/supabase/functions/_shared/fx/rates";
import { computeSettlement, explainBase, fxDetail, type SettlementInput, type StaffExpense } from "@/supabase/functions/_shared/staff/settlement";
import { fxChartOption, fxDayLabel } from "@/components/internal/fx/fxChartOption";
import { readChartTheme } from "@/components/charts/chartTheme";

describe("parseo de ArgentinaDatos", () => {
  it("toma casa, compra, venta y fecha (forma real de la API)", () => {
    expect(parseFxRow({ casa: "oficial", compra: 1485, venta: 1535, fecha: "2026-10-14" })).toEqual({
      date: "2026-10-14",
      casa: "oficial",
      compra: 1485,
      venta: 1535,
    });
  });

  it("acepta números como texto, coma decimal y redondea a 4 decimales", () => {
    expect(parseFxRow({ casa: "oficial", compra: "1.234,5", venta: "1450,123456", fecha: "2026-10-14T00:00:00.000Z" })).toMatchObject({
      date: "2026-10-14",
      venta: 1450.1235,
    });
  });

  it("descarta filas inválidas: sin fecha, venta ≤ 0, otra casa o basura", () => {
    expect(parseFxRow({ casa: "oficial", compra: 1, venta: 0, fecha: "2026-10-14" })).toBeNull();
    expect(parseFxRow({ casa: "oficial", compra: 1, venta: 10, fecha: "14/10/2026" })).toBeNull();
    expect(parseFxRow({ casa: "blue", compra: 1, venta: 10, fecha: "2026-10-14" })).toBeNull();
    expect(parseFxRow({ casa: "oficial", venta: "abc", fecha: "2026-10-14" })).toBeNull();
    expect(parseFxRow(null)).toBeNull();
    expect(parseFxRow("x")).toBeNull();
    expect(parseFxRow({ casa: "oficial", compra: 0, venta: 10, fecha: "2026-10-14" })?.compra).toBeNull();
  });

  it("lista u objeto suelto; un día repetido gana el último; ordenado por fecha", () => {
    const rows = parseFxResponse([
      { casa: "oficial", compra: 2, venta: 3, fecha: "2026-10-02" },
      { casa: "oficial", compra: 1, venta: 2, fecha: "2026-10-01" },
      { casa: "oficial", compra: 2, venta: 4, fecha: "2026-10-02" },
      { casa: "oficial", venta: -1, fecha: "2026-10-03" },
    ]);
    expect(rows.map((r) => [r.date, r.venta])).toEqual([
      ["2026-10-01", 2],
      ["2026-10-02", 4],
    ]);
    expect(parseFxResponse({ casa: "oficial", compra: 1485, venta: 1535, fecha: "2026-10-15" })).toHaveLength(1);
    expect(parseFxResponse({ error: "Not found" })).toEqual([]);
    expect(parseFxResponse(undefined)).toEqual([]);
    expect(rowsSince(rows, "2026-10-02").map((r) => r.date)).toEqual(["2026-10-02"]);
  });
});

describe("cotización del día o la última anterior (manual > API)", () => {
  const rows: DailyFxRate[] = [
    { date: "2026-10-09", rate: 1500, source: "api" },
    { date: "2026-10-10", rate: 1510, source: "api" },
    { date: "2026-10-10", rate: 1600, source: "manual", note: "BNA" },
    { date: "2026-10-13", rate: 1535, source: "api" },
  ];

  it("una por día y la manual manda sobre la de la API", () => {
    const eff = effectiveDaily(rows);
    expect(eff.map((r) => [r.date, r.rate, r.source])).toEqual([
      ["2026-10-09", 1500, "api"],
      ["2026-10-10", 1600, "manual"],
      ["2026-10-13", 1535, "api"],
    ]);
    // El orden de llegada no importa.
    expect(effectiveDaily([...rows].reverse()).find((r) => r.date === "2026-10-10")!.source).toBe("manual");
  });

  it("la del día exacto", () => {
    expect(rateOn(rows, "2026-10-13")).toMatchObject({ date: "2026-10-13", rate: 1535, lagDays: 0 });
    expect(rateOn(rows, "2026-10-10")).toMatchObject({ rate: 1600, source: "manual", lagDays: 0 });
  });

  it("fin de semana o feriado: la última anterior", () => {
    expect(rateOn(rows, "2026-10-12")).toMatchObject({ date: "2026-10-10", rate: 1600, lagDays: 2 });
    expect(rateOn(rows, "2026-12-01")).toMatchObject({ date: "2026-10-13", lagDays: 49 });
  });

  it("antes de la primera: null", () => {
    expect(rateOn(rows, "2026-10-08")).toBeNull();
    expect(rateOn([], "2026-10-08")).toBeNull();
  });

  it("ignora filas con cotización inválida", () => {
    expect(rateOn([{ date: "2026-10-10", rate: 0, source: "manual" }, { date: "2026-10-09", rate: 1, source: "api" }], "2026-10-10")).toMatchObject({
      date: "2026-10-09",
    });
  });
});

describe("fechas y rangos del gráfico", () => {
  it("suma días y cuenta días sin zonas horarias", () => {
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysISO("2024-12-31", 1)).toBe("2025-01-01");
    expect(daysBetween("2026-10-10", "2026-10-13")).toBe(3);
  });

  it("1M, 3M, 6M, 1A y 2A hacia atrás, con fin de mes acotado", () => {
    expect(rangeStart("2026-10-15", "1M")).toBe("2026-09-15");
    expect(rangeStart("2026-10-15", "3M")).toBe("2026-07-15");
    expect(rangeStart("2026-10-15", "6M")).toBe("2026-04-15");
    expect(rangeStart("2026-10-15", "1A")).toBe("2025-10-15");
    expect(rangeStart("2026-10-15", "2A")).toBe("2024-10-15");
    expect(rangeStart("2026-03-31", "1M")).toBe("2026-02-28");
    expect(rangeStart("2026-01-10", "1M")).toBe("2025-12-10");
  });

  it("opción de ECharts: línea plana, sin área ni gradiente, tooltip con fecha y valor", () => {
    const points: DailyFxRate[] = [
      { date: "2026-10-13", rate: 1535, source: "api" },
      { date: "2026-10-14", rate: 1540.5, source: "manual" },
    ];
    const opt = fxChartOption(points)({ theme: readChartTheme(null), compact: true, width: 360, reducedMotion: true }) as Record<string, unknown>;
    const series = (opt.series as Record<string, unknown>[])[0]!;
    expect(series.type).toBe("line");
    expect(series.areaStyle).toBeUndefined();
    expect(series.smooth).toBe(false);
    expect(series.data).toEqual([
      ["2026-10-13", 1535],
      ["2026-10-14", 1540.5],
    ]);
    const tip = (opt.tooltip as { formatter: (p: unknown) => string }).formatter([{ dataIndex: 1 }]);
    expect(tip).toContain("14/10/2026");
    expect(tip).toMatch(/1.540,50/);
    expect(tip).toContain("Carga manual");
    expect(JSON.stringify(opt)).not.toMatch(/shadowBlur|LinearGradient|colorStops/);
    expect(fxDayLabel("2026-01-05")).toBe("05/01/2026");
  });
});

describe("liquidación del staff con la cotización diaria", () => {
  const base = (over: Partial<SettlementInput> = {}): SettlementInput => ({
    period: "2026-10-01",
    settings: { houseAbsorbsExpenses: true, negativeCarry: true, incomeTaxReserveBp: 0 },
    members: [{ id: "juan", name: "Juan" }],
    shares: [{ member_id: "juan", share_bp: 5000, expense_bp: null, valid_from: "2026-01-01", valid_to: null }],
    clientRules: [],
    appliedSignupRuleIds: [],
    items: [{ source: "payment", id: "p1", tenant_id: "t", tenant_name: "Kiosco", date: "2026-10-05", amount_cents: 10_000_000, fee_cents: 0 }],
    expenses: [],
    fxRates: [],
    adjustments: [],
    carryIn: [],
    ...over,
  });
  const usd = (over: Partial<StaffExpense> = {}): StaffExpense => ({
    id: "e1",
    name: "Servidor",
    category: "servidores",
    amount_cents: 2_000,
    currency: "USD",
    recurrence: "monthly",
    interval_n: null,
    start_date: "2026-01-12",
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

  it("usa la venta del día de la ocurrencia y muestra fuente y fecha", () => {
    const r = computeSettlement(
      base({
        expenses: [usd()],
        dailyRates: [
          { date: "2026-10-11", rate: 1500, source: "api" },
          { date: "2026-10-12", rate: 1520, source: "api" },
          { date: "2026-10-13", rate: 1535, source: "api" },
        ],
        fxRates: [{ period: "2026-10-01", currency: "USD", rate: 9_999 }],
      }),
    );
    expect(r.expenses[0]).toMatchObject({ amount_cents: 2_000 * 1520, fx_rate: 1520, fx_date: "2026-10-12", fx_source: "api" });
    expect(r.errors).toEqual([]);
    expect(fxDetail(r.expenses[0]!)).toBe("USD 20,00 a $ 1.520 (oficial venta del 12/10/2026, ArgentinaDatos)");
    expect(explainBase(r, 0).find((s) => s.label === "Gasto: Servidor")!.detail).toContain("12/10/2026");
  });

  it("la manual del día manda sobre la de la API", () => {
    const r = computeSettlement(
      base({
        expenses: [usd()],
        dailyRates: [
          { date: "2026-10-12", rate: 1520, source: "api" },
          { date: "2026-10-12", rate: 1600, source: "manual" },
        ],
      }),
    );
    expect(r.expenses[0]).toMatchObject({ fx_rate: 1600, fx_source: "manual" });
  });

  it("sin la del día usa la última anterior; si está muy vieja, avisa", () => {
    const near = computeSettlement(base({ expenses: [usd()], dailyRates: [{ date: "2026-10-09", rate: 1490, source: "api" }] }));
    expect(near.expenses[0]).toMatchObject({ fx_rate: 1490, fx_date: "2026-10-09" });
    expect(near.warnings).toEqual([]);
    const old = computeSettlement(base({ expenses: [usd()], dailyRates: [{ date: "2026-09-01", rate: 1400, source: "api" }] }));
    expect(old.expenses[0]!.fx_rate).toBe(1400);
    expect(old.warnings.join(" ")).toMatch(/01\/09\/2026/);
  });

  it("sin diaria anterior cae en la mensual vieja; sin nada, error", () => {
    const monthly = computeSettlement(
      base({ expenses: [usd()], dailyRates: [{ date: "2026-10-20", rate: 1550, source: "api" }], fxRates: [{ period: "2026-10-01", currency: "USD", rate: 1450 }] }),
    );
    expect(monthly.expenses[0]).toMatchObject({ fx_rate: 1450, fx_source: "monthly", fx_date: null });
    const none = computeSettlement(base({ expenses: [usd()], dailyRates: [] }));
    expect(none.errors).toHaveLength(1);
  });
});
