// Negocio recordado en este dispositivo (pedido del dueño, 2026-10): si ya
// entraste antes y tu negocio tiene logo, el login (/login) lo muestra en el
// panel de marca en lugar del collage del producto.
//
// Qué se guarda (localStorage, clave LAST_BUSINESS_KEY): SÓLO lo que el propio
// usuario ya ve en la app: el nombre del negocio y la URL pública del logo.
// Nada de ids internos, emails, roles ni datos de otros negocios.
//
// Por qué la URL y no la imagen: el logo vive en el bucket `tenant-assets`, que
// es PÚBLICO (ver supabase/migrations/20260531002000_tenant_branding.sql) y
// devuelve una URL estable (getPublicUrl, sin firma ni vencimiento). Guardar la
// URL evita ocupar localStorage con una data URL y, si el dueño cambia el logo,
// la próxima sesión autenticada la reemplaza. Si la imagen falla al cargar, el
// login vuelve al panel normal.
//
// Ciclo de vida: lo escribe RememberBusiness (montado en el AppShell, corre en
// toda sesión autenticada). Si el negocio no tiene logo, se borra. "Cerrar
// sesión" NO lo borra (la idea es verlo al volver al login); el link "¿No es tu
// negocio? Usar otra cuenta" del login sí.

export const LAST_BUSINESS_KEY = "ninja:last-business";
/** Evento propio para avisar cambios en la misma pestaña (storage sólo avisa a otras). */
export const LAST_BUSINESS_EVENT = "ninja:last-business-change";

const MAX_NAME = 80;
const MAX_URL = 2048;

export interface RememberedBusiness {
  name: string;
  logoUrl: string;
  updatedAt: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Sólo URLs http(s) o imágenes embebidas: nada de javascript:, blob:, etc. */
export function isSafeLogoUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (!u || u.length > MAX_URL) return false;
  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(u)) return true;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) return null;
  return n.length > MAX_NAME ? n.slice(0, MAX_NAME).trim() : n;
}

/** Lee y valida el valor crudo. Datos corruptos o incompletos → null. */
export function parseRememberedBusiness(raw: string | null | undefined): RememberedBusiness | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const name = cleanName(obj.name);
  if (!name || !isSafeLogoUrl(obj.logoUrl)) return null;
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
  return { name, logoUrl: (obj.logoUrl as string).trim(), updatedAt };
}

function storage(s?: StorageLike | null): StorageLike | null {
  if (s) return s;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // modo privado / storage bloqueado
  }
}

function notify() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(LAST_BUSINESS_EVENT));
  } catch {
    /* sin window: nada que avisar */
  }
}

export function readRememberedBusiness(s?: StorageLike | null): RememberedBusiness | null {
  try {
    return parseRememberedBusiness(storage(s)?.getItem(LAST_BUSINESS_KEY));
  } catch {
    return null;
  }
}

export function clearRememberedBusiness(s?: StorageLike | null): void {
  try {
    const st = storage(s);
    if (!st || st.getItem(LAST_BUSINESS_KEY) === null) return;
    st.removeItem(LAST_BUSINESS_KEY);
    notify();
  } catch {
    /* storage bloqueado: no hay nada que borrar */
  }
}

/**
 * Sincroniza con el negocio activo: con nombre y logo válidos lo guarda (sólo
 * si cambió); sin logo (o datos inválidos) borra la entrada.
 */
export function syncRememberedBusiness(
  business: { name: string | null | undefined; logoUrl: string | null | undefined },
  s?: StorageLike | null,
  now: () => Date = () => new Date(),
): RememberedBusiness | null {
  const name = cleanName(business.name);
  const logoUrl = typeof business.logoUrl === "string" ? business.logoUrl.trim() : "";
  if (!name || !isSafeLogoUrl(logoUrl)) {
    clearRememberedBusiness(s);
    return null;
  }
  try {
    const st = storage(s);
    if (!st) return null;
    const prev = parseRememberedBusiness(st.getItem(LAST_BUSINESS_KEY));
    if (prev && prev.name === name && prev.logoUrl === logoUrl) return prev;
    const next: RememberedBusiness = { name, logoUrl, updatedAt: now().toISOString() };
    st.setItem(LAST_BUSINESS_KEY, JSON.stringify(next));
    notify();
    return next;
  } catch {
    return null; // cuota llena / storage bloqueado: no es crítico
  }
}
