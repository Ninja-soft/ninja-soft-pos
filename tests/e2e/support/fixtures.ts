import { writeFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { AUTH_STATE_PATH, HAS_SESSION, SMOKE_SKIP_REASON } from "./env";

// Ruido conocido de terceros / dev que no indica un bug nuestro.
const CONSOLE_ALLOWLIST: RegExp[] = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /\[HMR\]/i,
  /favicon\.ico/i,
  /_vercel\/(insights|speed-insights)/i,
  /vercel-scripts|va\.vercel-scripts/i,
  /googletagmanager|google-analytics|gstatic|accounts\.google/i,
  /mercadopago|mlstatic/i,
  /sentry/i,
  /Third-party cookie/i,
  /ERR_BLOCKED_BY_CLIENT/i,
];

function allowed(text: string) {
  return CONSOLE_ALLOWLIST.some((re) => re.test(text));
}

type Fixtures = {
  /** Errores de consola y excepciones no capturadas de la página. */
  consoleErrors: string[];
  /** Permite que un test acepte errores esperables (p. ej. un 4xx provocado). */
  allowConsole: (re: RegExp) => void;
  /** Persiste cookies de sesión rotadas para el próximo test. */
  persistSession: void;
  /** Modo smoke: responde PostgREST en vacío para no depender de un Supabase. */
  smokeOffline: void;
};

export const test = base.extend<Fixtures>({
  storageState: async ({}, use) => {
    await use(AUTH_STATE_PATH);
  },
  // Si el access token vence durante la corrida, el middleware lo refresca y
  // ROTA el refresh token. El próximo test arrancaría con el viejo (reuso →
  // Supabase revoca la sesión), así que guardamos las cookies nuevas.
  // Seguro porque los tests corren en serie (workers: 1).
  smokeOffline: [
    async ({ context }, use) => {
      if (!HAS_SESSION) {
        await context.route("**/rest/v1/**", (route) =>
          route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
        );
      }
      await use();
    },
    { auto: true },
  ],
  persistSession: [
    async ({ context, storageState }, use) => {
      await use();
      if (!HAS_SESSION || storageState !== AUTH_STATE_PATH) return;
      const state = await context.storageState().catch(() => null);
      const hasAuth = state?.cookies.some((c) => /^sb-.+-auth-token/.test(c.name));
      if (state && hasAuth) writeFileSync(AUTH_STATE_PATH, JSON.stringify(state));
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const loc = msg.location()?.url ?? "";
        const text = `${msg.text()} ${loc}`.trim();
        if (!allowed(text)) errors.push(text);
      });
      page.on("pageerror", (err) => {
        const text = `pageerror: ${err.message}`;
        if (!allowed(text)) errors.push(text);
      });
      await use(errors);
    },
    { auto: true },
  ],
  // Auto: al cerrar cada test falla si quedó algún error de consola no permitido.
  allowConsole: [
    async ({ consoleErrors }, use) => {
      const extra: RegExp[] = [];
      await use((re) => {
        extra.push(re);
      });
      const remaining = consoleErrors.filter((e) => !extra.some((re) => re.test(e)));
      expect(remaining, "errores de consola").toEqual([]);
    },
    { auto: true },
  ],
});

/** Saltea el bloque si no hay sesión (modo smoke). */
export function requireSession() {
  test.skip(!HAS_SESSION, SMOKE_SKIP_REASON);
}

/** Espera a que la app termine de hidratar/cargar (sin requests pendientes). */
export async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
}

export { expect };
