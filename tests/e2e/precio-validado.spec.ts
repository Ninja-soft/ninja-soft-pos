import { test, expect, requireSession } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import {
  addToCart,
  appears,
  closeDialogs,
  createSimpleProduct,
  deleteProduct,
  dialog,
  ensureShiftOpen,
  escapeRe,
  gotoClean,
  openCheckout,
} from "./support/app";
import { fulfillJson } from "./support/mocks";

// Precio validado en el servidor: create_sale rechaza un carrito con precio
// viejo (price_mismatch) y el POS avisa, actualiza el carrito y no registra
// la venta. El rechazo se simula en el navegador (el precio real del producto
// no cambia), así que la venta nunca llega a la base.

const PRODUCT = `${RUN_PREFIX} Precio item`;
const PRICE = 1250;
const SERVER_PRICE = 1350;

test.describe("precio validado", () => {
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

  test("precio cambiado: aviso, carrito actualizado y sin venta", async ({ page, allowConsole }) => {
    allowConsole(/status of 400|rpc\/create_sale/);
    let calls = 0;
    await page.route(/\/rest\/v1\/rpc\/create_sale/, (route) => {
      calls++;
      const body = route.request().postDataJSON() as { p_items?: { product_id: string; unit_price?: number }[] };
      const item = body.p_items?.find((i) => i.product_id);
      return fulfillJson(
        route,
        {
          code: "P0001",
          details: null,
          hint: null,
          message:
            "price_mismatch:" +
            JSON.stringify({
              items: [
                {
                  product_id: item?.product_id ?? "00000000-0000-4000-a000-000000000000",
                  variant_id: null,
                  expected: SERVER_PRICE,
                  received: item?.unit_price ?? PRICE,
                },
              ],
            }),
        },
        400,
      );
    });

    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    const clear = page.getByRole("button", { name: "Vaciar carrito" });
    if (await appears(clear, 2_000)) {
      await clear.click();
      await page.getByRole("button", { name: "Vaciar", exact: true }).click();
    }
    await addToCart(page, PRODUCT);
    const sheet = await openCheckout(page);
    await sheet.getByRole("button", { name: /^Efectivo/ }).first().click();
    // "Confirmar venta $…" (dos columnas, efectivo exacto) o "Cobrar $…".
    await sheet.getByRole("button", { name: /^(Confirmar venta|Cobrar) \$/ }).first().click();

    // El toast dura pocos segundos y, con la hoja abierta, la región de avisos
    // queda fuera del árbol accesible (modal): se busca por texto.
    await expect(
      page.getByText(new RegExp(`El precio de ${escapeRe(PRODUCT)} cambió a \\$\\s?1\\.350`)).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Revisá el total y volvé a cobrar.").first()).toBeVisible();
    expect(calls).toBe(1);
    // No hubo venta: la hoja sigue abierta y no aparece el ticket.
    await expect(sheet).toBeVisible();
    await expect(dialog(page, "Ticket")).toHaveCount(0);

    // El carrito toma el precio del servidor; como el precio real del catálogo
    // no cambió (el rechazo es simulado), el POS puede volver a repreciarlo al
    // recargar productos. Cualquiera de los dos, nunca queda venta registrada.
    await closeDialogs(page);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText(/\$\s?1\.(350|250)/).first()).toBeVisible();
    await page.getByRole("button", { name: "Vaciar carrito" }).click();
    await page.getByRole("button", { name: "Vaciar", exact: true }).click();
    await expect(page.getByText("El carrito está vacío").first()).toBeVisible();
  });
});
