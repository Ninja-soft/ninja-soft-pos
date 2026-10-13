import { test, expect, requireSession } from "./support/fixtures";
import { appears, closeDialogs, gotoClean } from "./support/app";

// Panel del dueño (/dashboard-team): resumen, hoy, sucursales, accesos,
// equipo y suscripción. Monitor de cajas (/caja/monitor): sucursales, KPIs
// y el detalle de un turno abierto. Sólo lectura (no se fuerza ningún cierre
// ni se cambian umbrales).

test.describe("panel del dueño", () => {
  requireSession();

  test("tarjetas del panel", async ({ page }) => {
    await gotoClean(page, "/dashboard-team");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const resumen = page.getByRole("region", { name: "Resumen" });
    await expect(resumen).toBeVisible();
    await expect(resumen.getByText("Uso del plan")).toBeVisible();
    await expect(resumen.getByRole("link", { name: "Ver o cambiar plan" })).toBeVisible();

    const hoy = page.getByRole("region", { name: "Hoy" });
    await expect(hoy.getByRole("heading", { level: 2, name: "Hoy en el negocio" })).toBeVisible();
    // Etiqueta en mayúsculas por CSS: texto plano (sin distinguir mayúsculas).
    await expect(hoy.getByText("Vendido hoy").first()).toBeVisible();
    await expect(hoy.getByRole("link", { name: /^Cajas abiertas/ }).first()).toBeVisible();
    await expect(hoy.getByRole("region", { name: "Sucursales" })).toBeVisible();

    for (const h of ["Accesos rápidos", "Equipo", "Suscripción"]) {
      await expect(page.getByRole("heading", { level: 2, name: h, exact: true })).toBeVisible();
    }
    // Equipo: filtros por estado y buscador.
    const estado = page.getByRole("radiogroup", { name: "Estado" });
    await estado.getByRole("radio", { name: /^Activos/ }).click();
    await expect(estado.getByRole("radio", { name: /^Activos/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("searchbox", { name: "Buscar por nombre o email" }).fill("zzz-e2e-nadie");
    await expect(page.getByRole("button", { name: /^Acciones de / })).toHaveCount(0);
  });

  test("monitor de cajas", async ({ page }) => {
    await gotoClean(page, "/caja/monitor");
    await expect(page.getByRole("heading", { level: 1, name: "Cajas abiertas" })).toBeVisible();
    await expect(page.getByText(/Se actualiza solo cada 30 segundos/).first()).toBeVisible();
    const branches = page.getByRole("region", { name: "Sucursales" });
    await expect(branches.getByRole("article").first()).toBeVisible();
    for (const kpi of ["Ventas de los turnos", "Vendido en los turnos", "Efectivo esperado"]) {
      await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible();
    }
    // Detalle de un turno (si hay alguno abierto; el POS del suite deja uno).
    const detail = page.getByRole("button", { name: "Ver detalle" }).first();
    if (await appears(detail, 3_000)) {
      await detail.click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await closeDialogs(page);
    } else {
      await expect(page.getByText("No hay cajas abiertas")).toBeVisible();
    }
  });
});
