import { defineConfig, devices, chromium } from "@playwright/test";
import { existsSync } from "node:fs";

// E2E de NinjaSoft POS. Ver tests/e2e/README.md.
//
// - BASE_URL: app a probar (default http://localhost:3005, el dev server local).
// - Con E2E_ACCESS_TOKEN / E2E_REFRESH_TOKEN / E2E_SUPABASE_REF / E2E_QA_TENANT_ID
//   el global setup escribe las cookies de sesión y corren TODOS los specs.
// - Sin tokens = modo smoke: sólo corren las páginas públicas; el resto se
//   saltea con test.skip.

// Un id por corrida, compartido con los workers (heredan process.env).
process.env.E2E_RUN_ID ??= String(Date.now());

// PWA (H65, tests/e2e/pwa-offline.spec.ts): sin esto, context.setOffline no
// alcanza a los fetch del service worker y la prueba "offline" usaría la red.
if (process.env.E2E_PWA === "1") process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3005";
const SYSTEM_CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// Si no hay browsers de Playwright instalados, usamos el Chrome del sistema.
function chromeExecutable(): string | undefined {
  if (process.env.E2E_CHROME_PATH) return process.env.E2E_CHROME_PATH;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // sin browsers de Playwright
  }
  return existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined;
}

const chromeUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1440, height: 900 },
  launchOptions: { executablePath: chromeExecutable() },
};

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Los flujos comparten estado del tenant QA (turno de caja, cliente de
  // prueba): corren en serie para ser deterministas.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // En dev la primera compilación de cada ruta tarda.
    navigationTimeout: 60_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chrome",
      testIgnore: "**/session-end.spec.ts",
      use: chromeUse,
      // El corte por inactividad revoca la sesión: corre al final.
      teardown: "session-end",
    },
    {
      name: "session-end",
      testMatch: "**/session-end.spec.ts",
      use: chromeUse,
    },
  ],
});
