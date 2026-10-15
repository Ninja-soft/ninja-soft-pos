/* eslint-disable */
// Service worker del POS (H65, ADR-087). Sin dependencias.
//
// Lo sirve app/sw.js/route.ts, que reemplaza __SW_VERSION__ por el id del
// build: cada deploy instala una versión nueva y el POS avisa "Hay una
// versión nueva" sin recargar solo (no corta un cobro en curso).
//
// Alcance: se registra con scope "/pos", así que sólo controla las pantallas
// /pos y /pos-offline. Nada del panel interno, /pagar ni webhooks pasa nunca
// por acá.
//
// Qué guarda (Cache Storage):
//   - El shell anónimo /pos-offline (página estática, sin datos del negocio
//     ni del usuario; se baja SIN cookies) y sus archivos de /_next/static.
//   - Archivos estáticos (/_next/static, íconos de /brand, manifest) con
//     stale-while-revalidate.
// Qué NO guarda nunca: el HTML de /pos (es personalizado), respuestas de
// Supabase u otro origen, /api, RSC, nada que lleve Authorization, nada que
// no sea GET, ni respuestas con Cache-Control no-store/private.
//
// Las reglas son funciones puras (classifyRequest, isCacheableResponse,
// extractAssetUrls) que se prueban en tests/unit/pwaServiceWorker.test.ts
// cargando este mismo archivo.

var SW_VERSION = "__SW_VERSION__";
var SHELL_CACHE = "ninja-pos-shell-" + SW_VERSION;
var ASSET_CACHE = "ninja-pos-assets-v1";
var CACHE_PREFIX = "ninja-pos-";
var SHELL_PATH = "/pos-offline";
var MANIFEST_PATH = "/manifest.webmanifest";
var ASSET_LIMIT = 400;
var NAV_TIMEOUT_MS = 8000;

/** Rutas que nunca se tocan, aunque una pantalla controlada las pida. */
var DENY_PREFIXES = [
  "/api/",
  "/internal",
  "/pagar",
  "/auth/",
  "/hooks",
  "/webhooks",
  "/login",
  "/login-internal",
  "/signup",
  "/recover",
  "/reset-password",
  "/onboarding",
  "/c/",
  "/p/",
  "/sw.js",
];

/** Íconos y manifest de la PWA (públicos, sin datos). */
var STATIC_PUBLIC = [MANIFEST_PATH, "/brand/"];

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  var lower = name.toLowerCase();
  for (var k in headers) if (k.toLowerCase() === lower) return headers[k];
  return null;
}

function isPosPath(pathname) {
  return pathname === "/pos" || pathname.indexOf("/pos/") === 0;
}

function isDenied(pathname) {
  for (var i = 0; i < DENY_PREFIXES.length; i++) {
    var p = DENY_PREFIXES[i];
    if (pathname === p || pathname.indexOf(p) === 0) return true;
  }
  return false;
}

/**
 * Qué hacer con un pedido.
 *   "bypass"     red directa, el SW no responde ni guarda nada.
 *   "pos-nav"    navegación a /pos: red primero; sin red, el shell offline (misma URL).
 *   "shell-nav"  navegación a /pos-offline: red primero; sin red, el shell guardado.
 *   "asset"      archivo estático: stale-while-revalidate.
 */
function classifyRequest(req, origin) {
  if (!req || (req.method || "GET").toUpperCase() !== "GET") return "bypass";
  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return "bypass";
  }
  // Otro origen: Supabase (REST, Auth, Storage, Realtime), Mercado Pago, etc.
  if (url.origin !== origin) return "bypass";
  var h = req.headers;
  // Nada con credenciales explícitas ni datos del router (RSC/prefetch).
  if (headerOf(h, "authorization")) return "bypass";
  if (headerOf(h, "rsc") || headerOf(h, "next-router-state-tree") || headerOf(h, "next-router-prefetch")) return "bypass";
  if (url.searchParams.has("_rsc")) return "bypass";
  var path = url.pathname;
  if (isDenied(path)) return "bypass";
  var nav = req.mode === "navigate";
  if (nav && isPosPath(path)) return "pos-nav";
  if (nav && path === SHELL_PATH) return "shell-nav";
  if (nav) return "bypass";
  if (path.indexOf("/_next/static/") === 0) return "asset";
  for (var i = 0; i < STATIC_PUBLIC.length; i++) {
    var p = STATIC_PUBLIC[i];
    if (path === p || (p.charAt(p.length - 1) === "/" && path.indexOf(p) === 0)) return "asset";
  }
  return "bypass";
}

/** Sólo respuestas propias, completas y públicas. */
function isCacheableResponse(res) {
  if (!res || res.status !== 200 || res.type !== "basic" || res.redirected) return false;
  var cc = String(headerOf(res.headers, "cache-control") || "").toLowerCase();
  if (cc.indexOf("no-store") !== -1 || cc.indexOf("private") !== -1) return false;
  var vary = String(headerOf(res.headers, "vary") || "");
  if (vary.trim() === "*") return false;
  return true;
}

/** URLs de /_next/static que aparecen en el HTML del shell (scripts, CSS, chunks del RSC). */
function extractAssetUrls(html) {
  var out = {};
  var text = String(html || "");
  var re = /\/_next\/static\/[A-Za-z0-9_\-./%()[\]@~]+?\.(?:js|css|woff2?|ttf|otf|png|svg|webp|ico)(?![A-Za-z0-9])/g;
  var m;
  while ((m = re.exec(text))) out[m[0]] = true;
  // Chunks del payload RSC: "static/chunks/..." sin el prefijo /_next/.
  var re2 = /(?:^|["'\s,[])(static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./%()[\]@~]+?\.(?:js|css|woff2?))(?![A-Za-z0-9])/g;
  while ((m = re2.exec(text))) out["/_next/" + m[1]] = true;
  return Object.keys(out).map(function (u) {
    try {
      return decodeURI(u).indexOf("..") === -1 ? u : null;
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

/** Fuentes y archivos referenciados desde un CSS (url(...)) dentro de /_next/static. */
function extractCssUrls(css) {
  var out = {};
  var re = /url\(\s*["']?(\/_next\/static\/[^"')\s]+)["']?\s*\)/g;
  var m;
  while ((m = re.exec(String(css || "")))) out[m[1]] = true;
  return Object.keys(out);
}

/** Caches de versiones anteriores que hay que borrar al activar. */
function staleCacheNames(names, current) {
  return names.filter(function (n) {
    return n.indexOf(CACHE_PREFIX + "shell-") === 0 && n !== current;
  });
}

// Expuesto para los tests unitarios (no hay datos acá, sólo funciones puras).
self.__ninjaSw = {
  SW_VERSION: SW_VERSION,
  SHELL_CACHE: SHELL_CACHE,
  ASSET_CACHE: ASSET_CACHE,
  SHELL_PATH: SHELL_PATH,
  classifyRequest: classifyRequest,
  isCacheableResponse: isCacheableResponse,
  extractAssetUrls: extractAssetUrls,
  extractCssUrls: extractCssUrls,
  staleCacheNames: staleCacheNames,
};

// ── Runtime ──────────────────────────────────────────────────────────────────

function fetchNoCreds(path) {
  // Sin cookies: el shell y sus archivos son iguales para todos.
  return fetch(new Request(path, { credentials: "omit", cache: "reload", redirect: "error" }));
}

async function precacheShell() {
  var cache = await caches.open(SHELL_CACHE);
  var shell = await fetchNoCreds(SHELL_PATH);
  if (!isCacheableResponse(shell)) throw new Error("shell_not_cacheable");
  var html = await shell.clone().text();
  var urls = extractAssetUrls(html);
  var extra = [MANIFEST_PATH, "/brand/pwa-192.png", "/brand/pwa-512.png"];
  var cssUrls = [];
  await Promise.all(
    urls.concat(extra).map(async function (u) {
      try {
        var r = await fetchNoCreds(u);
        if (!isCacheableResponse(r)) return;
        if (/\.css(\?|$)/.test(u)) cssUrls = cssUrls.concat(extractCssUrls(await r.clone().text()));
        await cache.put(u, r);
      } catch (e) {
        // Un ícono que falta no invalida el shell; un chunk sí se nota offline.
        if (/\.js(\?|$)/.test(u)) throw e;
      }
    }),
  );
  await Promise.all(
    cssUrls.map(async function (u) {
      try {
        var r = await fetchNoCreds(u);
        if (isCacheableResponse(r)) await cache.put(u, r);
      } catch (e) {
        // Fuente que no bajó: el navegador usa la de respaldo.
      }
    }),
  );
  await cache.put(SHELL_PATH, shell);
}

async function trimAssets() {
  var cache = await caches.open(ASSET_CACHE);
  var keys = await cache.keys();
  var extra = keys.length - ASSET_LIMIT;
  for (var i = 0; i < extra; i++) await cache.delete(keys[i]);
}

function timeout(ms) {
  return new Promise(function (_, reject) {
    setTimeout(function () {
      reject(new Error("timeout"));
    }, ms);
  });
}

async function cachedShell() {
  var cache = await caches.open(SHELL_CACHE);
  return cache.match(SHELL_PATH);
}

function offlineFallback() {
  var body =
    '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Sin conexión</title><body style=\"font-family:system-ui,sans-serif;background:#0a0518;color:#ece9f6;padding:24px\">" +
    "<h1 style=\"font-size:18px\">Sin conexión</h1><p>El POS todavía no está disponible sin conexión en este dispositivo. " +
    "Abrilo una vez con internet para prepararlo.</p></body></html>";
  return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// /pos: la red siempre manda (HTML personalizado, nunca se guarda). Sin red,
// responde con el shell anónimo en la misma URL (una redirección del SW no
// siempre se puede seguir sin red), que arranca con la foto local.
async function handlePosNav(event) {
  try {
    return await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]);
  } catch (e) {
    return (await cachedShell()) || offlineFallback();
  }
}

async function handleShellNav(event) {
  try {
    return await Promise.race([fetch(event.request), timeout(NAV_TIMEOUT_MS)]);
  } catch (e) {
    return (await cachedShell()) || offlineFallback();
  }
}

// Stale-while-revalidate. Los archivos de /_next/static tienen hash en el
// nombre: el contenido de una URL no cambia nunca.
async function handleAsset(event) {
  var req = event.request;
  var cached = await caches.match(req, { ignoreVary: true });
  var network = fetch(req)
    .then(async function (res) {
      if (isCacheableResponse(res)) {
        var cache = await caches.open(ASSET_CACHE);
        await cache.put(req, res.clone());
        await trimAssets();
      }
      return res;
    })
    .catch(function () {
      return null;
    });
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  var res = await network;
  return res || Response.error();
}

self.addEventListener("install", function (event) {
  // Sin skipWaiting: la versión nueva espera a que el cajero acepte recargar.
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        staleCacheNames(names, SHELL_CACHE).map(function (n) {
          return caches.delete(n);
        }),
      );
    }),
  );
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "GET_VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage({ version: SW_VERSION });
});

self.addEventListener("fetch", function (event) {
  var kind = classifyRequest(event.request, self.location.origin);
  if (kind === "bypass") return;
  if (kind === "pos-nav") return event.respondWith(handlePosNav(event));
  if (kind === "shell-nav") return event.respondWith(handleShellNav(event));
  if (kind === "asset") return event.respondWith(handleAsset(event));
});
