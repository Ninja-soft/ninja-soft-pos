import { test, expect, requireSession, settle } from "./support/fixtures";

// Flujo 6 · Reportes: KPIs, gráficos ECharts (canvas) y switch Gráfico/Tabla.

test.describe("reportes", () => {
  requireSession();

  test("KPIs, gráficos y switch Gráfico/Tabla", async ({ page }) => {
    // La vista elegida persiste en localStorage (rep-view-<id>): arrancar limpio.
    await page.addInitScript(() => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith("rep-view-"))
          .forEach((k) => localStorage.removeItem(k));
      } catch {
        // sin storage
      }
    });
    await page.goto("/reportes");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Reportes" })).toBeVisible();
    await page.getByRole("button", { name: "30 días" }).click();

    for (const kpi of ["Total vendido", "Cantidad de ventas", "Ticket promedio", "Mejor día"]) {
      await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
    }

    const section = page.locator("section").filter({
      has: page.getByRole("heading", { level: 2, name: "Evolución de ventas" }),
    });
    await expect(section).toBeVisible();
    // Sin ventas en el rango (tenant QA nuevo, ventas del suite anuladas) el
    // gráfico muestra su estado vacío en vez del canvas. Se espera a que el
    // gráfico termine de cargar antes de decidir.
    const empty = section.getByText("Sin datos en este período");
    const canvas = section.locator('[role="img"] canvas');
    await expect(empty.or(canvas).first()).toBeVisible();
    const hasData = !(await empty.isVisible());

    // Switch: Tabla → tabla con sus columnas (una fila por día, con o sin
    // ventas); Gráfico → vuelve el canvas o el estado vacío.
    // (getByRole("columnheader") no encuentra estos <th> en la app real: se busca por tag.)
    const header = section.locator("thead th", { hasText: "Ticket prom." });
    const view = page.getByRole("radiogroup", { name: "Vista de Evolución de ventas" });
    await view.getByRole("radio", { name: "Tabla" }).click();
    await expect(header).toBeVisible();
    await expect(section.locator("tbody tr").first()).toBeVisible();
    await view.getByRole("radio", { name: "Gráfico" }).click();
    await expect(header).toHaveCount(0);
    await expect(hasData ? canvas.first() : empty).toBeVisible();
  });
});
