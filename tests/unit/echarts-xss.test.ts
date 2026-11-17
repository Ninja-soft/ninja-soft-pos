import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readChartTheme } from "@/components/charts/chartTheme";
import { doughnutOption, rankingBarOption, stackedBarOption } from "@/components/charts/builders";

// OPS-46: GHSA-fgmj-fm8m-jvvx (ECharts < 6.1.0) inyecta series.data[i].name
// sin escapar en el tooltip por defecto de la serie `lines`. La app no registra
// esa serie y todos sus tooltips usan formatters propios que escapan el texto
// del usuario (nombres de producto, categorías, medios). Estos tests fijan las
// dos cosas hasta el salto a ECharts 6.

const XSS = `<img src=x onerror="alert(1)">`;
const ctx = { theme: readChartTheme(null), compact: false, width: 900, reducedMotion: true };

type Tooltip = { tooltip: { formatter: (p: unknown) => string } };

function expectEscaped(html: string) {
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
}

describe("ECharts · labels del usuario escapados en el tooltip (OPS-46)", () => {
  it("ranking: nombre de producto y nota", () => {
    const opt = rankingBarOption({
      items: [{ label: XSS, value: 10, note: XSS }],
      name: XSS,
      format: "currency",
    })(ctx) as unknown as Tooltip;
    expectEscaped(opt.tooltip.formatter({ dataIndex: 0 }));
  });

  it("dona: nombre del segmento", () => {
    const opt = doughnutOption({ items: [{ label: XSS, value: 10 }], name: "Total", format: "currency" })(
      ctx,
    ) as unknown as Tooltip;
    expectEscaped(opt.tooltip.formatter({ name: XSS, color: "#000", value: 10 }));
  });

  it("barras apiladas: categoría y nombre de serie", () => {
    const opt = stackedBarOption({
      categories: [XSS],
      series: [{ name: XSS, values: [5] }],
      format: "number",
    })(ctx) as unknown as Tooltip;
    expectEscaped(opt.tooltip.formatter([{ dataIndex: 0, seriesName: XSS, color: "#000", value: 5 }]));
  });

  it("guardia: nadie importa LinesChart (la serie del CVE)", () => {
    for (const f of ["components/charts/echarts-core.ts", "components/account/EChart.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/LinesChart/);
    }
  });
});
