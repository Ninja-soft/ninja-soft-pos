import type { Locator, Page } from "@playwright/test";
import { test, expect, requireSession } from "./support/fixtures";
import { AUTH_STATE_PATH, RUN_PREFIX } from "./support/env";
import {
  QA_CUSTOMER,
  addToCart,
  appears,
  closeTicket,
  createSimpleProduct,
  deleteProduct,
  dialog,
  ensureShiftOpen,
  escapeRe,
  gotoClean,
  openCheckout,
  resetPosPreset,
  setPosPreset,
  voidSale,
} from "./support/app";

// Flujo 3 · POS: caja, presets de diseño, cobros (efectivo con vuelto, mixto,
// Directo, cuenta corriente), ticket y anulación. Cada venta se anula al final
// del test que la crea; el producto de prueba se da de baja lógica al cerrar.

const PRODUCT = `${RUN_PREFIX} POS item`;
const PRICE = 1250; // redondeos rápidos: $1.300 / $1.500 / $2.000 → vuelto visible
const VOID_REASON = `${RUN_PREFIX} limpieza e2e`;

async function cartWithProduct(page: Page) {
  await gotoClean(page, "/pos");
  await ensureShiftOpen(page);
  await addToCart(page, PRODUCT);
}

async function tender(sheet: Locator, name: string) {
  await sheet.getByRole("button", { name: new RegExp(`^${escapeRe(name)}`) }).first().click();
}

async function finishAndVoid(page: Page) {
  const n = await closeTicket(page);
  await voidSale(page, n, VOID_REASON);
}

test.describe("pos", () => {
  requireSession();
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

  test("abre la caja si está cerrada", async ({ page }) => {
    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    await expect(page.getByText("Caja cerrada")).toHaveCount(0);
  });

  test("cada preset de diseño renderiza", async ({ page }) => {
    try {
      await renderEachPreset(page);
    } finally {
      // Restaurar el diseño del negocio (Mostrador / dos columnas) aunque falle:
      // el preset se guarda por usuario y lo heredarían los tests siguientes.
      await resetPosPreset(page);
    }
  });

  async function renderEachPreset(page: Page) {
    await gotoClean(page, "/pos");
    const presets = ["Mostrador", "Boutique", "Caja rápida", "Salón"];
    for (const preset of presets) {
      await page.getByRole("button", { name: "Cambiar el diseño del POS" }).click();
      const pop = page.getByText("Diseño de esta pantalla");
      await expect(pop).toBeVisible();
      const btn = page.getByRole("button", { name: new RegExp(`^${preset}`) }).first();
      if (preset === "Salón" && (await btn.isDisabled())) {
        // Sin modo gastronómico el preset está deshabilitado: no aplica.
        await expect(page.getByText("Activá el modo gastronómico")).toBeVisible();
        await page.keyboard.press("Escape");
        continue;
      }
      await btn.click();
      await page.keyboard.press("Escape");
      // Cada preset tiene un buscador (normal o el de escaneo de Caja rápida).
      const search = page
        .getByLabel("Buscar producto")
        .or(page.getByPlaceholder("Escaneá o tipeá PLU, código o nombre"));
      await expect(search.first()).toBeVisible();
      await expect(page.getByText("Total").first()).toBeVisible();
    }
  }

  // Bug de producción: al entrar a Vender se pintaba el diseño por defecto y
  // después saltaba al elegido. El primer contenedor del POS que aparece tiene
  // que ser el del preset final, tanto en frío (sin foto en el dispositivo:
  // esqueleto neutro → preset) como en caliente (foto guardada → preset).
  test("el POS no salta de diseño al cargar", async ({ page }) => {
    try {
      await gotoClean(page, "/pos");
      await setPosPreset(page, "Boutique");
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { __posPresets: string[] }).__posPresets = seen;
        const record = () => {
          const el = document.querySelector("[data-preset]");
          const v = el?.getAttribute("data-preset");
          if (v && seen[seen.length - 1] !== v) seen.push(v);
        };
        new MutationObserver(record).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-preset"],
        });
      });
      const presetsSeen = async () => {
        await expect(page.locator("[data-preset]")).toHaveAttribute("data-preset", "boutique");
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        return page.evaluate(() => (window as unknown as { __posPresets: string[] }).__posPresets);
      };
      for (const cold of [true, false]) {
        if (cold) await page.evaluate(() => localStorage.removeItem("ninja-pos-boot.v1"));
        await page.goto("/pos");
        expect(await presetsSeen(), cold ? "carga en frío" : "carga con foto").toEqual(["boutique"]);
      }
    } finally {
      await resetPosPreset(page);
    }
  });

  test("efectivo con monto rápido y vuelto", async ({ page }) => {
    await cartWithProduct(page);
    const sheet = await openCheckout(page);
    await expect(sheet.getByText("¿Cómo paga?")).toBeVisible();
    await tender(sheet, "Efectivo");
    // Primer monto rápido distinto de "Exacto" (> total).
    await sheet.getByRole("button", { name: /^\$\s?[\d.]+$/ }).first().click();
    await expect(sheet.getByText("Vuelto").first()).toBeVisible();
    await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();
    await finishAndVoid(page);
  });

  // Toda variante de la hoja de cobro permite dividir el pago. El preset se fija
  // explícitamente (no depende de lo que dejó otro test) y se restaura al final.
  for (const { preset, layout } of [
    { preset: "Mostrador", layout: "dos columnas" },
    { preset: "Caja rápida", layout: "teclado primero" },
  ]) {
    test(`pago mixto: efectivo + transferencia (${layout})`, async ({ page }) => {
      try {
        await gotoClean(page, "/pos");
        await setPosPreset(page, preset);
        await cartWithProduct(page);
        const sheet = await openCheckout(page);
        await tender(sheet, "Efectivo");
        if (layout === "teclado primero") {
          await expect(sheet.getByRole("group", { name: "Teclado numérico" })).toBeVisible();
        }
        await sheet.getByRole("radio", { name: "½", exact: true }).click();
        await expect(sheet.getByText(/^Quedan \$.+ para cobrar con otro medio/)).toBeVisible();
        await sheet.getByRole("button", { name: "Exacto", exact: true }).click();
        await sheet.getByRole("button", { name: /^Agregar pago/ }).click();
        await expect(sheet.getByText("Resta cobrar").locator("visible=true")).toBeVisible();
        await expect(sheet.getByRole("list", { name: "Pagos" })).toContainText("Efectivo");
        await tender(sheet, "Transferencia");
        await sheet.getByRole("button", { name: /^(Cobrar|Confirmar venta) \$/ }).click();
        const confirm = sheet.getByRole("button", { name: /^Confirmar venta/ });
        if (await appears(confirm, 1_500)) await confirm.click();
        await finishAndVoid(page);
      } finally {
        await resetPosPreset(page);
      }
    });
  }

  test("Directo: registro manual con número de operación", async ({ page }) => {
    await cartWithProduct(page);
    const sheet = await openCheckout(page);
    const directo = sheet.getByRole("button", { name: /^Directo/ });
    if (!(await appears(directo, 3_000))) {
      await page.keyboard.press("Escape");
      test.skip(true, "Directo no está habilitado en el tenant QA (feature/provider)");
    }
    await directo.first().click();
    const op = sheet.getByLabel("Número de operación");
    await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();
    // Requerido: sin número no cobra.
    await expect(op).toBeVisible();
    await op.fill(`${Date.now()}`.slice(-6));
    await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();
    await finishAndVoid(page);
  });

  test("cuenta corriente con cliente de prueba", async ({ page }) => {
    await cartWithProduct(page);
    // Elegir cliente.
    await page.getByRole("button", { name: /Elegir|Consumidor final/ }).first().click();
    const picker = dialog(page, "Cliente de la venta");
    await picker.getByPlaceholder("Buscar por nombre, documento o teléfono").fill(QA_CUSTOMER);
    const row = picker.getByRole("button", { name: new RegExp(escapeRe(QA_CUSTOMER)) });
    if (!(await appears(row, 5_000))) {
      test.skip(true, `No existe el cliente de prueba "${QA_CUSTOMER}" en el tenant QA`);
    }
    await row.first().click();

    const sheet = await openCheckout(page);
    const cc = sheet.getByRole("button", { name: /^Cuenta corriente/ });
    if (!(await appears(cc, 3_000))) {
      await page.keyboard.press("Escape");
      test.skip(true, "cuenta_corriente no habilitada en el plan del tenant QA");
    }
    await cc.first().click();
    await expect(sheet.getByText("Saldo").first()).toBeVisible();
    await expect(sheet.getByText(/Disponible|Sin límite/).first()).toBeVisible();

    const cuotas = sheet.getByLabel("Cuotas");
    if (await appears(cuotas, 1_500)) {
      const options = await cuotas.locator("option").allInnerTexts();
      const multi = options.find((o) => /^\d+ cuotas/.test(o));
      if (multi) {
        await cuotas.selectOption({ label: multi });
        await expect(sheet.getByText(/Vencen:/)).toBeVisible();
      }
    }
    await sheet.getByRole("button", { name: /^(Cobrar|Confirmar venta) \$/ }).click();
    await finishAndVoid(page);
  });
});
