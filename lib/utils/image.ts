// Conversión/redimensión de imágenes a WebP en el navegador (H7).
// sharp no corre en Supabase Edge (Deno), así que optimizamos client-side.

/** Calcula el tamaño destino respetando aspect ratio, sin agrandar. */
export function computeDimensions(
  width: number,
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  const ratio = maxWidth / width;
  return { width: maxWidth, height: Math.round(height * ratio) };
}

/** Lee un File de imagen, lo redimensiona y devuelve un Blob WebP. */
export async function resizeToWebp(
  file: File,
  maxWidth = 900,
  quality = 0.82,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = computeDimensions(
    bitmap.width,
    bitmap.height,
    maxWidth,
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo crear el canvas");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", quality),
  );
  if (!blob) throw new Error("No se pudo convertir a WebP");
  return blob;
}

/** Área de recorte en píxeles de la imagen original (formato react-easy-crop). */
export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Recorta una región de la imagen y la exporta como WebP cuadrado de `size`px.
 * Pensado para avatares: se usa junto con el recorte de react-easy-crop.
 */
export async function cropToWebp(
  src: Blob | string,
  crop: PixelCrop,
  size = 256,
  quality = 0.85,
): Promise<Blob> {
  const bitmap =
    typeof src === "string"
      ? await loadBitmapFromUrl(src)
      : await createImageBitmap(src);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo crear el canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    bitmap,
    Math.max(0, Math.round(crop.x)),
    Math.max(0, Math.round(crop.y)),
    Math.round(crop.width),
    Math.round(crop.height),
    0,
    0,
    size,
    size,
  );
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", quality),
  );
  if (!blob) throw new Error("No se pudo convertir a WebP");
  return blob;
}

async function loadBitmapFromUrl(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}
