import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderServiceWorker, swVersion } from "@/lib/pwa/version";

// Service worker del POS (H65, ADR-087): se carga el MISMO archivo que se
// sirve en /sw.js y se prueban sus reglas: qué se cachea, qué nunca.

const ORIGIN = "https://pos.soft.ninja";
const SUPABASE = "https://hrkditzrsavehnhngakb.supabase.co";

type Kind = "bypass" | "pos-nav" | "shell-nav" | "asset";
interface SwApi {
  SW_VERSION: string;
  SHELL_CACHE: string;
  classifyRequest(req: unknown, origin: string): Kind;
  isCacheableResponse(res: unknown): boolean;
  extractAssetUrls(html: string): string[];
  extractCssUrls(css: string): string[];
  staleCacheNames(names: string[], current: string): string[];
}

function loadSw(version = "test123") {
  const source = readFileSync(join(process.cwd(), "lib/pwa/sw.worker.js"), "utf8");
  const listeners: Record<string, (e: unknown) => void> = {};
  const self: Record<string, unknown> = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(),
  };
  const ctx = vm.createContext({ self, URL, Response, Request, Promise, setTimeout, console });
  vm.runInContext(renderServiceWorker(source, version), ctx);
  return { api: self.__ninjaSw as SwApi, listeners, self };
}

const { api, listeners, self } = loadSw();

function req(path: string, o: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {}) {
  return {
    url: (o.origin ?? ORIGIN) + path,
    method: o.method ?? "GET",
    mode: o.mode ?? "no-cors",
    headers: new Headers(o.headers ?? {}),
  };
}
const nav = (path: string, headers?: Record<string, string>) => req(path, { mode: "navigate", headers });

describe("sw: versión", () => {
  it("inserta la versión del deploy y arma el nombre del cache", () => {
    expect(api.SW_VERSION).toBe("test123");
    expect(api.SHELL_CACHE).toBe("ninja-pos-shell-test123");
  });
  it("sanea la versión (va dentro de un string de JS)", () => {
    expect(swVersion({ VERCEL_GIT_COMMIT_SHA: 'abc"; alert(1); "' }, "x")).toBe("abcalert1");
    expect(swVersion({ VERCEL_DEPLOYMENT_ID: "dpl_123", VERCEL_GIT_COMMIT_SHA: "sha" }, "x")).toBe("dpl_123");
    expect(swVersion({}, "lz9abc")).toBe("lz9abc");
    expect(swVersion({}, "!!!")).toBe("dev");
  });
});

describe("sw: estrategia por ruta", () => {
  it("/pos (navegación) va red primero con respaldo al shell", () => {
    expect(api.classifyRequest(nav("/pos"), ORIGIN)).toBe("pos-nav");
    expect(api.classifyRequest(nav("/pos?tab=1"), ORIGIN)).toBe("pos-nav");
    expect(api.classifyRequest(nav("/pos/algo"), ORIGIN)).toBe("pos-nav");
  });
  it("/pos-offline (navegación) es el shell", () => {
    expect(api.classifyRequest(nav("/pos-offline"), ORIGIN)).toBe("shell-nav");
    expect(api.classifyRequest(nav("/pos-offline?from=pos"), ORIGIN)).toBe("shell-nav");
  });
  it("archivos estáticos con stale-while-revalidate", () => {
    expect(api.classifyRequest(req("/_next/static/chunks/main-app-abc.js"), ORIGIN)).toBe("asset");
    expect(api.classifyRequest(req("/_next/static/css/app.css"), ORIGIN)).toBe("asset");
    expect(api.classifyRequest(req("/_next/static/media/inter.woff2"), ORIGIN)).toBe("asset");
    expect(api.classifyRequest(req("/brand/pwa-192.png"), ORIGIN)).toBe("asset");
    expect(api.classifyRequest(req("/manifest.webmanifest"), ORIGIN)).toBe("asset");
  });
  it("otras navegaciones no se tocan", () => {
    for (const p of ["/dashboard", "/ventas", "/caja", "/possible", "/"]) {
      expect(api.classifyRequest(nav(p), ORIGIN), p).toBe("bypass");
    }
  });
});

describe("sw: exclusiones (nunca se cachea)", () => {
  it("Supabase y cualquier otro origen", () => {
    expect(api.classifyRequest(req("/rest/v1/products?select=*", { origin: SUPABASE }), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(req("/auth/v1/token", { origin: SUPABASE }), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(req("/storage/v1/object/public/x.png", { origin: SUPABASE }), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(req("/checkout", { origin: "https://www.mercadopago.com.ar" }), ORIGIN)).toBe("bypass");
  });
  it("métodos que no son GET", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(api.classifyRequest(req("/_next/static/chunks/a.js", { method: m }), ORIGIN)).toBe("bypass");
      expect(api.classifyRequest({ ...nav("/pos"), method: m }, ORIGIN)).toBe("bypass");
    }
  });
  it("pedidos con Authorization", () => {
    expect(api.classifyRequest(req("/_next/static/chunks/a.js", { headers: { Authorization: "Bearer x" } }), ORIGIN)).toBe(
      "bypass",
    );
    expect(api.classifyRequest(nav("/pos", { authorization: "Bearer x" }), ORIGIN)).toBe("bypass");
  });
  it("datos del router de Next (RSC y prefetch)", () => {
    expect(api.classifyRequest(req("/pos", { headers: { RSC: "1" } }), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(req("/pos?_rsc=abc"), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(req("/pos", { headers: { "Next-Router-Prefetch": "1" } }), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(nav("/pos-offline", { "Next-Router-State-Tree": "x" }), ORIGIN)).toBe("bypass");
  });
  it("API, panel interno, /pagar, auth y webhooks", () => {
    for (const p of [
      "/api/health",
      "/api/mp/webhook",
      "/api/libro-iva",
      "/internal",
      "/internal/tenants",
      "/pagar/abc",
      "/auth/callback",
      "/auth/impersonate",
      "/hooks/mp",
      "/webhooks/getnet",
      "/login",
      "/c/mi-tienda",
      "/p/mi-tienda/AAAAAAAAAAAAAAAAAAAAAA",
      "/sw.js",
    ]) {
      expect(api.classifyRequest(nav(p), ORIGIN), p).toBe("bypass");
      expect(api.classifyRequest(req(p), ORIGIN), p).toBe("bypass");
    }
  });
  it("imágenes optimizadas (pueden ser fotos de productos) y URLs inválidas", () => {
    expect(api.classifyRequest(req("/_next/image?url=%2Fx.png&w=64"), ORIGIN)).toBe("bypass");
    expect(api.classifyRequest({ url: "no es url", method: "GET", headers: new Headers() }, ORIGIN)).toBe("bypass");
    expect(api.classifyRequest(null, ORIGIN)).toBe("bypass");
  });
});

describe("sw: respuestas que se pueden guardar", () => {
  const res = (o: { status?: number; type?: string; redirected?: boolean; headers?: Record<string, string> } = {}) => ({
    status: o.status ?? 200,
    type: o.type ?? "basic",
    redirected: o.redirected ?? false,
    headers: new Headers(o.headers ?? {}),
  });
  it("200 propia y pública", () => {
    expect(api.isCacheableResponse(res({ headers: { "Cache-Control": "public, max-age=31536000, immutable" } }))).toBe(true);
  });
  it("no: opaca, de error, parcial, redirigida, no-store, private o Vary *", () => {
    expect(api.isCacheableResponse(res({ type: "opaque" }))).toBe(false);
    expect(api.isCacheableResponse(res({ type: "cors" }))).toBe(false);
    expect(api.isCacheableResponse(res({ status: 404 }))).toBe(false);
    expect(api.isCacheableResponse(res({ status: 206 }))).toBe(false);
    expect(api.isCacheableResponse(res({ status: 302 }))).toBe(false);
    expect(api.isCacheableResponse(res({ redirected: true }))).toBe(false);
    expect(api.isCacheableResponse(res({ headers: { "Cache-Control": "no-store" } }))).toBe(false);
    expect(api.isCacheableResponse(res({ headers: { "Cache-Control": "private, no-cache" } }))).toBe(false);
    expect(api.isCacheableResponse(res({ headers: { Vary: "*" } }))).toBe(false);
    expect(api.isCacheableResponse(null)).toBe(false);
  });
});

describe("sw: precache del shell", () => {
  it("toma scripts, CSS y chunks del payload RSC", () => {
    const html = `<!doctype html><link rel="stylesheet" href="/_next/static/css/a1b2.css" data-precedence="next">
      <script src="/_next/static/chunks/webpack-1.js" async></script>
      <script src="/_next/static/chunks/app/pos-offline/page-9f.js" async></script>
      <link rel="preload" href="/_next/static/media/e4af-s.p.woff2" as="font">
      <script>self.__next_f.push([1,"3:I[123,[\\"static/chunks/117-abc.js\\",\\"static/chunks/app/layout-x.js\\"],\\"Providers\\"]"])</script>
      <a href="/dashboard">x</a><img src="https://cdn.example.com/_next/static/x.js">`;
    const urls = api.extractAssetUrls(html).sort();
    expect(urls).toEqual(
      [
        "/_next/static/chunks/117-abc.js",
        "/_next/static/chunks/app/layout-x.js",
        "/_next/static/chunks/app/pos-offline/page-9f.js",
        "/_next/static/chunks/webpack-1.js",
        "/_next/static/css/a1b2.css",
        "/_next/static/media/e4af-s.p.woff2",
        "/_next/static/x.js",
      ].sort(),
    );
    // Siempre rutas propias de /_next/static: nunca se baja una URL de otro dominio.
    expect(urls.every((u) => u.startsWith("/_next/static/"))).toBe(true);
  });
  it("no acepta rutas con ..", () => {
    expect(api.extractAssetUrls('<script src="/_next/static/../../api/x.js"></script>')).toEqual([]);
  });
  it("fuentes referenciadas desde el CSS", () => {
    const css = `@font-face{src:url(/_next/static/media/a.woff2) format("woff2")}@font-face{src:url("/_next/static/media/b.woff")}
      .x{background:url(https://otro.com/y.png)}`;
    expect(api.extractCssUrls(css).sort()).toEqual(["/_next/static/media/a.woff2", "/_next/static/media/b.woff"]);
  });
  it("al activar borra sólo shells de versiones anteriores", () => {
    expect(
      api.staleCacheNames(
        ["ninja-pos-shell-old", "ninja-pos-shell-test123", "ninja-pos-assets-v1", "otra-app"],
        "ninja-pos-shell-test123",
      ),
    ).toEqual(["ninja-pos-shell-old"]);
  });
});

describe("sw: eventos", () => {
  it("no responde los pedidos excluidos (red directa)", () => {
    const respondWith = vi.fn();
    listeners.fetch?.({ request: req("/rest/v1/sales", { origin: SUPABASE }), respondWith });
    listeners.fetch?.({ request: nav("/internal/tenants"), respondWith });
    listeners.fetch?.({ request: req("/api/health"), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
  it("sólo se activa cuando el cajero lo pide", () => {
    listeners.message?.({ data: { type: "OTRA_COSA" } });
    expect(self.skipWaiting).not.toHaveBeenCalled();
    listeners.message?.({ data: { type: "SKIP_WAITING" } });
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
