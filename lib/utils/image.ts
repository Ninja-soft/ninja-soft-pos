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
