import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, closeDialogs, gotoClean } from "./support/app";

// Ventas: detalle con la pestaña Cobros y el filtro "Con alertas"
// (contracargos y devoluciones de Mercado Pago, ADR-064). Sólo lectura.

test.describe("ventas", () => {
  requireSession();

  test("detalle de venta: pestaña Cobros", async ({ page }) => {
    await gotoClean(page, "/ventas");
    const ticketBtn = page.getByRole("row").getByRole("button", { name: "Ticket" }).first();
    test.skip(!(await appears(ticketBtn, 8_000)), "El tenant QA no tiene ventas (corré pos.spec.ts antes)");
    await ticketBtn.click();

    const detail = page.getByRole("dialog").first();
    await expect(detail).toBeVisible();
    const tabs = detail.getByRole("radiogroup", { name: "Vista del detalle" });
    await expect(tabs.getByRole("radio", { name: "Ticket" })).toHaveAttribute("aria-checked", "true");
    await tabs.getByRole("radio", { name: "Cobros" }).click();

    const cobros = page.getByRole("dialog", { name: "Cobros de la venta" });
    await expect(cobros).toBeVisible();
    await expect(cobros.getByText(/^\d+ cobros?/).first()).toBeVisible();
    await expect(cobros.getByText(/\$\s?[\d.]+,\d{2}/).first()).toBeVisible();
    // Volver a Ticket.
    await cobros.getByRole("radiogroup", { name: "Vista del detalle" }).getByRole("radio", { name: "Ticket" }).click();
    await expect(page.getByRole("dialog", { name: "Ticket" })).toBeVisible();
    await closeDialogs(page);
  });

  test("filtro Con alertas", async ({ page }) => {
    await gotoClean(page, "/ventas");
    const status = page.locator("select").filter({ has: page.locator('option[value="completed"]') }).first();
    await expect(status).toBeVisible();
    const hasAlerts = (await status.locator('option[value="alerts"]').count()) > 0;
    test.skip(!hasAlerts, "Filtro Con alertas (ADR-064) todavía no está desplegado");

    await status.selectOption("alerts");
    await expect(status).toHaveValue("alerts");

    // El link de los avisos (/ventas?alertas=1) deja el filtro aplicado.
    await gotoClean(page, "/ventas?alertas=1");
    await expect(status).toHaveValue("alerts");
    await settle(page);
    await expect(page.getByText("Error al cargar")).toHaveCount(0);
    // Con alertas: sólo ventas marcadas; sin alertas en QA: estado vacío del
    // filtro (no el de "todavía no vendiste") con "Limpiar filtros".
    const body = page.locator("tbody");
    const filteredEmpty = body.getByText("No hay ventas con alertas en este período");
    const legacyEmpty = body.getByText("Todavía no hay ventas");
    const alertRow = body.locator("tr").filter({ hasText: /contracargo|reclamo|devoluci|devuelto|reintegr/i });
    await expect(filteredEmpty.or(legacyEmpty).or(alertRow).first()).toBeVisible();
    test.skip(
      await legacyEmpty.isVisible(),
      "Estado vacío filtrado de Ventas todavía no desplegado (muestra 'Todavía no hay ventas')",
    );
    if (await filteredEmpty.isVisible()) {
      await body.getByRole("button", { name: "Limpiar filtros" }).click();
      await expect(status).toHaveValue("");
    } else {
      await status.selectOption("");
      await expect(status).toHaveValue("");
    }
  });
});
