import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, settle } from "./support/fixtures";
import { HAS_SESSION, SCREENSHOT_DIR, SMOKE_SKIP_REASON } from "./support/env";

// Flujo 9 · Visual. Screenshot de cada página principal a 390 (mobile) y 1440
// (desktop) en test-results/screenshots. Falla si hay scroll horizontal a 390
// o errores de consola (el fixture los junta en todos los specs).

const PUBLIC_PAGES = [
  { name: "login", path: "/login" },
  { name: "signup", path: "/signup" },
  { name: "recover", path: "/recover" },
];

const APP_PAGES = [
  { name: "dashboard", path: "/dashboard" },
  { name: "pos", path: "/pos" },
  { name: "caja", path: "/caja" },
  { name: "productos", path: "/productos" },
  { name: "ventas", path: "/ventas" },
  { name: "clientes", path: "/clientes" },
  { name: "cuentas", path: "/clientes/cuentas" },
  { name: "reportes", path: "/reportes" },
  { name: "tiendita", path: "/tiendita" },
  { name: "configuracion", path: "/configuracion" },
];

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function horizontalOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`visual @${vp.width}`, () => {
    test.use({ viewport: vp });

    test.describe("públicas", () => {
      test.use({ storageState: { cookies: [], origins: [] } });
      for (const p of PUBLIC_PAGES) {
        test(`${p.name}`, async ({ page }) => {
          await page.goto(p.path);
          await settle(page);
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `${p.name}-${vp.width}.png`),
            fullPage: true,
          });
          if (vp.width === 390) {
            expect(await horizontalOverflow(page), "scroll horizontal a 390").toBeLessThanOrEqual(1);
          }
        });
      }
    });

    test.describe("panel", () => {
      test.skip(!HAS_SESSION, SMOKE_SKIP_REASON);
      for (const p of APP_PAGES) {
        test(`${p.name}`, async ({ page }) => {
          await page.goto(p.path);
          await expect(page).not.toHaveURL(/\/login/);
          await settle(page);
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `${p.name}-${vp.width}.png`),
            fullPage: true,
          });
          if (vp.width === 390) {
            expect(await horizontalOverflow(page), "scroll horizontal a 390").toBeLessThanOrEqual(1);
          }
        });
      }
    });
  });
}
