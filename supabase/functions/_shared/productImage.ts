// =============================================================================
// Copia de la foto de un producto importado de Tiendita al bucket del tenant.
// Lógica PURA compartida por la Edge `tiendita_copy_image` y los tests de
// Vitest (tests/unit/productImage.test.ts). Sin imports: corre en Deno y Node.
//
// Convención de la galería (product_images):
//   - path = "<tenant>/<product>/<uuid>.<ext>" → archivo propio en el bucket
//     público product-images (lo que sube el dueño, en WebP, o copia la
//     Edge, en el formato de origen).
//   - path = ""                                → foto EXTERNA (URL del maestro
//     del catálogo) pendiente de copiar. Se muestra igual; nunca se intenta
//     borrar del bucket.
// =============================================================================

export const PRODUCT_IMAGES_BUCKET = "product-images";
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_IMAGE_WIDTH = 900;

/**
 * Path canónico de una foto propia: tenant/product/uuid.<ext>. Lo que sube
 * el dueño se convierte a WebP en el navegador; la copia de Tiendita
 * conserva el formato de origen (ver tiendita_copy_image), de ahí `ext`.
 */
export function productImagePath(
  tenantId: string,
  productId: string,
  uuid: string,
  ext = "webp",
): string {
  return `${tenantId}/${productId}/${uuid}.${ext}`;
}

const IMAGE_EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** content-type canónico (image/jpg → image/jpeg, sin parámetros). */
export function normalizeImageType(ct: string): string {
  const t = ct.split(";")[0]!.trim().toLowerCase();
  return t === "image/jpg" ? "image/jpeg" : t;
}

/** Extensión de archivo para un content-type de imagen aceptado. */
export function imageExtension(ct: string): string {
  return IMAGE_EXT[normalizeImageType(ct)] ?? "bin";
}

/** true si la fila de la galería apunta a un archivo propio del bucket. */
export function isStoredImagePath(path: string | null | undefined, tenantId?: string): boolean {
  if (!path) return false;
  const parts = path.split("/");
  if (parts.length !== 3 || parts.some((p) => !p)) return false;
  return tenantId ? parts[0] === tenantId : true;
}

/** Foto externa pendiente de copia (path vacío y URL http/https). */
export function isExternalImage(path: string | null | undefined, url: string | null | undefined): boolean {
  return !path && typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/**
 * Valida la URL de origen antes de descargarla (anti SSRF): sólo https, sin
 * credenciales, sin IPs literales ni hosts privados/locales, sin puertos raros.
 */
export function isAllowedSourceUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (!host || PRIVATE_HOST.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // IPv4 literal
  if (host.includes(":")) return false; // IPv6 literal
  if (!host.includes(".")) return false;
  return true;
}

/** content-type aceptado como imagen de origen. */
export function isImageContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  const t = ct.split(";")[0]!.trim().toLowerCase();
  return /^image\/(webp|jpeg|jpg|png|gif|avif)$/.test(t);
}

/** Dimensiones destino sin agrandar (mismo criterio que el cliente). */
export function fitWidth(width: number, height: number, maxWidth = MAX_IMAGE_WIDTH) {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}
