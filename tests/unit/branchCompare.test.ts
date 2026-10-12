import { describe, expect, it } from "vitest";
import {
  COMPARE_METRICS,
  bestWorst,
  compareSheets,
  dailySeries,
  deltaVsAverage,
  methodMatrix,
  methodsUnion,
  metricAverage,
  normalizeCompareReport,
  rankByTotal,
  shareOfTotal,
  sheetName,
} from "@/lib/reports/branchCompare";

const raw = {
  stores: [
    {
      store_id: "c",
      name: "Centro",
      short_name: "Cen",
      color: "#112233",
      total: "1000",
      count: 10,
      avg_ticket: 100,
      items_qty: 20,
      returns_total: 50,
      returns_count: 1,
      voids_total: 0,
      margin: 300,
      margin_pct: "30",
      cost_coverage_pct: 100,
      z_count: 2,
      cash_diff: -10,
      cash_diff_abs: 10,
      z_with_diff: 1,
      buyers: 4,
      returning_buyers: 2,
      new_customers: 1,
      by_method: [
        { method: "cash", total: 600, count: 6 },
        { method: "card", total: 400, count: 4 },
      ],
      by_day: [{ day: "2026-10-01", total: 1000, count: 10 }],
    },
    {
      store_id: "n",
      name: "Norte",
      short_name: null,
      color: null,
      total: 500,
      count: 10,
      avg_ticket: 50,
      items_qty: 12,
      returns_total: 0,
      voids_total: 20,
      margin: 100,
      margin_pct: null,
      cost_coverage_pct: 50,
      z_count: 0,
      cash_diff: 0,
      cash_diff_abs: 0,
      buyers: 0,
      returning_buyers: 0,
      new_customers: 3,
      by_method: [{ method: "transfer", total: 500, count: 10 }],
      by_day: [{ day: "2026-10-02", total: 500, count: 10 }],
    },
  ],
  totals: {
    total: 1500,
    count: 20,
    avg_ticket: 75,
    margin: 400,
    margin_pct: 26.7,
  },
};

describe("branchCompare", () => {
  const r = normalizeCompareReport(raw);
  const metric = (k: string) => COMPARE_METRICS.find((m) => m.key === k)!;

  it("normaliza números que llegan como texto y nulls", () => {
    expect(r.stores[0]!.total).toBe(1000);
    expect(r.stores[0]!.margin_pct).toBe(30);
    expect(r.stores[1]!.margin_pct).toBeNull();
    expect(r.stores[1]!.archived).toBe(false);
    expect(r.totals.items_qty).toBe(0);
    expect(normalizeCompareReport(null).stores).toEqual([]);
  });

  it("promedio y diferencia contra el promedio", () => {
    const avg = metricAverage(r.stores, metric("total"));
    expect(avg).toBe(750);
    expect(deltaVsAverage(1000, avg)).toBeCloseTo(33.33, 1);
    expect(deltaVsAverage(10, 0)).toBeNull();
    // margen % sólo promedia las sucursales con dato.
    expect(metricAverage(r.stores, metric("margin_pct"))).toBe(30);
  });

  it("mejor y peor según la dirección de la métrica", () => {
    expect(bestWorst(r.stores, metric("total"))).toEqual({
      best: "c",
      worst: "n",
    });
    expect(bestWorst(r.stores, metric("voids_total"))).toEqual({
      best: "c",
      worst: "n",
    });
    // Empate: no se marca nada.
    expect(bestWorst(r.stores, metric("count"))).toBeNull();
    // Una sola sucursal con dato.
    expect(bestWorst(r.stores, metric("margin_pct"))).toBeNull();
  });

  it("ranking y participación", () => {
    expect(rankByTotal([...r.stores].reverse()).map((s) => s.store_id)).toEqual(
      ["c", "n"],
    );
    const share = shareOfTotal(r.stores);
    expect(share.c).toBeCloseTo(66.67, 1);
    expect(shareOfTotal([]).x).toBeUndefined();
  });

  it("medios por sucursal en monto y en porcentaje", () => {
    const methods = methodsUnion(r.stores);
    expect(methods).toEqual(["cash", "transfer", "card"]);
    const pct = methodMatrix(r.stores, methods, true);
    expect(pct.find((m) => m.method === "cash")!.values).toEqual([60, 0]);
    expect(pct.find((m) => m.method === "transfer")!.values).toEqual([0, 100]);
  });

  it("serie diaria con ceros en los días sin ventas", () => {
    const s = dailySeries(r.stores, ["2026-10-01", "2026-10-02"]);
    expect(s[0]!.values).toEqual([1000, 0]);
    expect(s[1]!.values).toEqual([0, 500]);
  });

  it("nombres de hoja válidos y únicos", () => {
    const used = new Set<string>();
    expect(sheetName("Centro", used)).toBe("Centro");
    expect(sheetName("centro", used)).toBe("centro (2)");
    expect(sheetName("A/B [x]: *?", used)).toBe("A B x");
    expect(sheetName("x".repeat(40), used)).toHaveLength(31);
  });

  it("XLSX: consolidado más una hoja por sucursal", () => {
    const sheets = compareSheets(r, {
      periodLabel: "01/10 al 02/10",
      methodLabel: (m) => m.toUpperCase(),
    });
    expect(sheets.map((s) => s.name)).toEqual(["Consolidado", "Cen", "Norte"]);
    expect(sheets[0]!.rows).toHaveLength(2);
    expect(sheets[0]!.totals?.total).toBe(1500);
    const cen = sheets[1]!;
    expect(cen.rows.some((x) => x.k === "CASH" && x.v === 600)).toBe(true);
    expect(cen.rows.some((x) => x.k === "2026-10-01")).toBe(true);
  });
});
