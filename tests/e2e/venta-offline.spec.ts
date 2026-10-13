import { test, expect, requireSession } from "./support/fixtures";
import { AUTH_STATE_PATH, BASE_URL, RUN_PREFIX } from "./support/env";
import { addToCart, createSimpleProduct, deleteProduct, ensureShiftOpen, escapeRe, gotoClean, openCheckout } from "./support/app";

// Venta offline (ADR-077): el POS sigue cobrando sin conexión, guarda la venta
// en la cola local con ticket provisorio y la sincroniza al volver.
//
// SÓLO contra un entorno local con la migración 20261103200000 aplicada: al
// reconectar registra una venta real. Se habilita con E2E_OFFLINE=1 y un
// BASE_URL local; nunca contra producción.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(BASE_URL);
const ENABLED = process.env.E2E_OFFLINE === "1" && LOCAL;

const PRODUCT = `${RUN_PREFIX} offline item`;
const PRICE = 900;

test.describe("venta offline", () => {
  requireSession();
  test.skip(!ENABLED, "Venta offline: E2E_OFFLINE=1 y BASE_URL local (nunca producción)");
  test.describe.configure({ mode: "serial" });

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

  test("sin conexión cobra en efectivo, deja ticket provisorio y sincroniza al volver", async ({ page, context }) => {
    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    await addToCart(page, PRODUCT);
    // Dar tiempo a la foto local del catálogo.
    await page.waitForTimeout(1500);

    await context.setOffline(true);
    const banner = page.getByTestId("pos-offline-banner");
    await expect(banner).toContainText("Sin conexión: vendiendo offline, 0 ventas por sincronizar");

    const sheet = await openCheckout(page);
    // Sólo medios manuales: nada de QR ni link.
    await expect(sheet.getByRole("button", { name: /QR/ })).toHaveCount(0);
    await sheet.getByRole("button", { name: new RegExp(`^${escapeRe("Efectivo")}`) }).first().click();
    await sheet.getByRole("button", { name: "Exacto", exact: true }).click();
    await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();

    const ticket = page.getByTestId("offline-ticket");
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText(/OFF-[0-9A-F]{8}/);
    await expect(banner).toContainText("1 venta por sincronizar");
    await page.getByRole("button", { name: "Listo" }).click();

    // Al volver la conexión se envía sola.
    await context.setOffline(false);
    await expect(page.getByText("Ventas offline sincronizadas")).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveCount(0);
  });
});
