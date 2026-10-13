import type { Page, Request, Route } from "@playwright/test";

// Mocks de red para los flujos que tocan proveedores de pago. Regla del suite:
// contra producción NINGUNA Edge Function de cobro llega al servidor real. Las
// que el test necesita se responden acá; el resto se corta.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export type EdgeHandler = (body: Record<string, unknown>, req: Request) => unknown;

/** Responde JSON con CORS abierto (Supabase está en otro origen). */
export function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({
    status,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

function bodyOf(req: Request): Record<string, unknown> {
  try {
    return (req.postDataJSON() as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Corta toda llamada a `functions/v1/*`. Las de `handlers` (por nombre de
 * función) se responden con lo que devuelva el handler. Los preflight y los
 * "warm-up" (OPTIONS) se contestan 200 para no ensuciar la consola.
 */
export async function guardEdgeFunctions(page: Page, handlers: Record<string, EdgeHandler> = {}) {
  await page.route("**/functions/v1/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      return route.fulfill({ status: 200, headers: CORS, body: "ok" });
    }
    const name = new URL(req.url()).pathname.split("/functions/v1/")[1]?.split("/")[0] ?? "";
    const h = handlers[name];
    if (!h) {
      // Sin handler: no sale nada. 503 (no abort) para que la app lo trate
      // como un error de red normal.
      return fulfillJson(route, { error: "e2e_blocked" }, 503);
    }
    return fulfillJson(route, h(bodyOf(req), req));
  });
}

/** PostgREST devuelve objeto si el cliente pidió `.single()` / `.maybeSingle()`. */
export function wantsObject(req: Request) {
  return (req.headers()["accept"] ?? "").includes("vnd.pgrst.object");
}

/**
 * Deja pasar la lectura real y la modifica antes de entregarla (p. ej. sumar
 * una fila o prender una feature). Mantiene status y headers del servidor.
 */
export async function patchJson(
  page: Page,
  url: string | RegExp,
  patch: (json: unknown, req: Request) => unknown,
) {
  await page.route(url, async (route) => {
    const req = route.request();
    if (req.method() !== "GET" && req.method() !== "POST") return route.fallback();
    const res = await route.fetch();
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return route.fulfill({ response: res });
    }
    return route.fulfill({ response: res, json: patch(json, req) });
  });
}

/** UUID v4 de mentira para ids que nunca llegan al servidor. */
export function fakeUuid() {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}
