import { test, expect, requireSession } from "./support/fixtures";
import { appears, gotoClean } from "./support/app";

// Secciones de Configuración con contenido propio: listas de precios (modo
// simple), Mis PINes y hardware. Sólo lectura: no se crea ninguna lista, no se
// genera ni guarda ningún PIN y no se tocan reglas de balanza o cajón.

test.describe("ajustes del negocio", () => {
  requireSession();

  test("listas de precios: el modo simple carga", async ({ page }) => {
    await gotoClean(page, "/configuracion?seccion=precios");
    await expect(page.getByRole("main").getByRole("heading", { level: 2, name: "Listas de precios" })).toBeVisible();
    const mode = page.getByRole("radiogroup", { name: "Modo" });
    // Sin el plan PRO no hay selector de modo: el simple es el único.
    if (await appears(mode, 3_000)) {
      await expect(mode.getByRole("radio", { name: "Simple" })).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByRole("button", { name: "Nueva lista" })).toBeVisible();
    // Listado o estado vacío.
    await expect(
      page
        .getByText("Sin listas de precios. Creá la primera.")
        .or(page.getByRole("main").getByRole("heading", { level: 3 }))
        .first(),
    ).toBeVisible();
  });

  test("seguridad: la pestaña Mis PINes carga sin generar nada", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && /rpc\/(generate|create|set|rotate|enroll)[a-z_]*pin/i.test(r.url())) writes.push(r.url());
    });
    await gotoClean(page, "/configuracion?seccion=seguridad");
    const tabs = page.getByRole("radiogroup", { name: "Sección" });
    await tabs.getByRole("radio", { name: "Mis PINes" }).click();
    await expect(tabs.getByRole("radio", { name: "Mis PINes" })).toHaveAttribute("aria-checked", "true");
    for (const h of ["PIN fijo", "PIN rotativo", "PIN de un uso", "App autenticadora"]) {
      await expect(page.getByRole("heading", { level: 3, name: h, exact: true })).toBeVisible();
    }
    // El PIN fijo no se guarda con campos vacíos o distintos.
    const save = page.getByRole("button", { name: "Guardar", exact: true }).first();
    await expect(save).toBeDisabled();
    await expect(page.getByRole("button", { name: "Generar PIN de un uso" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "PIN de un uso activos" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Quién usó tus autorizaciones" })).toBeVisible();
    // Las otras pestañas también cargan.
    for (const t of ["Supervisores", "Auditoría", "PIN y políticas"]) {
      await tabs.getByRole("radio", { name: t }).click();
      await expect(tabs.getByRole("radio", { name: t })).toHaveAttribute("aria-checked", "true");
    }
    expect(writes).toEqual([]);
  });

  test("hardware: diagnóstico y Qué tiene cada caja", async ({ page }) => {
    await gotoClean(page, "/configuracion?seccion=hardware");
    await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(
      /^(Balanza, cajón y diagnóstico|Diagnóstico de hardware)$/,
    );
    // Centro de diagnóstico (todas las versiones).
    await expect(page.getByRole("button", { name: "Exportar (XLSX)" })).toBeVisible();
    await expect(page.getByText("Entorno y capacidades del navegador").first()).toBeVisible();

    // Balanza y cajón por caja (ADR-063): llega con tanda J.
    const perRegister = page.getByText("Qué tiene cada caja", { exact: true }).first();
    test.skip(!(await appears(perRegister, 5_000)), "Balanza y cajón por caja (ADR-063) todavía no está desplegado");
    await expect(page.getByText("Equipos enchufados en cada caja y las reglas que le tocan por su sucursal.")).toBeVisible();
    // Una fila por caja con su botón Equipos (no se abre: guardar cambia la caja).
    await expect(page.getByRole("button", { name: "Equipos" }).first()).toBeVisible();
    await expect(page.getByText(/^(Sin balanza|Sin cajón|Pin \d+ · \d+ ms|Sin configurar)/).first()).toBeVisible();
  });
});
