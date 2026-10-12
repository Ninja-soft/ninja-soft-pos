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
    // Sin ventas en el rango el gráfico muestra su estado vacío en vez del canvas.
    const empty = section.getByText("Sin datos en este período");
    const hasData = !(await empty.isVisible().catch(() => false));
    if (hasData) {
      await expect(section.locator('[role="img"] canvas').first()).toBeVisible();
    }

    // Switch: Tabla → tabla con sus columnas; Gráfico → vuelve el canvas.
    const view = page.getByRole("radiogroup", { name: "Vista de Evolución de ventas" });
    await view.getByRole("radio", { name: "Tabla" }).click();
    await expect(section.getByRole("columnheader", { name: "Ticket prom." })).toBeVisible();
    await view.getByRole("radio", { name: "Gráfico" }).click();
    await expect(section.getByRole("columnheader", { name: "Ticket prom." })).toHaveCount(0);
    if (hasData) await expect(section.locator('[role="img"] canvas').first()).toBeVisible();
  });
});
