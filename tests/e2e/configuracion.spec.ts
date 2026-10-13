import { test, expect, requireSession, settle } from "./support/fixtures";
import { appears, closeDialogs, gotoClean } from "./support/app";
import { guardEdgeFunctions } from "./support/mocks";

// Centro de Configuración: cada sección del menú carga, el buscador filtra,
// los links ?seccion= (y sus alias) abren la sección correcta, Sucursales y
// cajas, el wizard de terminales (sin guardar) y la config de transferencias
// (sólo lectura). Nada de lo que se abre acá se guarda.

const nav = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "Secciones de configuración" });
const sectionTitle = (page: import("@playwright/test").Page) =>
  page.getByRole("main").getByRole("heading", { level: 2 }).first();

test.describe("configuración", () => {
  requireSession();

  test("cada sección del menú carga su contenido", async ({ page, allowConsole }) => {
    test.setTimeout(240_000);
    // Algunas secciones consultan Edge Functions al cargar: no salen.
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
    await gotoClean(page, "/configuracion");
    const buttons = nav(page).getByRole("button");
    const labels = (await buttons.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(labels.length).toBeGreaterThan(10);
    for (const label of labels) {
      await nav(page).getByRole("button", { name: label, exact: true }).click();
      // Sección con candado: abre el UpgradeModal en vez de entrar.
      if (await appears(page.getByRole("dialog"), 800)) {
        await closeDialogs(page);
        continue;
      }
      await expect(page).toHaveURL(/[?&]seccion=/);
      await expect(sectionTitle(page), `sección ${label}`).toBeVisible();
      await expect(page.getByText(/Algo salió mal|Error al cargar/).first()).toHaveCount(0);
    }
  });

  test("el buscador filtra el menú sin tildes", async ({ page }) => {
    await gotoClean(page, "/configuracion");
    const search = page.getByRole("searchbox", { name: "Buscar ajuste" });
    await search.fill("cupon");
    await expect(nav(page).getByRole("button", { name: "Promociones y cupones" })).toBeVisible();
    await expect(nav(page).getByRole("button", { name: "Apariencia", exact: true })).toHaveCount(0);
    // Palabra clave (no está en la etiqueta): "fiado" → Cuenta corriente.
    await search.fill("fiado");
    await expect(nav(page).getByRole("button", { name: "Cuenta corriente" })).toBeVisible();
    await page.getByRole("button", { name: "Limpiar búsqueda" }).click();
    await expect(search).toHaveValue("");
    await expect(nav(page).getByRole("button", { name: "Apariencia", exact: true })).toBeVisible();
  });

  test("links ?seccion= y alias abren la sección", async ({ page }) => {
    for (const [q, title] of [
      ["sucursales", "Sucursales y cajas"],
      ["pagos", "Medios de pago"],
      ["medios-pago", "Medios de pago"], // alias
      ["terminales", "Terminales de cobro"],
      ["auditoria", "Seguridad y auditoría"], // alias
      ["listas-precios", "Listas de precios"], // alias
      ["no-existe", "Apariencia"], // inválida → sección por defecto
    ] as const) {
      await page.goto(`/configuracion?seccion=${q}`);
      await settle(page);
      await expect(sectionTitle(page), `?seccion=${q}`).toHaveText(title);
    }
  });

  test("sucursales y cajas: tarjeta y ficha de la sucursal", async ({ page }) => {
    await gotoClean(page, "/configuracion?seccion=sucursales");
    await expect(page.getByText(/^\d+ sucursal(es)?$/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Nueva sucursal" })).toBeVisible();
    const card = page.getByRole("article").first();
    await expect(card.getByRole("heading", { level: 3 })).toBeVisible();
    await card.getByRole("button", { name: "Ver sucursal" }).click();
    const sheet = page.getByRole("dialog").first();
    await expect(sheet).toBeVisible();
    const tabs = sheet.getByRole("radiogroup", { name: "Sección de la sucursal" });
    for (const t of ["Cajas", "Personal", "Configuración", "Historial", "Resumen"]) {
      await tabs.getByRole("radio", { name: t }).click();
      await expect(tabs.getByRole("radio", { name: t })).toHaveAttribute("aria-checked", "true");
    }
    await closeDialogs(page);
  });

  test("terminales: el wizard recorre pasos sin guardar", async ({ page, allowConsole }) => {
    allowConsole(/functions\/v1|status of 503/);
    await guardEdgeFunctions(page);
    // Si algo intentara guardar, se corta y el test falla.
    const writes: string[] = [];
    await page.route(/\/rest\/v1\/payment_terminals/, (route) => {
      if (route.request().method() === "GET") return route.fallback();
      writes.push(route.request().method());
      return route.abort();
    });
    await gotoClean(page, "/configuracion?seccion=terminales");
    const add = page
      .getByRole("button", { name: "Agregar la primera terminal" })
      .or(page.getByRole("button", { name: /^(Nueva|Agregar) terminal/ }));
    await add.first().click();
    const wizard = page.getByRole("dialog", { name: "Nueva terminal" });
    await expect(wizard).toBeVisible();
    await expect(wizard.getByRole("heading", { name: "¿Qué tipo de terminal?" })).toBeVisible();
    const next = wizard.getByRole("button", { name: "Siguiente" });
    // "Posnet sin integrar" no se registra (manda a Tarjeta en posnet): se usa
    // el pinpad conectado, que tiene simulador y recorre todos los pasos.
    await wizard.getByRole("radio", { name: /^Posnet o pinpad conectado/ }).click();
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      seen.add((await wizard.getByRole("heading", { level: 3 }).first().innerText()).trim());
      // Grupos de opciones sin elegir (marca, equipo, caja…): la primera.
      const groups = wizard.getByRole("radiogroup");
      for (let g = 0; g < (await groups.count()); g++) {
        const group = groups.nth(g);
        if (!(await group.isVisible())) continue;
        if ((await group.locator('[aria-checked="true"]').count()) > 0) continue;
        const first = group.getByRole("radio").first();
        if ((await first.count()) > 0 && (await first.isEnabled())) await first.click();
      }
      const name = wizard.getByLabel("Nombre", { exact: true });
      if ((await name.count()) > 0 && (await name.inputValue()) === "") await name.fill("E2E terminal (no se guarda)");
      if (!(await next.isVisible()) || (await next.isDisabled())) break;
      await next.click();
    }
    expect(seen.size, `pasos recorridos: ${[...seen].join(" / ")}`).toBeGreaterThanOrEqual(3);
    await wizard.getByRole("button", { name: /^(Cancelar|Atrás)$/ }).first().click();
    await closeDialogs(page);
    expect(writes).toEqual([]);
  });

  test("transferencias: configuración visible sin cambios", async ({ page }) => {
    await gotoClean(page, "/configuracion?seccion=pagos");
    const sw = page.getByRole("switch", { name: /^Habilitar Transferencia/ });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    // El "Configurar" de la fila de Transferencia (primer Configurar de cobros directos).
    const row = page.locator("div").filter({ has: sw }).filter({ has: page.getByRole("button", { name: "Configurar" }) }).last();
    await row.getByRole("button", { name: "Configurar" }).click();
    await expect(page.getByRole("switch", { name: "Mostrar pantalla de transferencia al cobrar" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Pedir número de operación" })).toBeVisible();
    await expect(page.getByText("Cuentas para recibir").first()).toBeVisible();
  });
});
