import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";

// Regresión de CVE-2025-29927 / GHSA-f82v-jwr5-mffw (OPS-45): en Next <14.2.25
// un request externo con `x-middleware-subrequest` hacía que el servidor
// salteara el middleware (la "protección contra recursión" contaba cuántas
// veces aparecía el nombre del middleware; con 5 lo daba por sub-request
// interno). `middleware.ts` es la barrera de sesión del panel: con el bypass,
// una ruta protegida se servía sin pasar por updateSession.
//
// Corre en modo smoke (CI `e2e-smoke`): no necesita sesión. Usa un contexto
// HTTP propio, sin cookies, y no sigue redirects para ver la respuesta del
// middleware tal cual.

const BYPASS_VALUES = [
  "middleware",
  "middleware:middleware:middleware:middleware:middleware",
  "src/middleware",
  "src/middleware:src/middleware:src/middleware:src/middleware:src/middleware",
  "pages/_middleware",
];

// [ruta protegida, login esperado]
const PROTECTED: Array<[string, string]> = [
  ["/dashboard", "/login"],
  ["/internal", "/login-internal"],
];

// Ruta inexistente y no pública: con el middleware activo es un 307 a /login;
// si el middleware se saltea, Next responde 404. Discrimina el bypass sin
// depender del chequeo de sesión que además hacen los layouts del panel.
const UNKNOWN_PRIVATE = "/ops45-probe-ruta-privada";

let api: APIRequestContext;

test.beforeAll(async ({ baseURL }) => {
  api = await playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
});

test.afterAll(async () => {
  await api.dispose();
});

async function expectMiddlewareRedirect(path: string, login: string, header?: string) {
  const res = await api.get(path, {
    maxRedirects: 0,
    headers: header ? { "x-middleware-subrequest": header } : {},
  });
  const body = await res.text();
  const ctx = `${path} con x-middleware-subrequest=${header ?? "(sin header)"}`;
  expect([307, 308], `${ctx}: status ${res.status()}`).toContain(res.status());
  const location = res.headers()["location"] ?? "";
  expect(new URL(location, "http://x").pathname, `${ctx}: location ${location}`).toBe(login);
  // El redirect lo dio el middleware (respuesta vacía), no el redirect() de
  // respaldo del layout, que renderiza HTML con la meta de redirección.
  expect(body, `${ctx}: el redirect no vino del middleware`).not.toContain("__next-page-redirect");
  expect(body).not.toContain("NEXT_REDIRECT");
}

test.describe("middleware · CVE-2025-29927 (x-middleware-subrequest)", () => {
  for (const [path, login] of PROTECTED) {
    test(`${path} sin sesión → ${login} (control, sin header)`, async () => {
      await expectMiddlewareRedirect(path, login);
    });

    for (const value of BYPASS_VALUES) {
      test(`${path} con x-middleware-subrequest="${value}" sigue redirigiendo`, async () => {
        await expectMiddlewareRedirect(path, login, value);
      });
    }
  }

  test("ruta privada inexistente: el middleware corre aunque venga el header", async () => {
    await expectMiddlewareRedirect(UNKNOWN_PRIVATE, "/login");
    for (const value of BYPASS_VALUES) {
      await expectMiddlewareRedirect(UNKNOWN_PRIVATE, "/login", value);
    }
  });
});
