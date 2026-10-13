import { existsSync, readFileSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, requireSession } from "./support/fixtures";
import { BASE_URL, RUN_PREFIX, AUTH_STATE_PATH } from "./support/env";
import { addToCart, createSimpleProduct, deleteProduct, ensureShiftOpen, gotoClean } from "./support/app";

// @pwa · H65 (ADR-087): el POS se ABRE y RECARGA sin conexión.
//
// El service worker sólo se registra en un build de producción, así que esto
// corre contra `pnpm build && pnpm start -p 3005` LOCAL. Nunca contra
// producción ni en CI (pide build): se habilita con E2E_PWA=1.
//
//   pnpm build && pnpm start -p 3005
//   E2E_PWA=1 pnpm test:e2e tests/e2e/pwa-offline.spec.ts --no-deps
//
// El caso que vende además pide sesión QA y E2E_OFFLINE=1 (abre la caja del
// tenant QA). La venta queda en la cola local del contexto del test y NO se
// sincroniza: el contexto se descarta sin volver a conectarse.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(BASE_URL);
const ENABLED = process.env.E2E_PWA === "1" && LOCAL;
const SELL_ENABLED = ENABLED && process.env.E2E_OFFLINE === "1";
const OFFLINE_NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to fetch|NetworkError|Load failed|net::ERR/i;

/** Espera a que el service worker del POS esté activo y controlando la página. */
async function waitForSw(page: Page) {
  // expect.poll + evaluate: waitForFunction no espera promesas (las toma como truthy).
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/pos"))?.active?.state ?? null),
      { timeout: 60_000 },
    )
    .toBe("activated");
  // Recarga online para que la página quede controlada por el SW.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 30_000 }).toBe(true);
}

async function goOffline(context: BrowserContext) {
  await context.setOffline(true);
}

/** Ref de Supabase (nombre de la cookie sb-<ref>-auth-token) desde el entorno o .env.local. */
function supabaseRef(): string | null {
  if (process.env.E2E_SUPABASE_REF) return process.env.E2E_SUPABASE_REF;
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    (existsSync(".env.local")
      ? /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m.exec(readFileSync(".env.local", "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "")
      : undefined);
  try {
    return url ? new URL(url).hostname.split(".")[0] ?? null : null;
  } catch {
    return null;
  }
}

test.describe("@pwa POS sin conexión (anónimo)", () => {
  test.skip(!ENABLED, "PWA: E2E_PWA=1, build de producción y BASE_URL local");

  test("instala el shell y lo abre sin conexión en sólo lectura", async ({ browser }) => {
    // Contexto propio y sin sesión: el del fixture intercepta /rest/v1 en modo
    // smoke, y con la intercepción de Playwright el SW no controla la página.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    // ?from evita que el shell vuelva solo a /pos (que sin sesión va a /login).
    await page.goto("/pos-offline?from=e2e");
    await expect(page.getByTestId("pos-offline-screen")).toBeVisible();
    await waitForSw(page);

    // Manifest instalable.
    const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
    expect(manifest).toMatchObject({ start_url: "/pos", display: "standalone" });

    await goOffline(context);
    await page.reload();
    await expect(page.getByTestId("pos-offline-screen")).toBeVisible();
    await expect(page.getByTestId("pos-offline-readonly")).toHaveAttribute("data-reason", "no_device_data");

    // /pos sin red abre el shell (en la misma URL), nunca una página de error.
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/pos$/);
    await expect(page.getByTestId("pos-offline-readonly")).toBeVisible();

    // Nada del panel interno ni de /pagar queda en caché.
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        for (const r of await c.keys()) out.push(new URL(r.url).pathname);
      }
      return out;
    });
    expect(cached).toContain("/pos-offline");
    expect(cached.filter((p) => /^\/(internal|pagar|api|auth)|^\/pos$/.test(p))).toEqual([]);
    expect(
      cached.every(
        (p) =>
          p === "/pos-offline" ||
          p.startsWith("/_next/static/") ||
          p.startsWith("/brand/") ||
          p === "/manifest.webmanifest",
      ),
    ).toBe(true);
    await context.close();
  });
});

// Sesión simulada: cookie de sesión FALSA (tokens inventados) y foto local
// sembrada en IndexedDB, todo dentro de un contexto descartable que nunca
// vuelve a conectarse. Prueba el arranque y la venta sin tocar el servidor.
test.describe("@pwa POS sin conexión (sesión simulada, sin servidor)", () => {
  test.skip(!ENABLED, "PWA: E2E_PWA=1, build de producción y BASE_URL local");

  test("recarga /pos sin conexión, identifica al usuario y cobra con ticket provisorio", async ({ browser }) => {
    const ref = supabaseRef();
    test.skip(!ref, "Falta NEXT_PUBLIC_SUPABASE_URL o E2E_SUPABASE_REF");
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto("/pos-offline?from=e2e");
    await waitForSw(page);

    const tenantId = "00000000-0000-4000-8000-0000000000aa";
    const userId = "00000000-0000-4000-8000-0000000000bb";
    const session = JSON.stringify({
      access_token: "e2e-falso",
      refresh_token: "e2e-falso",
      expires_at: Math.floor(Date.now() / 1000) - 60,
      user: { id: userId, email: "cajero.e2e@example.com" },
    });
    await context.addCookies([
      {
        name: `sb-${ref}-auth-token`,
        value: `base64-${Buffer.from(session).toString("base64url")}`,
        url: BASE_URL,
      },
    ]);
    await page.evaluate(
      ({ tenantId, userId }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("ninja-pos-offline", 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "client_sale_id" });
            if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          };
          req.onsuccess = () => {
            const tx = req.result.transaction("kv", "readwrite");
            const kv = tx.objectStore("kv");
            const at = new Date().toISOString();
            kv.put({ v: 1, tenantId, userId, at }, "pos.last");
            kv.put(
              {
                v: 1,
                tenantId,
                userId,
                at,
                products: [
                  { id: "11111111-1111-4111-8111-111111111111", name: "Alfajor E2E", price: 700, unit: "u", sku: "E2E-1" },
                  { id: "22222222-2222-4222-8222-222222222222", name: "Remera E2E", price: 9000, unit: "u", has_variants: true },
                ],
                policy: { enabled: true, maxAmount: 50000, maxSales: 20, maxHours: 48 },
                shift: { id: "33333333-3333-4333-8333-333333333333", storeId: null },
              },
              `snapshot.${tenantId}.${userId}`,
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }),
      { tenantId, userId },
    );

    await goOffline(context);
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/pos$/);
    const screen = page.getByTestId("pos-offline-screen");
    await expect(screen).toBeVisible();
    await expect(page.getByTestId("pos-offline-readonly")).toHaveCount(0);
    await expect(screen).toContainText("cajero.e2e@example.com");

    await screen.getByPlaceholder(/Buscar por nombre/).fill("E2E");
    await expect(screen.getByRole("button", { name: "Agregar Remera E2E" })).toBeDisabled();
    await screen.getByRole("button", { name: "Agregar Alfajor E2E" }).click();
    await screen.getByRole("button", { name: "Agregar Alfajor E2E" }).click();
    await expect(page.getByTestId("pos-offline-total")).toContainText("1.400");
    await screen.getByRole("button", { name: /^Cobrar \$/ }).click();

    const ticket = page.getByTestId("offline-ticket");
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText(/OFF-[0-9A-F]{8}/);
    await page.getByRole("button", { name: "Listo" }).click();
    await expect(page.getByTestId("pos-offline-status")).toContainText("1 venta por sincronizar");

    // Otro usuario en la cookie: sólo lectura, no vende.
    const other = JSON.stringify({ ...JSON.parse(session), user: { id: "otro" } });
    await context.addCookies([
      { name: `sb-${ref}-auth-token`, value: `base64-${Buffer.from(other).toString("base64url")}`, url: BASE_URL },
    ]);
    await page.reload();
    await expect(page.getByTestId("pos-offline-readonly")).toHaveAttribute("data-reason", "other_user");
    await expect(page.getByTestId("pos-offline-cart")).toHaveCount(0);
    await context.close();
  });
});

test.describe("@pwa POS sin conexión (con sesión)", () => {
  requireSession();
  test.skip(!SELL_ENABLED, "PWA con venta: E2E_PWA=1, E2E_OFFLINE=1 y BASE_URL local");
  test.describe.configure({ mode: "serial" });

  const PRODUCT = `${RUN_PREFIX} pwa item`;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await createSimpleProduct(page, PRODUCT, 700);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: AUTH_STATE_PATH });
    await deleteProduct(page, PRODUCT).catch(() => undefined);
    await page.close();
  });

  test("recarga /pos sin conexión y cobra en efectivo con ticket provisorio", async ({ page, context, allowConsole }) => {
    allowConsole(OFFLINE_NOISE);
    await gotoClean(page, "/pos");
    await ensureShiftOpen(page);
    // Que el producto esté en la foto local.
    await addToCart(page, PRODUCT);
    await waitForSw(page);
    // El POS dejó el puntero pos.last (IndexedDB) para abrirse sin conexión.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<boolean>((resolve) => {
                const req = indexedDB.open("ninja-pos-offline");
                req.onsuccess = () => {
                  const get = req.result.transaction("kv", "readonly").objectStore("kv").get("pos.last");
                  get.onsuccess = () => resolve(Boolean(get.result));
                  get.onerror = () => resolve(false);
                };
                req.onerror = () => resolve(false);
              }),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    await goOffline(context);
    await page.reload();
    await expect(page).toHaveURL(/\/pos$/);
    const screen = page.getByTestId("pos-offline-screen");
    await expect(screen).toBeVisible();
    await expect(page.getByTestId("pos-offline-readonly")).toHaveCount(0);

    await screen.getByPlaceholder(/Buscar por nombre/).fill(PRODUCT);
    await screen.getByRole("button", { name: `Agregar ${PRODUCT}` }).click();
    await expect(page.getByTestId("pos-offline-total")).toContainText("700");
    await screen.getByRole("button", { name: /^Cobrar \$/ }).click();

    const ticket = page.getByTestId("offline-ticket");
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText(/OFF-[0-9A-F]{8}/);
    await page.getByRole("button", { name: "Listo" }).click();
    await expect(page.getByTestId("pos-offline-status")).toContainText("1 venta por sincronizar");
    // Sin volver a conectar: la venta no llega al servidor.
  });
});
