// H9b PR4 — Subida de imágenes para el editor canvas de tickets.
// Reutiliza el pipeline client-side de H7 (resizeToWebp) y el bucket público
// `tenant-assets` (mismas policies RLS que el logo de branding), bajo el path
// `${tenantId}/ticket-images/<uuid>.webp`. Devuelve la URL pública.
import { createClient } from "@/lib/supabase/client";
import { resizeToWebp } from "@/lib/utils/image";

const BUCKET = "tenant-assets";

/** Sube una imagen (la convierte a WebP máx. 900px) y devuelve su URL pública. */
export async function uploadTicketImage(file: File, tenantId: string): Promise<string> {
  const supabase = createClient();
  const webp = await resizeToWebp(file, 900, 0.82);
  const path = `${tenantId}/ticket-images/${crypto.randomUUID()}.webp`;
  const up = await supabase.storage
    .from(BUCKET)
    .upload(path, webp, { contentType: "image/webp", upsert: false });
  if (up.error) throw up.error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return pub.publicUrl;
}

/** Sube un Blob WebP ya generado (p. ej. el recorte). Devuelve la URL pública. */
export async function uploadTicketImageBlob(blob: Blob, tenantId: string): Promise<string> {
  const supabase = createClient();
  const path = `${tenantId}/ticket-images/${crypto.randomUUID()}.webp`;
  const up = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: "image/webp", upsert: false });
  if (up.error) throw up.error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return pub.publicUrl;
}
