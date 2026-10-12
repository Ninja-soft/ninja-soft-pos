import { test, expect, requireSession } from "./support/fixtures";
import { RUN_PREFIX } from "./support/env";
import {
  appears,
  closeDialogs,
  deleteProduct,
  dialog,
  openNewProduct,
  productRow,
  productTab,
} from "./support/app";

// Flujo 2 · Productos: alta con árbol de categorías, atributos y 2 bultos con
// medidas; volumen calculado; edición; baja lógica.

test.describe("productos", () => {
  requireSession();
  test.describe.configure({ mode: "serial" });

  const name = `${RUN_PREFIX} Producto completo`;
  const rubro = `${RUN_PREFIX} Rubro`;
  const categoria = `${RUN_PREFIX} Cat`;

  test("alta con categorías, atributos y 2 bultos", async ({ page }) => {
    await openNewProduct(page);
    const form = dialog(page, "Nuevo producto");

    // General: nombre + árbol de jerarquía (rubro › categoría, nuevos).
    await form.getByLabel("Nombre", { exact: true }).fill(name);
    // Un nivel recién agregado ya viene en "Crear nueva" (con su input de
    // nombre); no se re-elige en el select: re-normaliza y descarta el nivel vacío.
    await form.getByRole("button", { name: "Agregar rubro" }).click();
    await form.getByLabel("Nombre de rubro").fill(rubro);
    await form.getByRole("button", { name: "Agregar categoría" }).click();
    await form.getByLabel("Nombre de categoría").fill(categoria);
    await expect(form.getByText(`${rubro} › ${categoria}`)).toBeVisible();

    // Precios.
    await productTab(page, "Precios");
    await form.getByLabel("Precio de venta").fill("1500");

    // Atributos: una sugerencia + uno libre.
    await productTab(page, "Atributos");
    // Los chips son "<icono +> Color": el nombre accesible es sólo el texto.
    await form.getByRole("button", { name: "Color", exact: true }).click();
    await expect(form.getByLabel("Atributo", { exact: true })).toHaveCount(1);
    await expect(form.getByLabel("Atributo", { exact: true }).first()).toHaveValue("Color");
    await form.getByLabel("Valor", { exact: true }).last().fill("Rojo");
    await form.getByRole("button", { name: "Otro", exact: true }).click();
    await expect(form.getByLabel("Atributo", { exact: true })).toHaveCount(2);
    await form.getByLabel("Atributo", { exact: true }).last().fill("Procedencia");
    await form.getByLabel("Valor", { exact: true }).last().fill("E2E");

    // Medidas: 2 bultos. Plan-gated (medidas_bultos).
    await productTab(page, "Medidas");
    test.skip(
      await appears(form.getByLabel("Medidas por bulto: función no incluida en tu plan"), 1_000),
      "El plan del tenant QA no incluye medidas_bultos",
    );
    await form.getByRole("button", { name: "Agregar bulto" }).click();
    await fillBulto(form, { alto: "10", ancho: "20", prof: "30", peso: "2", unid: "1", cant: "1" });
    // 10×20×30 = 6.000 cm³ = 0,006 m³
    await expect(form.getByText(/Unidad 6\.000 cm³ · Total 6\.000 cm³ · 0,006 m³/)).toBeVisible();

    await form.getByRole("button", { name: "Agregar otro bulto" }).click();
    await fillBulto(form, { alto: "50", ancho: "40", prof: "30", peso: "5", unid: "2", cant: "3" });
    // 50×40×30 = 60.000 cm³; unidad = /2 = 30.000; total = ×3 = 180.000 = 0,180 m³
    await expect(form.getByText(/Unidad 30\.000 cm³ · Total 180\.000 cm³ · 0,180 m³/)).toBeVisible();
    await expect(form.getByText("Producto #2")).toBeVisible();

    await form.getByRole("button", { name: "Crear producto" }).click();
    await expect(page.getByText("Producto creado").first()).toBeVisible();
    await closeDialogs(page);
  });

  test("aparece en el listado con su categoría", async ({ page }) => {
    const row = await productRow(page, name);
    await expect(row).toContainText(categoria);
  });

  test("edición persiste y conserva los bultos", async ({ page }) => {
    const row = await productRow(page, name);
    await row.getByTitle("Editar").click();
    const form = dialog(page, "Editar producto");
    await productTab(page, "Precios");
    await form.getByLabel("Precio de venta").fill("1750");
    await productTab(page, "Medidas");
    await expect(form.getByText("Producto #2")).toBeVisible();
    await form.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Producto actualizado").first()).toBeVisible();

    const updated = await productRow(page, name);
    await expect(updated).toContainText(/1\.750/);
  });

  test("baja lógica", async ({ page }) => {
    await deleteProduct(page, name);
    await page.getByPlaceholder("Buscar por nombre, SKU o código…").fill(name);
    await expect(page.getByText("Sin resultados")).toBeVisible();
  });
});

async function fillBulto(
  form: import("@playwright/test").Locator,
  m: { alto: string; ancho: string; prof: string; peso: string; unid: string; cant: string },
) {
  // El último bulto agregado es el que está en edición.
  await form.getByLabel("Alto (cm)").last().fill(m.alto);
  await form.getByLabel("Ancho (cm)").last().fill(m.ancho);
  await form.getByLabel("Prof. (cm)").last().fill(m.prof);
  await form.getByLabel("Peso (kg)").last().fill(m.peso);
  await form.getByLabel("Unid. por bulto").last().fill(m.unid);
  await form.getByLabel("Cant. de bultos").last().fill(m.cant);
}
