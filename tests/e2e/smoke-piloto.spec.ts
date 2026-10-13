import { test, expect, requireSession, settle } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import {
  addToCart,
  closeShift,
  closeTicket,
  createSimpleProduct,
  deleteProduct,
  ensureShiftOpen,
  gotoClean,
  openCheckout,
  voidSale,
} from "./support/app";

// Smoke de piloto (F1.5 · ADR-098): el recorrido mínimo que tiene que andar
// después de cada deploy, de punta a punta y en un solo flujo:
//   sesión → abrir caja → vender en efectivo → ticket → anular → cerrar caja
//   con arqueo → reporte.
// Corre contra producción SÓLO en el tenant QA (el global setup aborta si el
// JWT es de otro negocio). Deja el turno cerrado y el producto de prueba dado
// de baja; la venta queda anulada. Ver docs/13-deployment.md §11.
//
//   pnpm test:smoke                      (con las E2E_* de la sesión QA cargadas)
//   BASE_URL=https://pos.soft.ninja pnpm test:smoke

const PRODUCT = `${RUN_PREFIX} smoke`;
const PRICE = 1000;

test.describe("smoke de piloto (público)", () => {
  test("healthcheck responde sin sesión", async ({ request }) => {
    const res = await request.get("/api/health", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", service: "ninja-soft-pos" });
  });
});

test.describe("smoke de piloto", () => {
  requireSession();

  test("sesión, caja, venta en efectivo, ticket, anulación, cierre y reporte", async ({ page, browser }) => {
    test.setTimeout(240_000);
    let saleNumber: string | null = null;

    await test.step("sesión: entra al panel sin pasar por el login", async () => {
      await page.goto("/dashboard");
      await settle(page);
      expect(new URL(page.url()).pathname).not.toBe("/login");
    });

    await test.step("producto de prueba", async () => {
      await createSimpleProduct(page, PRODUCT, PRICE);
    });

    try {
      await test.step("abrir caja", async () => {
        await gotoClean(page, "/pos");
        await ensureShiftOpen(page);
        await expect(page.getByTitle("Cerrar caja (arqueo)").first()).toBeVisible();
      });

      await test.step("vender en efectivo (exacto)", async () => {
        await addToCart(page, PRODUCT);
        const sheet = await openCheckout(page);
        await sheet.getByRole("button", { name: /^Efectivo/ }).first().click();
        const exact = sheet.getByRole("button", { name: "Exacto", exact: true });
        if (await exact.isVisible().catch(() => false)) await exact.click();
        await sheet.getByRole("button", { name: /^(Cobrar|Confirmar venta) \$/ }).click();
      });

      await test.step("ticket", async () => {
        saleNumber = await closeTicket(page);
        expect(saleNumber, "el ticket muestra el número de venta").not.toBeNull();
      });

      await test.step("anular la venta", async () => {
        await voidSale(page, saleNumber, `${RUN_PREFIX} smoke de piloto`);
      });

      await test.step("cerrar caja con arqueo", async () => {
        await gotoClean(page, "/pos");
        await closeShift(page, `${RUN_PREFIX} smoke de piloto`);
      });

      await test.step("reporte del día", async () => {
        await gotoClean(page, "/reportes");
        await expect(page.getByRole("heading", { level: 1, name: "Reportes" })).toBeVisible();
        for (const kpi of ["Total vendido", "Cantidad de ventas"]) {
          await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
        }
      });
    } finally {
      const p = await browser.newPage({ storageState: AUTH_STATE_PATH });
      await deleteProduct(p, PRODUCT).catch(() => undefined);
      await p.close();
    }
  });
});
