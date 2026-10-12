import { test, expect, requireSession } from "./support/fixtures";
import { BASE_URL } from "./support/env";

// Flujo 1 (cierre) · Inactividad. El middleware hace signOut() al detectar
// la marca vencida: eso REVOCA la sesión del usuario QA. Por eso corre como
// teardown, después de todos los demás specs (ver playwright.config.ts).
// Después de esta prueba hay que regenerar los tokens (scripts/e2e-session.mjs).

test.describe("auth · inactividad", () => {
  requireSession();

  test("cookie de actividad vencida → /login?reason=inactivity antes de renderizar", async ({
    page,
    context,
  }) => {
    const nineHoursAgo = Date.now() - 9 * 60 * 60 * 1000;
    await context.addCookies([
      {
        name: "ninja_last_activity",
        value: String(nineHoursAgo),
        domain: new URL(BASE_URL).hostname,
        path: "/",
      },
    ]);

    // El corte es en el middleware: la respuesta del documento ya es un redirect.
    const res = await page.request.get("/dashboard", { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.headers()["location"] ?? "").toContain("/login?reason=inactivity");

    await page.goto("/login?reason=inactivity");
    await expect(page.getByText("Tu sesión se cerró por inactividad")).toBeVisible();
  });
});
