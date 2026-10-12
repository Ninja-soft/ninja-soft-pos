import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, dialog } from "./support/app";

// Flujo 5 · Medios de pago: listado agrupado por marca con canales, y el
// wizard de conexión (pasos + validación). NUNCA guarda credenciales.

test.describe("medios de pago", () => {
  requireSession();

  test.beforeEach(async ({ page }) => {
    // El wizard nunca llega al botón final "Conectar <marca>": no se guarda nada.
    await page.goto("/configuracion?seccion=pagos");
    await settle(page);
  });

  test("listado agrupado por marca con canales", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Medios de pago" })).toBeVisible();
    await expect(page.getByText("Cobros directos").first()).toBeVisible();
    // Efectivo y transferencia vienen prendidos aunque el negocio no tenga filas.
    for (const m of ["Efectivo", "Transferencia"]) {
      await expect(
        page.getByRole("switch", { name: new RegExp(`^Habilitar ${m}`) }),
      ).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByText(/^\d+ canal(es)? activos?$/).first()).not.toHaveText(/^0 /);
    // Cuentas agrupadas por marca: conectadas, para conectar o de otro plan.
    await expect(page.getByText(/^(Tus cuentas|Para conectar|En otros planes)/).first()).toBeVisible();
    for (const brand of ["Mercado Pago", "Payway", "Getnet"]) {
      await expect(page.getByRole("heading", { level: 3, name: brand })).toBeVisible();
    }
    // Chips de estado por marca y canales con su switch.
    await expect(
      page.getByText(/^(Sin conectar|Conectado|Prueba|Registro manual|Próximamente|Plan .+)$/).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/^(Cobro desde el celular|Terminal en el mostrador|Cobro en su portal)$/).first(),
    ).toBeVisible();
  });

  test("wizard de conexión: pasos y validación sin guardar", async ({ page }) => {
    // Payway o Getnet: credenciales por formulario (MP es OAuth).
    let brand = "";
    for (const b of ["Payway", "Getnet"]) {
      // Tarjeta de la marca = ancestro más cercano del h3 que tiene "Conectar".
      const btn = page
        .getByRole("heading", { level: 3, name: b })
        .locator("xpath=ancestor::*[.//button[normalize-space()='Conectar']][1]")
        .getByRole("button", { name: "Conectar", exact: true })
        .first();
      if (await appears(btn, 2_000)) {
        brand = b;
        await btn.click();
        break;
      }
    }
    test.skip(!brand, "Ninguna marca con credenciales disponible para conectar (ya conectadas o fuera de plan)");

    const modal = dialog(page, `Conectar ${brand}`);
    await expect(modal).toBeVisible();
    // aria-current va en el círculo numerado; la etiqueta está en su <li>.
    const currentStep = modal
      .locator('ol[aria-label="Pasos"] > li')
      .filter({ has: page.locator('[aria-current="step"]') });
    await expect(currentStep).toContainText("Datos");

    // Siguiente sin datos → errores "Falta …".
    await modal.getByRole("button", { name: "Siguiente" }).click();
    await expect(modal.getByText(/^Falta /).first()).toBeVisible();

    // Valor corto → "parece incompleto".
    const firstInput = modal.getByRole("textbox").first();
    await firstInput.fill("abc");
    await firstInput.blur();
    await expect(modal.getByText(/parece incompleto/i).first()).toBeVisible();

    // Valores dummy largos (no son credenciales reales) → paso Ambiente.
    const inputs = modal.locator("input:visible");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const input = inputs.nth(i);
      const type = await input.getAttribute("type");
      if (type === "checkbox" || type === "radio") continue;
      await input.fill(type === "number" ? "12345678" : "e2e-dummy-0000000000000000000000000000");
    }
    await modal.getByRole("button", { name: "Siguiente" }).click();
    await expect(currentStep).toContainText("Ambiente");
    await expect(modal.getByRole("radiogroup", { name: "Ambiente" })).toBeVisible();

    // Atrás vuelve a Datos; se cierra sin guardar.
    await modal.getByRole("button", { name: "Atrás" }).click();
    await expect(currentStep).toContainText("Datos");
    await modal.getByRole("button", { name: /^(Cancelar|Volver)$/ }).click();
    await expect(modal).toHaveCount(0);
  });
});
