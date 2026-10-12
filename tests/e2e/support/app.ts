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
  await gotoClean(page, "/productos");
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
  // Tras crear, el form sigue abierto en modo edición ("Cerrar").
  await closeDialogs(page);
}

/** Busca un producto en /productos y devuelve su fila. */
export async function productRow(page: Page, name: string): Promise<Locator> {
  await gotoClean(page, "/productos");
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

/**
 * Cierra cualquier modal abierto (Escape y, si no alcanza, la X "Cerrar").
 * Así un test no hereda un diálogo que quedó abierto por un fallo anterior.
 */
export async function closeDialogs(page: Page) {
  const dialogs = page.getByRole("dialog");
  for (let i = 0; i < 4 && (await dialogs.count()) > 0; i++) {
    await page.keyboard.press("Escape");
    if (await dialogs.last().waitFor({ state: "detached", timeout: 1_500 }).then(() => true, () => false)) {
      continue;
    }
    await dialogs
      .last()
      .getByRole("button", { name: "Cerrar", exact: true })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await dialogs.last().waitFor({ state: "detached", timeout: 2_000 }).catch(() => undefined);
  }
  await expect(dialogs).toHaveCount(0);
}

/** Navega de cero a `path`: espera la carga y cierra modales que hayan quedado. */
export async function gotoClean(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
  await closeDialogs(page);
}

/** En /pos: abre la caja si está cerrada. */
export async function ensureShiftOpen(page: Page) {
  if (!page.url().includes("/pos")) await gotoClean(page, "/pos");
  // Mientras carga el turno la barra muestra "Caja cerrada": se decide por el
  // botón ya resuelto ("Cerrar caja (arqueo)" = turno abierto).
  const openBtn = page.getByTitle("Cerrar caja (arqueo)");
  if (await appears(openBtn, 8_000)) return;
  await page.getByTitle("Abrir caja").first().click();
  const d = dialog(page, "Abrir caja");
  await expect(d).toBeVisible();
  await d.getByLabel("Monto inicial").fill("0");
  await d.getByRole("button", { name: "Abrir", exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(openBtn.first()).toBeVisible();
}

/**
 * En /pos: busca el producto y lo agrega al carrito. Sirve para todos los
 * presets: en la grilla (Mostrador/Boutique) el resultado es una tarjeta de
 * "Productos"; en Caja rápida, una lista bajo el buscador de escaneo.
 */
export async function addToCart(page: Page, name: string) {
  const search = page
    .getByLabel("Buscar producto")
    .or(page.getByPlaceholder("Escaneá o tipeá PLU, código o nombre"))
    .first();
  await expect(search).toBeVisible();
  await search.fill(name);
  await page
    .getByRole("button", { name: new RegExp(escapeRe(name)) })
    .first()
    .click();
  await expect(page.getByText("El carrito está vacío")).toHaveCount(0);
}

/** Abre el popover "Diseño del POS" de la barra superior (en /pos). */
async function openPresetPopover(page: Page) {
  await page.getByRole("button", { name: "Cambiar el diseño del POS" }).click();
  await expect(page.getByText("Diseño de esta pantalla")).toBeVisible();
}

async function closePresetPopover(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByText("Diseño de esta pantalla")).toHaveCount(0);
}

/**
 * Elige un preset del POS para el usuario (users.settings.pos_layout) y espera
 * a que quede guardado (el botón aparece marcado al reabrir el popover).
 */
export async function setPosPreset(page: Page, preset: string) {
  if (!page.url().includes("/pos")) await gotoClean(page, "/pos");
  // El trigger del popover aparece cuando el POS terminó de cargar el turno.
  await expect(page.getByTitle(/^(Cerrar caja \(arqueo\)|Abrir caja)$/).first()).toBeVisible();
  const btn = () =>
    page
      .getByRole("group", { name: "Diseño del POS" })
      .getByRole("button", { name: new RegExp(`^${escapeRe(preset)}`) });
  // Si la elección se pisa (p. ej. llega tarde la carga del usuario), reintenta.
  await expect(async () => {
    await openPresetPopover(page);
    if ((await btn().getAttribute("aria-pressed")) === "true") {
      await closePresetPopover(page);
      return;
    }
    await btn().click();
    await expect(page.getByText("Diseño de esta pantalla")).toHaveCount(0);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await openPresetPopover(page);
    const pressed = await btn().getAttribute("aria-pressed");
    await closePresetPopover(page);
    expect(pressed).toBe("true");
  }).toPass({ timeout: 30_000 });
}

/**
 * Vuelve al diseño del negocio (borra el override del usuario). En el tenant
 * QA el del negocio es Mostrador con cobro en dos columnas.
 */
export async function resetPosPreset(page: Page) {
  await gotoClean(page, "/pos");
  await expect(page.getByTitle(/^(Cerrar caja \(arqueo\)|Abrir caja)$/).first()).toBeVisible();
  await expect(async () => {
    await openPresetPopover(page);
    const reset = page.getByRole("button", { name: "Volver al del negocio" });
    if (await appears(reset, 1_000)) {
      await reset.click();
      await expect(page.getByText("Diseño de esta pantalla")).toHaveCount(0);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await openPresetPopover(page);
    }
    const business = await page.getByText("Usás el diseño del negocio.").isVisible();
    await closePresetPopover(page);
    expect(business).toBe(true);
  }).toPass({ timeout: 30_000 });
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
  await gotoClean(page, "/ventas");
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
