import { test, expect, requireSession } from "./support/fixtures";
import { QA_CUSTOMER, escapeRe, gotoClean } from "./support/app";

// Ficha del cliente 360 (H31b, ADR-067) del cliente de prueba del tenant QA.
// Sólo lectura: no se guardan notas ni se edita el cliente.

test.describe("clientes", () => {
  requireSession();

  test("ficha 360 del cliente de prueba", async ({ page }) => {
    await gotoClean(page, "/clientes");
    const link = page.getByRole("link", { name: new RegExp(`^${escapeRe(QA_CUSTOMER)}$`) }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/clientes\/[0-9a-f-]{36}$/);

    await expect(page.getByRole("heading", { level: 1, name: QA_CUSTOMER })).toBeVisible();
    await expect(page.getByText("Ficha del cliente").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportar XLSX" })).toBeVisible();
    for (const kpi of [
      "Total comprado",
      "Compras",
      "Ticket promedio",
      "Última compra",
      "Devoluciones",
      "Deuda en cuenta corriente",
      "Saldo a favor",
      "Cobros en espera",
    ]) {
      await expect(page.getByRole("main").getByText(kpi, { exact: true }).first()).toBeVisible();
    }
    for (const h of [
      "Datos del cliente",
      "Compras por mes",
      "Medios de pago que usa",
      "Productos que más compra",
      "Notas internas",
      "Línea de tiempo",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    }
    // Notas: sin texto no se guarda (no se escribe ninguna).
    await expect(page.getByRole("button", { name: "Guardar nota" })).toBeDisabled();

    // Línea de tiempo: filtro por tipo (botones) sin errores.
    const timeline = page
      .getByRole("heading", { level: 2, name: "Línea de tiempo" })
      .locator("xpath=ancestor::section[1]");
    const ventas = page.getByRole("button", { name: "Ventas", exact: true }).last();
    await ventas.click();
    await expect(
      page.getByText(/Venta #\d+|Sin movimientos|Todavía no hay movimientos|No hay movimientos/).first(),
    ).toBeVisible();
    await ventas.click();
    await expect(timeline.or(page.getByRole("main")).first()).toBeVisible();

    // Acceso directo desde la lista ("Ficha completa").
    await gotoClean(page, "/clientes");
    const row = page.getByRole("row").filter({ hasText: QA_CUSTOMER }).first();
    await row.getByTitle("Ficha completa").click();
    await expect(page.getByRole("heading", { level: 1, name: QA_CUSTOMER })).toBeVisible();
  });
});
