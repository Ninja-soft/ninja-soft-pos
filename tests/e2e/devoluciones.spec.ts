import type { Page } from "@playwright/test";
import { test, expect, requireSession } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import {
  addToCart,
  closeDialogs,
  closeTicket,
  createSimpleProduct,
  deleteProduct,
  dialog,
  ensureShiftOpen,
  gotoClean,
  openCheckout,
  voidSale,
} from "./support/app";
import { fakeUuid, fulfillJson, guardEdgeFunctions } from "./support/mocks";

// Wizard de devolución: "Reintegrar por Mercado Pago" (H21h, ADR-067) aparece
// sólo si la venta tiene un cobro de MP reintegrable y el negocio lo habilitó.
// NUNCA se confirma una devolución ni se pide un reintegro: el wizard se
// recorre hasta el paso Reintegro y se cierra. La venta de prueba (efectivo)
// se anula al final. Los casos con MP simulan mp_refund_options.

const PRODUCT = `${RUN_PREFIX} Devol item`;
const PRICE = 1250;
const VOID_REASON = `${RUN_PREFIX} limpieza e2e`;
let saleNumber: string | null = null;

async function openRefundStep(page: Page) {
  await gotoClean(page, "/ventas");
  if (saleNumber) await page.getByPlaceholder("Buscar por N°, ticket o cliente…").fill(saleNumber);
  const row = page
    .getByRole("row")
    .filter({ hasText: "Completada" })
    .filter({ has: page.getByTitle("Devolución / cambio") })
    .first();
  await expect(row).toBeVisible();
  await row.getByTitle("Devolución / cambio").click();
  const wizard = dialog(page, "Devolución / cambio");
  await expect(wizard).toBeVisible();
  await wizard.getByRole("button", { name: "Todo", exact: true }).click();
  await wizard.getByRole("button", { name: "Siguiente" }).click(); // Motivo
  await wizard.getByRole("button", { name: "Siguiente" }).click(); // Reintegro
  await expect(wizard.getByText(/Efectivo|Vale/).first()).toBeVisible();
  return wizard;
}

function mpOptions(page: Page, opts: { enabled: boolean }) {
  return page.route(/\/rest\/v1\/rpc\/mp_refund_options/, (route) =>
    fulfillJson(route, {
      feature: true,
      enabled: opts.enabled,
      is_supervisor: true,
      window_days: 180,
      payments: [
        {
          payment_id: fakeUuid(),
          intent_id: fakeUuid(),
          provider_key: "mercadopago",
          paid: PRICE,
          refunded: 0,
          refundable: PRICE,
          expired: false,
          paid_at: new Date().toISOString(),
        },
      ],
    }),
  );
}

test.describe("devoluciones: reintegro por Mercado Pago", () => {
  requireSession();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await createSimpleProduct(page, PRODUCT, PRICE);
    // Venta de prueba en efectivo (se anula en afterAll).
    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    await addToCart(page, PRODUCT);
    const sheet = await openCheckout(page);
    await sheet.getByRole("button", { name: /^Efectivo/ }).first().click();
    await sheet.getByRole("button", { name: /^(Confirmar venta|Cobrar) \$/ }).first().click();
    saleNumber = await closeTicket(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await voidSale(page, saleNumber, VOID_REASON).catch(() => undefined);
    await deleteProduct(page, PRODUCT).catch(() => undefined);
    await page.close();
  });

  test.beforeEach(async ({ page, allowConsole }) => {
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
    // Ninguna devolución se confirma desde este spec.
    await page.route(/\/rest\/v1\/rpc\/(return_sale|mp_refund_fallback)/, (route) => route.abort());
  });

  test("venta en efectivo: no ofrece Mercado Pago", async ({ page }) => {
    const wizard = await openRefundStep(page);
    await expect(wizard.getByText("Reintegrar por Mercado Pago")).toHaveCount(0);
    await closeDialogs(page);
  });

  test("cobro de MP reintegrable: ofrece Mercado Pago (simulado)", async ({ page }) => {
    await mpOptions(page, { enabled: true });
    const wizard = await openRefundStep(page);
    await expect(wizard.getByText("Reintegrar por Mercado Pago")).toBeVisible();
    await expect(wizard.getByText(/Vuelve a la tarjeta o cuenta con la que pagó el cliente\. Hasta \$\s?1\.250/)).toBeVisible();
    await closeDialogs(page);
  });

  test("MP sin habilitar por el dueño: explica por qué no está (simulado)", async ({ page }) => {
    await mpOptions(page, { enabled: false });
    const wizard = await openRefundStep(page);
    await expect(wizard.getByText("Reintegrar por Mercado Pago")).toHaveCount(0);
    await expect(wizard.getByText(/El dueño todavía no habilitó el reintegro por Mercado Pago/)).toBeVisible();
    await closeDialogs(page);
  });
});
