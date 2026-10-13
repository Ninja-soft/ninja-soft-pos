import type { Page } from "@playwright/test";
import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, gotoClean } from "./support/app";
import { fakeUuid, fulfillJson, guardEdgeFunctions } from "./support/mocks";

// Conciliación (hub de tanda J): resumen del período, pestañas Por
// procesador / Tarjetas por lote / Pendientes de revisar, estado vacío "dos
// pasos", selección masiva en Tarjetas por lote, Excel y el aviso de NubCeo.
// No se conecta ningún procesador, no se importa nada y no se marca nada
// como conciliado: las Edge Functions se cortan en el navegador y la escritura
// de conciliación (set_payments_reconciled) se bloquea.

const HUB = "Conciliación";
const PROMO = "Integración con NubCeo";
const PROMO_KEY = "ninja.nubceo.promo.dismissed";

const tabs = (page: Page) => page.getByRole("radiogroup", { name: "Vista de la conciliación" });

/** Cobros con tarjeta simulados (sólo la lectura de Tarjetas por lote). */
async function fakeCardPayments(page: Page) {
  const now = new Date();
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const row = (amount: number, method: "debit" | "credit", minAgo: number, ticket: number) => ({
    id: fakeUuid(),
    method,
    amount,
    reference: null,
    created_at: at(minAgo),
    reconciled_at: null,
    card_voucher: { marca: "visa", lote: "E2E1", cupon: String(1000 + ticket), autorizacion: "A1B2C3", ultimos4: "4242", comercio: "99999" },
    metadata: {},
    sales: { number: ticket, status: "completed", cash_shift: { opened_by: null } },
  });
  const rows = [row(1500, "debit", 30, 9001), row(2750, "credit", 20, 9002)];
  await page.route(/\/rest\/v1\/payments\?/, (route) => {
    const url = decodeURIComponent(route.request().url());
    if (route.request().method() !== "GET" || !/method=in\.\(debit,credit\)/.test(url)) return route.fallback();
    // Paginado: la primera página trae todo; las siguientes, vacío.
    return fulfillJson(route, /offset=[1-9]/.test(url) ? [] : rows);
  });
}

test.describe("conciliación", () => {
  requireSession();

  test.beforeEach(async ({ page, allowConsole }) => {
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
    // Nunca se concilia de verdad desde el suite.
    await page.route(/\/rest\/v1\/rpc\/set_payments_reconciled/, (route) => route.abort());
  });

  test("hub: resumen, pestañas y estado vacío", async ({ page }) => {
    await gotoClean(page, "/reportes/conciliacion");
    await expect(page.getByRole("heading", { level: 1, name: HUB, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exportar Excel" })).toBeVisible();
    for (const k of [/^Vendiste/, /^Te cobraron/, /^Te acreditaron/, /^Falta acreditar/, /^En riesgo/]) {
      await expect(page.getByText(k).first()).toBeVisible();
    }
    // Vista por defecto: Por procesador (si hay procesadores activos).
    const t = tabs(page);
    const proc = t.getByRole("radio", { name: "Por procesador" });
    if (await appears(proc, 2_000)) await expect(proc).toHaveAttribute("aria-checked", "true");
    // Sin cobros: guía de dos pasos y procesadores disponibles (no se tocan).
    const empty = page.getByRole("heading", { level: 3, name: "Empezá a conciliar en dos pasos" });
    if (await appears(empty, 4_000)) {
      await expect(page.getByRole("button", { name: "Conectar Mercado Pago" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Importar liquidación" }).first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Sumá más procesadores" })).toBeVisible();
    } else {
      await expect(page.getByRole("region", { name: "Procesadores con cobros" })).toBeVisible();
    }

    // Rango rápido.
    for (const quick of ["Hoy", "30 días", "Este mes", "Mes pasado", "7 días"]) {
      await page.getByRole("button", { name: quick, exact: true }).click();
      await settle(page);
    }

    // Pestañas por URL.
    await t.getByRole("radio", { name: "Tarjetas por lote" }).click();
    await expect(page).toHaveURL(/vista=tarjetas/);
    const pend = t.getByRole("radio", { name: "Pendientes de revisar" });
    if (await appears(pend, 2_000)) {
      await pend.click();
      await expect(page).toHaveURL(/vista=pendientes/);
      await expect(
        page.getByText("No hay nada pendiente").or(page.getByRole("radiogroup", { name: "Tipo de pendiente" })).first(),
      ).toBeVisible();
    }
    // Deep link a una vista.
    await gotoClean(page, "/reportes/conciliacion?vista=tarjetas");
    await expect(t.getByRole("radio", { name: "Tarjetas por lote" })).toHaveAttribute("aria-checked", "true");
  });

  test("tarjetas por lote: filtros", async ({ page }) => {
    await gotoClean(page, "/reportes/conciliacion?vista=tarjetas");
    for (const [group, option] of [
      ["Tipo de tarjeta", "Débito"],
      ["Tipo de tarjeta", "Crédito"],
      ["Estado de conciliación", "Pendientes"],
      ["Estado de conciliación", "Conciliados"],
      ["Estado de conciliación", "Todos"],
      ["Tipo de tarjeta", "Todas"],
    ] as const) {
      const g = page.getByRole("radiogroup", { name: group });
      await g.getByRole("radio", { name: option }).click();
      await expect(g.getByRole("radio", { name: option })).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByRole("combobox", { name: "Marca" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "N° de comercio" })).toBeVisible();
    await expect(
      page
        .getByText("No hay cobros con tarjeta en este período")
        .or(page.getByRole("checkbox", { name: /^Seleccionar/ }))
        .first(),
    ).toBeVisible();
  });

  test("tarjetas por lote: selección masiva (cobros simulados)", async ({ page }) => {
    await fakeCardPayments(page);
    await gotoClean(page, "/reportes/conciliacion?vista=tarjetas");
    const one = page.getByRole("checkbox", { name: /^Seleccionar el cobro de \$\s?1\.500/ }).first();
    await expect(one).toBeVisible();
    await one.click();
    const bar = page.getByRole("region", { name: "Acciones con lo seleccionado" });
    await expect(bar).toBeVisible();
    await expect(bar.getByText(/^1 /).first()).toBeVisible();
    await expect(bar.getByRole("button", { name: "Exportar selección" })).toBeVisible();
    // Limpiar con Esc.
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // Todo lo filtrado (en la vista de tabla, si está).
    const all = page.getByRole("checkbox", { name: "Seleccionar todo lo filtrado" });
    const day = page.getByRole("checkbox", { name: /^Seleccionar los cobros del / }).first();
    await (await appears(all, 2_000) ? all : day).click();
    await expect(bar).toBeVisible();
    await expect(bar.getByText(/^2 /).first()).toBeVisible();
    await bar.getByRole("button", { name: "Limpiar selección (Esc)" }).click();
    await expect(bar).toHaveCount(0);
    // Con datos, el Excel del hub se habilita.
    await expect(page.getByRole("button", { name: "Exportar Excel" })).toBeEnabled();
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
      "Aviso de NubCeo no visible: la integración ya envía ventas o no está desplegado",
    );
    await expect(promo.getByText("¿Querés conciliar todo en automático? Conectá NubCeo")).toBeVisible();
    await expect(
      promo.getByRole("link", { name: /^(Conectar NubCeo|Disponible en el plan Business)$/ }),
    ).toHaveAttribute("href", /seccion=nubceo/);
    await expect(promo.getByRole("link", { name: /Conocer NubCeo/ })).toHaveAttribute("target", "_blank");

    await promo.getByRole("button", { name: "Ocultar aviso de NubCeo" }).click();
    await expect(promo).toHaveCount(0);
    // Queda oculto al volver, en cualquier pestaña.
    await page.reload();
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: HUB, exact: true })).toBeVisible();
    await expect(promo).toHaveCount(0);
    await gotoClean(page, "/reportes/conciliacion?vista=tarjetas");
    await expect(promo).toHaveCount(0);
  });
});
