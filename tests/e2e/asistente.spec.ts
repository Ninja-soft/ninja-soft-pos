import { test, expect, requireSession, settle } from "./support/fixtures";
import { AI_ENABLED, RUN_PREFIX } from "./support/env";
import { appears } from "./support/app";

// Flujo 8 · Asistente IA: la burbuja abre el panel y el historial renderiza.
// No gasta cuota: sólo manda un mensaje con E2E_AI=1.

test.describe("asistente IA", () => {
  requireSession();

  test("burbuja, panel e historial", async ({ page }) => {
    await page.goto("/dashboard");
    await settle(page);
    const bubble = page.getByRole("button", { name: "Abrir asistente IA" });
    await expect(bubble).toBeVisible({ timeout: 30_000 });
    await bubble.click();

    const panel = page.getByRole("dialog", { name: "Asistente IA" });
    await expect(panel).toBeVisible();
    test.skip(
      await appears(panel.getByText("Complemento opcional"), 2_000),
      "El tenant QA no tiene el add-on asistente_ia",
    );

    await panel.getByRole("button", { name: "Conversaciones" }).click();
    await expect(panel.getByText("Se guardan 15 días desde el último mensaje.")).toBeVisible();
    await expect(
      panel
        .locator('ul[aria-label="Conversaciones recientes"]')
        .or(panel.getByText("Todavía no tenés conversaciones")),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Volver al chat" }).click();
    await expect(panel.getByLabel("Mensaje para el asistente")).toBeVisible();

    if (AI_ENABLED) {
      await panel.getByLabel("Mensaje para el asistente").fill(`${RUN_PREFIX}: respondé sólo "ok".`);
      await panel.getByRole("button", { name: "Enviar mensaje" }).click();
      const log = panel.getByRole("log", { name: "Conversación con el asistente" });
      await expect(log).toContainText(RUN_PREFIX);
      await expect(panel.getByRole("status", { name: "El asistente está escribiendo" })).toHaveCount(0, {
        timeout: 60_000,
      });
    }

    await panel.getByRole("button", { name: "Cerrar asistente" }).click();
    await expect(panel).toHaveCount(0);
  });
});
