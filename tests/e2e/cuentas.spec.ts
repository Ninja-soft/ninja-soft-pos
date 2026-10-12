import { test, expect, requireSession, settle } from "./support/fixtures";
import { RUN_PREFIX } from "./support/env";
import { QA_CUSTOMER, appears, dialog } from "./support/app";

// Flujo 4 · Cuenta corriente: tablero de cobranza, estado de cuenta del
// cliente de prueba, cobro en efectivo y configuración de plazos.

test.describe("cuenta corriente", () => {
  requireSession();
  test.describe.configure({ mode: "serial" });

  test("tablero con KPIs y gráfico de antigüedad", async ({ page }) => {
    await page.goto("/clientes/cuentas");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Cuentas corrientes" })).toBeVisible();
    for (const kpi of ["Total a cobrar", "Vencido", "Vence en 7 días", "Punitorios del mes"]) {
      await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: "Antigüedad de la deuda (por vencimiento)" }),
    ).toBeVisible();
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("estado de cuenta y cobro en efectivo", async ({ page }) => {
    await page.goto("/clientes/cuentas");
    await settle(page);
    await page.getByPlaceholder("Buscar cliente").fill(QA_CUSTOMER);
    const link = page.getByRole("link", { name: QA_CUSTOMER });
    if (!(await appears(link, 5_000))) {
      test.skip(true, `El cliente "${QA_CUSTOMER}" no tiene cuenta con movimientos en el tenant QA`);
    }
    await link.first().click();
    await expect(page.getByRole("heading", { level: 1, name: QA_CUSTOMER })).toBeVisible();
    for (const stat of ["Saldo", "Disponible", "Vencido"]) {
      await expect(page.getByText(stat, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Estado de cuenta" })).toBeVisible();

    // Cobro chico en efectivo (sólo si hay saldo a cobrar).
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const collect = dialog(page, /^Cobrar ·/);
    await expect(collect).toBeVisible();
    await collect.getByLabel("Monto a cobrar").fill("1");
    await collect.getByRole("button", { name: "Efectivo", exact: true }).click();
    const nota = collect.getByLabel("Nota (opcional)");
    if (await appears(nota, 1_000)) await nota.fill(`${RUN_PREFIX} cobro`);
    const submit = collect.getByRole("button", { name: "Registrar cobro" });
    if (await submit.isDisabled()) {
      await collect.getByRole("button", { name: "Cancelar" }).click();
      test.skip(true, "El cliente de prueba no tiene saldo para cobrar");
    }
    await submit.click();
    await expect(page.getByText(/Cobro registrado · recibo #\d+/).first()).toBeVisible();
    await expect(collect.getByText(/Recibo #\d+ · \$/)).toBeVisible();
    await collect.getByRole("button", { name: "Listo" }).click();

    // El cobro aparece en el estado de cuenta (filtro "Cobros").
    await page.getByRole("button", { name: "Estado de cuenta" }).click();
    await page.getByRole("button", { name: "Cobros", exact: true }).click();
    await expect(page.getByText(/Recibo #?\d+|Cobro/).first()).toBeVisible();
  });

  test("configuración del negocio guarda plazos", async ({ page }) => {
    await page.goto("/configuracion?seccion=cuenta-corriente");
    await settle(page);
    if (await appears(page.getByText("Sólo el dueño puede cambiar esta configuración."), 3_000)) {
      test.skip(true, "El usuario QA no es dueño del tenant");
    }
    const dias = page.getByLabel("Días", { exact: true }).first();
    await expect(dias).toBeVisible();
    // Reescribe el mismo valor: guarda sin alterar la configuración del tenant QA.
    const current = await dias.inputValue();
    await dias.fill(current || "30");
    await page.getByRole("button", { name: "Guardar", exact: true }).first().click();
    await expect(page.getByText("Configuración guardada").first()).toBeVisible();
  });
});
