import type { Locator, Page } from "@playwright/test";
import { expect, settle } from "./fixtures";

// Helpers de UI compartidos por los flujos autenticados. Los textos salen de
// los componentes (no hay data-testid en el repo): si cambia un copy, se
// actualiza acá.

/** Cliente de prueba del tenant QA (precreado; ver tests/e2e/README.md). */
export const QA_CUSTOMER = process.env.E2E_CUSTOMER_NAME ?? "E2E Cliente QA";

export function dialog(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog", { name });
}

/** ¿Aparece el locator dentro de `ms`? (sin fallar). */
export async function appears(locator: Locator, ms = 4_000): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Pestañas del form de producto: los paneles inactivos están `hidden`. */
export async function productTab(page: Page, tab: string) {
  await dialog(page, /producto/i).getByRole("button", { name: tab, exact: true }).click();
}

/** Abre el form "Nuevo producto" (resuelve el prompt de PLU del primer producto). */
export async function openNewProduct(page: Page) {
  await page.goto("/productos");
  await settle(page);
  await page.getByRole("button", { name: "Nuevo producto" }).first().click();
  const plu = dialog(page, "¿Usar PLU en tus productos?");
  if (await appears(plu, 2_500)) await plu.getByRole("button", { name: "Ahora no" }).click();
  await expect(dialog(page, "Nuevo producto")).toBeVisible();
}

/** Crea un producto simple (con stock) y cierra el form. */
export async function createSimpleProduct(page: Page, name: string, price: number) {
  await openNewProduct(page);
  const form = dialog(page, "Nuevo producto");
  await form.getByLabel("Nombre", { exact: true }).fill(name);
  await productTab(page, "Precios");
  await form.getByLabel("Precio de venta").fill(String(price));
  await productTab(page, "Stock");
  const initial = form.getByLabel("Stock inicial");
  if (await appears(initial, 1_500)) await initial.fill("100");
  await form.getByRole("button", { name: "Crear producto" }).click();
  await expect(page.getByText("Producto creado").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Busca un producto en /productos y devuelve su fila. */
export async function productRow(page: Page, name: string): Promise<Locator> {
  await page.goto("/productos");
  await settle(page);
  await page.getByPlaceholder("Buscar por nombre, SKU o código…").fill(name);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.first()).toBeVisible();
  return row.first();
}

/** Baja lógica de un producto (ConfirmDialog "Eliminar producto"). */
export async function deleteProduct(page: Page, name: string) {
  const row = await productRow(page, name);
  await row.getByTitle("Eliminar").click();
  const confirm = dialog(page, "Eliminar producto");
  await expect(confirm).toContainText("baja lógica");
  await confirm.getByRole("button", { name: "Eliminar" }).click();
  await expect(page.getByText("Producto eliminado").first()).toBeVisible();
}

/** En /pos: abre la caja si está cerrada. */
export async function ensureShiftOpen(page: Page) {
  if (!page.url().includes("/pos")) {
    await page.goto("/pos");
    await settle(page);
  }
  const closed = page.getByText("Caja cerrada");
  if (await appears(closed, 5_000)) {
    await page.getByTitle("Abrir caja").first().click();
    const d = dialog(page, "Abrir caja");
    await d.getByLabel("Monto inicial").fill("0");
    await d.getByRole("button", { name: "Abrir" }).click();
    await expect(page.getByText("Caja abierta").first()).toBeVisible();
  }
}

/** En /pos: busca el producto y lo agrega al carrito. */
export async function addToCart(page: Page, name: string) {
  const search = page.getByLabel("Buscar producto");
  if (await appears(search, 5_000)) {
    await search.fill(name);
    await page
      .locator('section[aria-label="Productos"]')
      .getByRole("button", { name: new RegExp(escapeRe(name)) })
      .first()
      .click();
  } else {
    // Preset Caja rápida: input de escaneo, Enter agrega el único resultado.
    const scan = page.getByPlaceholder("Escaneá o tipeá PLU, código o nombre");
    await scan.fill(name);
    await scan.press("Enter");
  }
  await expect(page.getByText("El carrito está vacío")).toHaveCount(0);
}

/** Abre el CheckoutSheet desde el carrito. */
export async function openCheckout(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^Cobrar/ }).last().click();
  const sheet = dialog(page, "Cobrar");
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * Cierra el modal de ticket que aparece tras la venta y devuelve el número
 * de venta si el ticket lo muestra ("#123").
 */
export async function closeTicket(page: Page): Promise<string | null> {
  const ticket = dialog(page, "Ticket");
  await expect(ticket).toBeVisible({ timeout: 30_000 });
  const text = (await ticket.innerText().catch(() => "")) ?? "";
  const n = text.match(/#\s?(\d+)/)?.[1] ?? null;
  await ticket.getByRole("button", { name: "Cerrar" }).first().click();
  return n;
}

/**
 * Anula una venta en /ventas. Con número la busca; sin número anula la más
 * reciente completada (el tenant QA es dedicado: nadie más vende ahí).
 */
export async function voidSale(page: Page, saleNumber: string | null, reason: string) {
  await page.goto("/ventas");
  await settle(page);
  if (saleNumber) {
    await page.getByPlaceholder("Buscar por N°, ticket o cliente…").fill(saleNumber);
  }
  const row = page
    .getByRole("row")
    .filter({ hasText: "Completada" })
    .filter({ has: page.getByTitle("Anular") })
    .first();
  await expect(row).toBeVisible();
  await row.getByTitle("Anular").click();
  const confirm = dialog(page, /^Anular venta/);
  await confirm.getByLabel("Motivo de anulación").fill(reason);
  await confirm.getByRole("button", { name: "Anular venta" }).click();
  await expect(page.getByText(/Venta #\d+ anulada/).first()).toBeVisible();
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
