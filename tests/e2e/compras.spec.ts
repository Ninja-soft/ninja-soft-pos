import { test, expect, requireSession } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import { appears, closeDialogs, createSimpleProduct, deleteProduct, dialog, gotoClean } from "./support/app";

// Compras: proveedores (listado, alta y archivo) y una orden de compra en
// borrador que se cancela. Todo lleva el prefijo de la corrida y queda dado
// de baja: el proveedor archivado (baja lógica), la orden cancelada y el
// producto de prueba con baja lógica.

const SUPPLIER = `${RUN_PREFIX} Proveedor`;
const PRODUCT = `${RUN_PREFIX} Compra item`;

test.describe("compras", () => {
  requireSession();
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await deleteProduct(page, PRODUCT).catch(() => undefined);
    await page.close();
  });

  test("proveedores: listado y alta de un proveedor de prueba", async ({ page }) => {
    await gotoClean(page, "/compras/proveedores");
    await expect(page.getByRole("heading", { level: 1, name: "Proveedores" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Compras" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Ver archivados" })).toBeVisible();

    await page.getByRole("button", { name: "Nuevo proveedor" }).first().click();
    const form = dialog(page, "Nuevo proveedor");
    await expect(form).toBeVisible();
    // Sin razón social no se crea.
    await form.getByRole("button", { name: "Crear proveedor" }).click();
    await expect(form).toBeVisible();
    await form.getByLabel("Razón social").fill(SUPPLIER);
    await form.getByLabel("Condición frente al IVA").selectOption({ label: "Monotributista" });
    await form.getByLabel("Persona de contacto").fill("E2E contacto");
    await form.getByRole("button", { name: "Crear proveedor" }).click();
    await expect(page.getByText("Proveedor creado").first()).toBeVisible();
    await closeDialogs(page);

    await page.getByRole("textbox", { name: "Buscar proveedor" }).fill(SUPPLIER);
    await expect(page.getByRole("row").filter({ hasText: SUPPLIER }).first()).toBeVisible();
  });

  test("orden de compra: borrador y cancelación", async ({ page }) => {
    await createSimpleProduct(page, PRODUCT, 900);
    await gotoClean(page, "/compras/ordenes");
    await expect(page.getByRole("heading", { level: 1, name: "Órdenes de compra" })).toBeVisible();
    await page.getByRole("button", { name: "Nueva orden" }).first().click();

    const wizard = dialog(page, "Nueva orden de compra");
    await expect(wizard).toBeVisible();
    await wizard.getByRole("combobox", { name: /^Proveedor/ }).selectOption({ label: SUPPLIER });
    await wizard.getByRole("button", { name: "Siguiente" }).click();

    await wizard.getByLabel("Buscar producto").fill(PRODUCT);
    await wizard.getByRole("button", { name: new RegExp(PRODUCT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    await expect(wizard.getByLabel("Cantidad").first()).toBeVisible();
    await wizard.getByLabel("Cantidad").first().fill("2");
    await wizard.getByLabel("Costo unitario").first().fill("500");
    await wizard.getByRole("button", { name: "Revisar" }).click();
    await expect(wizard.getByText("Total estimado")).toBeVisible();
    await wizard.getByRole("button", { name: "Guardar borrador" }).click();
    await expect(page.getByText("Borrador guardado").first()).toBeVisible();

    // Al guardar se abre el detalle de la orden.
    const detail = page.getByRole("dialog").filter({ hasText: SUPPLIER }).last();
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Borrador").first()).toBeVisible();
    await detail.getByRole("button", { name: "Cancelar", exact: true }).click();
    const confirm = dialog(page, "¿Cancelar la orden?");
    await expect(confirm).toBeVisible();
    await confirm.getByLabel("Motivo").fill(`${RUN_PREFIX} limpieza e2e`);
    await confirm.getByRole("button", { name: "Cancelar orden" }).click();
    await expect(page.getByText("Orden cancelada").first()).toBeVisible();
    await closeDialogs(page);
  });

  test("proveedores: archivar el proveedor de prueba", async ({ page }) => {
    await gotoClean(page, "/compras/proveedores");
    await page.getByRole("textbox", { name: "Buscar proveedor" }).fill(SUPPLIER);
    const row = page.getByRole("row").filter({ hasText: SUPPLIER }).first();
    test.skip(!(await appears(row, 8_000)), "No se creó el proveedor de prueba");
    await row.click();
    const detail = page.getByRole("dialog").filter({ hasText: SUPPLIER }).first();
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Archivar" }).click();
    const confirm = dialog(page, "¿Archivar el proveedor?");
    await confirm.getByRole("button", { name: "Archivar" }).click();
    await expect(page.getByText("Proveedor archivado").first()).toBeVisible();
    await closeDialogs(page);

    // Archivado: sólo aparece con "Ver archivados".
    await page.getByRole("textbox", { name: "Buscar proveedor" }).fill(SUPPLIER);
    await expect(page.getByRole("row").filter({ hasText: SUPPLIER })).toHaveCount(0);
    await page.getByRole("switch", { name: "Ver archivados" }).click();
    await expect(page.getByRole("row").filter({ hasText: SUPPLIER }).first()).toBeVisible();
  });
});
