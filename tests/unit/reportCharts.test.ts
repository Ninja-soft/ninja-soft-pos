import { describe, expect, it } from "vitest";
import {
  byHour,
  cashFlowByDay,
  fillDays,
  hourMatrix,
  peakHour,
  previousRange,
  rangeDays,
} from "@/modules/reports/derive";
import { deltaPct, formatDelta, readChartTheme, truncateLabel } from "@/components/charts/chartTheme";
import { esc, foldOthers, timeSeriesOption, doughnutOption } from "@/components/charts/builders";

const d = (s: string) => new Date(`${s}T00:00:00`);

describe("derive · rangos", () => {
  it("cuenta días inclusivos y arma el período anterior", () => {
    expect(rangeDays(d("2026-10-05"), d("2026-10-11"))).toBe(7);
    const p = previousRange(d("2026-10-05"), d("2026-10-11"));
    expect(p.from.getDate()).toBe(28);
    expect(p.to.getDate()).toBe(4);
    expect(rangeDays(p.from, p.to)).toBe(7);
  });

  it("rellena los días sin ventas con 0", () => {
    const days = fillDays(d("2026-10-01"), d("2026-10-03"), [
      { day: "2026-10-02", total: 500, count: 2 },
    ]);
    expect(days.map((x) => x.total)).toEqual([0, 500, 0]);
    expect(days[1]?.label).toBe("02/10");
  });
});

describe("derive · horas y caja", () => {
  it("arma la matriz día × hora (lunes = 0)", () => {
    // 2026-10-05 es lunes.
    const m = hourMatrix([
      { created_at: new Date(2026, 9, 5, 13, 10).toISOString(), total: 100 },
      { created_at: new Date(2026, 9, 5, 13, 40).toISOString(), total: 50 },
      { created_at: new Date(2026, 9, 11, 20, 0).toISOString(), total: 300 },
    ]);
    expect(m.totals[0]?.[13]).toBe(150);
    expect(m.counts[0]?.[13]).toBe(2);
    expect(m.totals[6]?.[20]).toBe(300);
    expect(byHour(m.totals)[13]).toBe(150);
    expect(peakHour(m.totals)).toEqual({ weekday: 6, hour: 20, total: 300 });
  });

  it("separa ingresos y egresos por día", () => {
    const flow = cashFlowByDay(d("2026-10-01"), d("2026-10-02"), [
      { type: "sale", amount: 1000, created_at: new Date(2026, 9, 1, 10).toISOString() },
      { type: "income", amount: 200, created_at: new Date(2026, 9, 1, 11).toISOString() },
      { type: "expense", amount: 300, created_at: new Date(2026, 9, 2, 9).toISOString() },
      { type: "sale_void", amount: 100, created_at: new Date(2026, 9, 2, 9).toISOString() },
    ]);
    expect(flow.map((x) => [x.inflow, x.outflow])).toEqual([
      [1200, 0],
      [0, 400],
    ]);
  });
});

describe("chartTheme · formato", () => {
  it("calcula variaciones sin base como null", () => {
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(10, 0)).toBeNull();
    expect(formatDelta(-12.34)).toBe("−12,3%");
  });

  it("recorta etiquetas largas", () => {
    expect(truncateLabel("Alfajor triple de chocolate", 10)).toBe("Alfajor t…");
  });

  it("tiene fallback sin DOM (tema oscuro)", () => {
    const t = readChartTheme(null);
    expect(t.isDark).toBe(true);
    expect(t.palette).toHaveLength(6);
  });
});

describe("builders", () => {
  it("escapa HTML de etiquetas de usuario", () => {
    expect(esc('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
  });

  it("pliega el excedente en Otros sin ciclar colores", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, value: 10 - i }));
    const folded = foldOthers(items);
    expect(folded).toHaveLength(6);
    expect(folded[5]?.label).toBe("Otros");
    expect(folded[5]?.value).toBe(5 + 4 + 3 + 2);
  });

  it("agrega zoom en rangos largos y la serie de comparación", () => {
    const ctx = { theme: readChartTheme(null), compact: false, width: 900, reducedMotion: true };
    const n = 60;
    const opt = timeSeriesOption({
      labels: Array.from({ length: n }, (_, i) => String(i)),
      values: Array.from({ length: n }, () => 1),
      name: "Vendido",
      format: "currency",
      kind: "area",
      previous: { values: Array.from({ length: n }, () => 1), labels: [], name: "Período anterior" },
    })(ctx) as { dataZoom?: unknown[]; series: unknown[] };
    expect(opt.dataZoom).toHaveLength(2);
    expect(opt.series).toHaveLength(2);
  });

  it("la dona pone la leyenda abajo en mobile", () => {
    const t = readChartTheme(null);
    const items = [{ label: "Efectivo", value: 10 }];
    const opt = doughnutOption({ items, name: "Total", format: "currency" })({
      theme: t,
      compact: true,
      width: 360,
      reducedMotion: false,
    }) as { legend: { bottom?: number } };
    expect(opt.legend.bottom).toBe(0);
  });
});
