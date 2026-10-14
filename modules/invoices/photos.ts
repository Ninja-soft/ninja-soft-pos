"use client";

// Fotos de producto para el comprobante (ADR-119). Se leen sólo si el negocio
// las muestra (opción "Mostrar foto del producto", modelo Catálogo o fotos en
// el ticket) y se PRECARGAN como data URL: recortadas al cuadrado y chicas
// (160 px) en color para la hoja A4 y en monocromo para la térmica. Así salen
// iguales en la vista previa, la impresión y el PDF del email (html2canvas no
// espera imágenes remotas ni respeta filtros CSS).
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface ProductPhoto {
  color: string;
  mono: string;
}

const SIZE = 160;

async function loadImage(url: string): Promise<HTMLImageElement> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("photo_fetch");
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  }
}

/** Recorte cuadrado centrado a SIZE px, en color y en escala de grises. */
export async function photoVariants(url: string): Promise<ProductPhoto> {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SIZE, SIZE);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  const color = c.toDataURL("image/jpeg", 0.85);
  const px = ctx.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < px.data.length; i += 4) {
    const y =
      0.299 * px.data[i]! + 0.587 * px.data[i + 1]! + 0.114 * px.data[i + 2]!;
    px.data[i] = px.data[i + 1] = px.data[i + 2] = y;
  }
  ctx.putImageData(px, 0, 0);
  return { color, mono: c.toDataURL("image/jpeg", 0.85) };
}

/** Fotos precargadas por id de producto (sólo con la opción prendida). */
export function useProductPhotos(
  productIds: (string | null | undefined)[],
  enabled: boolean,
) {
  const ids = Array.from(
    new Set(productIds.filter((x): x is string => Boolean(x))),
  ).sort();
  return useQuery({
    queryKey: ["invoice-product-photos", ids],
    enabled: enabled && ids.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Record<string, ProductPhoto>> => {
      const { data } = await createClient()
        .from("products")
        .select("id, image_url")
        .in("id", ids);
      const out: Record<string, ProductPhoto> = {};
      await Promise.all(
        (data ?? []).map(async (p) => {
          if (!p.image_url) return;
          try {
            out[p.id] = await photoVariants(p.image_url);
          } catch {
            // Sin acceso a la foto: el renglón muestra el placeholder.
          }
        }),
      );
      return out;
    },
  });
}

/** Agrega las fotos precargadas a los ítems del comprobante. */
export function withPhotos<T extends { product_id?: string | null }>(
  items: T[],
  photos: Record<string, ProductPhoto> | undefined,
) {
  if (!photos) return items;
  return items.map((it) => {
    const p = it.product_id ? photos[it.product_id] : undefined;
    return p ? { ...it, image_url: p.color, image_mono: p.mono } : it;
  });
}
