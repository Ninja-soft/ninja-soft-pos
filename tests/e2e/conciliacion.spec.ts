import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, gotoClean } from "./support/app";
import { guardEdgeFunctions } from "./support/mocks";

// Conciliación: tarjetas por lote (filtros) y procesadores (vistas y
// filtros). El aviso de NubCeo se muestra y se oculta para siempre. No se
// conecta ningún procesador ni se piden movimientos a Mercado Pago (las Edge
// Functions se cortan en el navegador).

const PROMO = "Integración con NubCeo";
const PROMO_KEY = "ninja.nubceo.promo.dismissed";

test.describe("conciliación", () => {
  requireSession();

  test.beforeEach(async ({ page, allowConsole }) => {
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
  });

  test("tarjetas por lote: filtros", async ({ page }) => {
    await gotoClean(page, "/reportes/conciliacion");
    await expect(page.getByRole("heading", { level: 1, name: "Conciliación de tarjetas" })).toBeVisible();
    const view = page.getByRole("radiogroup", { name: "Vista de la conciliación" });
    await expect(view.getByRole("radio", { name: "Tarjetas por lote" })).toHaveAttribute("aria-checked", "true");

    for (const quick of ["Hoy", "Ayer", "Mes", "7 días"]) {
      await page.getByRole("button", { name: quick, exact: true }).click();
      await settle(page);
    }
    for (const [group, option] of [
      ["Tipo de tarjeta", "Débito"],
      ["Tipo de tarjeta", "Crédito"],
      ["Estado de conciliación", "Pendientes"],
      ["Estado de conciliación", "Conciliados"],
    ] as const) {
      const g = page.getByRole("radiogroup", { name: group });
      await g.getByRole("radio", { name: option }).click();
      await expect(g.getByRole("radio", { name: option })).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByRole("combobox", { name: "Marca" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "N° de comercio" })).toBeVisible();
    await expect(page.getByText(/^Total tarjetas/).first()).toBeVisible();
    // Con datos: grupos por lote; sin datos: estado vacío.
    await expect(
      page
        .getByText(/No hay cobros con tarjeta en este período|Ningún cobro coincide/)
        .or(page.getByText(/Lote/).first())
        .first(),
    ).toBeVisible();
  });

  test("procesadores: vista, procesador y filtros", async ({ page }) => {
    await gotoClean(page, "/reportes/conciliacion");
    await page
      .getByRole("radiogroup", { name: "Vista de la conciliación" })
      .getByRole("radio", { name: "Procesadores" })
      .click();
    await expect(page).toHaveURL(/vista=procesadores/);
    await expect(page.getByRole("heading", { level: 1, name: "Conciliación de procesadores" })).toBeVisible();

    const processor = page.getByRole("combobox", { name: "Procesador" });
    await expect(processor).toBeVisible();
    const filter = page.getByRole("radiogroup", { name: "Filtro de cobros" });
    await expect(filter).toBeVisible();
    for (const f of [/^Todos/, /^Conciliados/, /^Por acreditar/, /^Revisados/, /^Para revisar/]) {
      await filter.getByRole("radio", { name: f }).click();
      await expect(filter.getByRole("radio", { name: f })).toHaveAttribute("aria-checked", "true");
    }
    for (const quick of ["30 días", "Mes", "7 días"]) {
      await page.getByRole("button", { name: quick, exact: true }).click();
      await settle(page);
    }
    // Procesadores por archivo: cambia el origen sin romper la vista.
    const options = await processor.locator("option").allInnerTexts();
    const fileBased = options.find((o) => /archivo/i.test(o));
    if (fileBased) {
      await processor.selectOption({ label: fileBased });
      await settle(page);
      await expect(page.getByRole("heading", { level: 1, name: "Conciliación de procesadores" })).toBeVisible();
    }
    // Deep link directo a la vista.
    await gotoClean(page, "/reportes/conciliacion?vista=procesadores");
    await expect(page.getByRole("heading", { level: 1, name: "Conciliación de procesadores" })).toBeVisible();
  });

  test("aviso de NubCeo: se ve y se oculta para siempre", async ({ page }) => {
    await gotoClean(page, "/reportes/conciliacion");
    await page.evaluate((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        // sin storage
      }
    }, PROMO_KEY);
    await page.reload();
    await settle(page);
    const promo = page.getByRole("region", { name: PROMO });
    test.skip(
      !(await appears(promo, 6_000)),
      "Aviso de NubCeo no visible: no desplegado (tanda J) o la integración ya envía ventas",
    );
    await expect(promo.getByText("¿Querés conciliar todo en automático? Conectá NubCeo")).toBeVisible();
    await expect(
      promo.getByRole("link", { name: /^(Conectar NubCeo|Disponible en el plan Business)$/ }),
    ).toHaveAttribute("href", /seccion=nubceo/);
    await expect(promo.getByRole("link", { name: /Conocer NubCeo/ })).toHaveAttribute("target", "_blank");

    await promo.getByRole("button", { name: "Ocultar aviso de NubCeo" }).click();
    await expect(promo).toHaveCount(0);
    // Queda oculto al volver, también en la vista de procesadores.
    await page.reload();
    await settle(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(promo).toHaveCount(0);
    await gotoClean(page, "/reportes/conciliacion?vista=procesadores");
    await expect(promo).toHaveCount(0);
  });
});
