import { test, expect, requireSession } from "./support/fixtures";

// Flujo 1 · Auth. Las páginas públicas corren también en modo smoke.
// El corte por inactividad vive en session-end.spec.ts: hace signOut y
// revoca la sesión, así que corre al final (proyecto teardown).

test.describe("auth · páginas públicas", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("login renderiza el formulario", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Iniciar", { exact: false }).first()).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ingresar con Google/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Olvidé mi contraseña" })).toBeVisible();
  });

  test("login valida campos vacíos sin llamar a Supabase", async ({ page }) => {
    let authCalls = 0;
    await page.route("**/auth/v1/**", (route) => {
      authCalls++;
      return route.abort();
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Entrar" }).click();
    // Zod marca el error en el form; no hubo request de login.
    await expect(page.locator("form [role=alert], form .text-danger, form .text-destructive").first()).toBeVisible();
    expect(authCalls).toBe(0);
  });

  test("ruta protegida sin sesión redirige a /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("/auth/callback sin code → /login?error=oauth", async ({ page }) => {
    await page.goto("/auth/callback");
    await expect(page).toHaveURL(/\/login\?error=oauth/);
    await expect(
      page.getByRole("alert").filter({ hasText: "No pudimos" }),
    ).toContainText("No pudimos completar el ingreso con Google");
  });

  test("/recover envía y muestra el mensaje neutro", async ({ page }) => {
    // Nunca dispara un email real: la Edge Function se intercepta.
    let invoked = false;
    await page.route("**/functions/v1/send_password_recovery**", (route) => {
      invoked = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto("/recover");
    await expect(page.getByText("Recuperar contraseña")).toBeVisible();
    await page.getByLabel("Email").fill("e2e-recover@example.com");
    await page.getByRole("button", { name: "Enviar enlace" }).click();
    await expect(
      page.getByText("Si el email está registrado, vas a recibir un enlace en breve."),
    ).toBeVisible();
    expect(invoked).toBe(true);
  });

  test("signup renderiza", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("button", { name: /Google/ }).first()).toBeVisible();
  });
});

test.describe("auth · con sesión", () => {
  requireSession();

  test("/login con sesión redirige a /dashboard", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("/auth/callback sin code con sesión igual cae en error=oauth", async ({ page }) => {
    // El callback no cambia de comportamiento con sesión: sin code no canjea.
    const res = await page.request.get("/auth/callback", { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.headers()["location"] ?? "").toContain("/login?error=oauth");
  });
});
