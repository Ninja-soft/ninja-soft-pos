import { test, expect, requireSession, settle } from "./support/fixtures";
import { AUTH_STATE_PATH, BASE_URL, RUN_PREFIX } from "./support/env";
import { addToCart, createSimpleProduct, deleteProduct, dialog, ensureShiftOpen, gotoClean, openCheckout } from "./support/app";

// H32 (ADR-129): pedidos de salón y expedición de punta a punta: el vendedor
// guarda el carrito como pedido (con reserva de stock), la caja lo levanta y
// lo cobra, y expedición lo marca entregado.
//
// Escribe datos reales (pedido, reserva, venta y entrega) y necesita las
// migraciones 20261123100000 y 20261123100100 aplicadas. Por eso NO corre por
// defecto ni contra producción: sólo con E2E_PEDIDOS=1 y BASE_URL local
// (stack local o una rama de Supabase).
//
//   E2E_PEDIDOS=1 pnpm test:e2e tests/e2e/pedidos-despacho.spec.ts
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(BASE_URL);
const ENABLED = process.env.E2E_PEDIDOS === "1" && LOCAL;

const PRODUCT = `${RUN_PREFIX} Pedido item`;
const PRICE = 1500;

test.describe("Pedidos de salón y expedición (H32)", () => {
  test.skip(!ENABLED, "Pedidos: E2E_PEDIDOS=1 y BASE_URL local (escribe datos; nunca contra producción)");
  requireSession();

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await createSimpleProduct(page, PRODUCT, PRICE);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await deleteProduct(page, PRODUCT).catch(() => undefined);
    await page.close();
  });

  test("el vendedor arma el pedido, la caja lo cobra y expedición lo entrega", async ({ page }) => {
    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    await addToCart(page, PRODUCT);

    // Vendedor: Pedido → retira ahora.
    await page.getByRole("button", { name: /^Pedido$/ }).click();
    const modal = dialog(page, /Guardar como pedido/);
    await expect(modal).toBeVisible();
    const inmediato = modal.getByRole("radio", { name: "Retira ahora" });
    if (await inmediato.isVisible().catch(() => false)) await inmediato.click();
    await modal.getByRole("button", { name: /Guardar pedido/ }).click();
    const saved = dialog(page, /Pedido N° \d+ guardado/);
    await expect(saved).toBeVisible();
    const title = (await saved.getByRole("heading").first().textContent()) ?? "";
    const number = title.match(/N° (\d+)/)?.[1];
    expect(number).toBeTruthy();
    await saved.getByRole("button", { name: "Listo" }).click();

    // Caja: lo levanta desde la barra de pedidos y cobra en efectivo.
    await page.getByRole("button", { name: new RegExp(`Cobrar el pedido ${number}`) }).click();
    await expect(page.getByText(`Cobrando el pedido N° ${number}`)).toBeVisible();
    const sheet = await openCheckout(page);
    await sheet.getByRole("button", { name: /Efectivo/ }).first().click();
    await sheet.getByRole("button", { name: /Confirmar|Cobrar/ }).last().click();
    await settle(page);

    // Expedición: armar, listo y entregar.
    await gotoClean(page, "/expedicion");
    const card = page.locator("li", { hasText: PRODUCT }).first();
    await card.getByRole("button", { name: "Empezar a armar" }).click();
    await card.getByRole("button", { name: "Marcar listo" }).click();
    await page.getByRole("radio", { name: /Listos/ }).click();
    await page.locator("li", { hasText: PRODUCT }).first().getByRole("button", { name: "Entregar" }).click();
    const deliver = dialog(page, /Entregar N°/);
    await deliver.getByRole("button", { name: "Entregar" }).click();
    await expect(page.getByText(/entregada/)).toBeVisible();
  });
});
