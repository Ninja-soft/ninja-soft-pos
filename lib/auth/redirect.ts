// Caracteres de control, espacios (incluidos los Unicode) y barra invertida:
// el navegador descarta tabs/saltos de línea y trata `\` como `/`, así que
// `/%09/evil.com` o `/\evil.com` terminan en otro origen.
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\s\\]/;
const PROBE_ORIGIN = "http://x";

function isSafeRelativePath(p: string): boolean {
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return false;
  if (UNSAFE_PATH_CHARS.test(p)) return false;
  try {
    return new URL(p, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

// Redirecciones de auth: sólo rutas internas (evita open redirect). Se valida
// el valor tal cual y decodificado (hasta 3 veces, por doble codificación).
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  let decoded = next;
  for (let i = 0; i < 3; i++) {
    let d: string;
    try {
      d = decodeURIComponent(decoded);
    } catch {
      return fallback;
    }
    if (d === decoded) break;
    decoded = d;
    if (!isSafeRelativePath(decoded)) return fallback;
  }
  return isSafeRelativePath(next) && isSafeRelativePath(decoded) ? next : fallback;
}

// Destino de vuelta del OAuth (Google): el callback canjea el código del lado
// servidor y recién ahí redirige a `next`.
export function callbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

// Destino al entrar según el rol: staff sin negocio propio → panel interno;
// usuario sin negocio → el registro, que retoma el alta guardada (rubro, plan,
// IA y código) sin volver a pedir nada; Repartidor (ADR-161) → su app de
// reparto; el resto → panel.
export function homePath({ isInternal, hasTenant, isDriver = false }: { isInternal: boolean; hasTenant: boolean; isDriver?: boolean }): string {
  if (hasTenant) return isDriver ? "/reparto" : "/dashboard";
  return isInternal ? "/internal/tenants" : "/signup";
}
