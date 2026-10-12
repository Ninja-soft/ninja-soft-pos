// Fotos de producto (galería product_images + bucket público product-images).
// Conversión a WebP client-side (sharp no corre en Edge). Path canónico
// tenant/product/uuid.webp, el mismo que usa la Edge tiendita_copy_image.
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";
import {
  PRODUCT_IMAGES_BUCKET,
  isStoredImagePath,
  productImagePath,
} from "@/supabase/functions/_shared/productImage";

export interface ProductImageRow {
  id: string;
  path: string;
  url: string;
  is_primary: boolean;
}

/** Sube una foto (como WebP) y la registra en la galería. */
export async function uploadProductImage(opts: {
  tenantId: string;
  productId: string;
  file: File;
  primary: boolean;
  sort: number;
}): Promise<ProductImageRow> {
  const supabase = createClient();
  const webp = await resizeToWebp(opts.file, 900, 0.82);
  const path = productImagePath(opts.tenantId, opts.productId, crypto.randomUUID());
  const up = await supabase.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, webp, { contentType: "image/webp", upsert: false });
  if (up.error) throw up.error;
  const { data: pub } = supabase.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path);
  const { data, error } = await supabase
    .from("product_images")
    .insert({
      tenant_id: opts.tenantId,
      product_id: opts.productId,
      path,
      url: pub.publicUrl,
      is_primary: opts.primary,
      sort: opts.sort,
    })
    .select("id, path, url, is_primary")
    .single();
  if (error) throw error;
  if (opts.primary) {
    await supabase.from("products").update({ image_url: pub.publicUrl }).eq("id", opts.productId);
  }
  return data as ProductImageRow;
}

/**
 * Borra una foto de la galería. Sólo intenta borrar del bucket si es un
 * archivo propio (las externas de Tiendita tienen path vacío).
 */
export async function removeStoredFile(path: string): Promise<void> {
  if (!isStoredImagePath(path)) return;
  await createClient().storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
}
