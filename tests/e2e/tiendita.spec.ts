import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, dialog } from "./support/app";

// Flujo 7 · Tiendita: catálogos, abrir uno, editor previo a importar y
// cancelar (no importa nada).

test.describe("tiendita", () => {
  requireSession();

  test("catálogo → editor de pre-importación → cancelar", async ({ page }) => {
    await page.goto("/tiendita");
    // La intro tapa los clicks hasta que se cierra (sola a los 3,8 s).
    const entrarIntro = page.getByRole("button", { name: "Entrar", exact: true }).first();
    if (await appears(entrarIntro, 5_000)) await page.keyboard.press("Escape");
    await settle(page);

    await expect(page.getByText(/Tus catálogos|Catálogos disponibles|Más catálogos/).first()).toBeVisible();
    const open = page.getByRole("button", { name: /^Entrar a / }).first();
    test.skip(!(await appears(open, 5_000)), "El tenant QA no tiene catálogos comprados/regalados");
    const catalogName = ((await open.getAttribute("aria-label")) ?? "").replace(/^Entrar a /, "");
    await open.click();

    await expect(page.getByRole("heading", { level: 1, name: catalogName })).toBeVisible();
    await expect(page.getByPlaceholder("Buscar por nombre o código de barras")).toBeVisible();

    const add = page.getByRole("button", { name: "Agregar", exact: true }).first();
    test.skip(!(await appears(add, 10_000)), "Todos los productos del catálogo ya están importados");
    await add.click();

    const editor = dialog(page, "Revisar antes de importar");
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Nombre", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("Precio de venta")).toBeVisible();
    await expect(editor.getByText("Árbol de jerarquía")).toBeVisible();
    await editor.getByRole("button", { name: "Cancelar" }).click();
    await expect(editor).toHaveCount(0);
    // Nada importado: el botón sigue diciendo "Agregar".
    await expect(add).toBeVisible();
  });
});
