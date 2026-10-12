// =============================================================================
// Edge Function: tiendita_copy_image — copia la foto de un producto importado
// desde Tiendita al bucket product-images del TENANT, como WebP.
//
// Contexto (bug "al importar no lleva la foto / la borra"): el import dejaba la
// URL del maestro del catálogo como products.image_url (hotlink) y sin fila en
// product_images. Ahora el RPC import_catalog_product crea la fila con
// path '' (externa) y esta función la reemplaza por una copia propia:
//   <tenant>/<product>/<uuid>.webp  → product_images.path/url + products.image_url
//
// Seguridad:
//   • verify_jwt = true. El tenant sale SIEMPRE del JWT (current_tenant_id).
//   • La URL de origen NO se toma del body ni de product_images (el tenant puede
//     escribir esa tabla): se lee de catalog_products vía
//     products.metadata.catalog_product_id (maestro administrado por NinjaSoft)
//     y se valida (https, sin hosts privados) antes de descargar (anti SSRF).
//   • Descarga con timeout y tope de tamaño; sólo content-type de imagen.
//
// Degradación: si algo falla (origen caído, formato no soportado, sin encoder
// WebP), responde { ok: false, reason } con 200 y la foto externa QUEDA: el
// producto nunca se queda sin foto por culpa de la copia.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import {
  PRODUCT_IMAGES_BUCKET,
  MAX_SOURCE_BYTES,
  fitWidth,
  isAllowedSourceUrl,
  isExternalImage,
  isImageContentType,
  productImagePath,
} from "../_shared/productImage.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const soft = (reason: string, detail?: unknown) => {
  console.warn(`[tiendita_copy_image] ${reason}`, detail ?? "");
  return json({ ok: false, reason });
};

async function download(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    // Tras redirects, el destino final también tiene que ser válido.
    if (res.url && !isAllowedSourceUrl(res.url)) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!isImageContentType(type)) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_SOURCE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_SOURCE_BYTES) return null;
    return { bytes: buf, type: type.split(";")[0]!.trim().toLowerCase() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Convierte a WebP (máx 900px de ancho). Si el origen ya es WebP chico, se
// usa tal cual. Devuelve null si no se puede producir WebP.
async function toWebp(src: { bytes: Uint8Array; type: string }): Promise<Uint8Array | null> {
  try {
    const img = await Image.decode(src.bytes);
    const { width, height } = fitWidth(img.width, img.height);
    if (src.type === "image/webp" && width === img.width) return src.bytes;
    if (width !== img.width) img.resize(width, height);
    // deno-lint-ignore no-explicit-any
    const enc = (img as any).encodeWEBP;
    if (typeof enc !== "function") return src.type === "image/webp" ? src.bytes : null;
    const out = await enc.call(img, 82);
    return out instanceof Uint8Array && out.byteLength > 0 ? out : null;
  } catch (e) {
    console.warn("[tiendita_copy_image] decode/encode", String(e));
    return src.type === "image/webp" ? src.bytes : null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const tenantId = String(
    (user.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id ?? "",
  );
  if (!tenantId) return json({ error: "no_tenant" }, 400);

  let productId = "";
  try {
    productId = String(((await req.json()) as { product_id?: string }).product_id ?? "").trim();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return json({ error: "invalid_product" }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Producto del tenant del JWT (nunca de otro).
  const { data: product } = await admin
    .from("products")
    .select("id, tenant_id, image_url, metadata")
    .eq("id", productId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!product) return json({ error: "product_not_found" }, 404);

  const meta = (product.metadata ?? {}) as { source?: string; catalog_product_id?: number };
  if (meta.source !== "tiendita" || !meta.catalog_product_id) return soft("not_from_catalog");

  // Fila externa pendiente en la galería.
  const { data: rows } = await admin
    .from("product_images")
    .select("id, path, url, is_primary")
    .eq("product_id", productId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  const pending = (rows ?? []).find((r) => isExternalImage(r.path, r.url));
  if (!pending) return json({ ok: true, skipped: "nothing_pending" });

  // Origen confiable: el maestro del catálogo, no lo que diga la fila.
  const { data: cp } = await admin
    .from("catalog_products")
    .select("foto_url")
    .eq("id", meta.catalog_product_id)
    .maybeSingle();
  const source = (cp?.foto_url ?? "").trim();
  if (!source || source !== pending.url.trim()) return soft("source_mismatch");
  if (!isAllowedSourceUrl(source)) return soft("source_not_allowed", source);

  const downloaded = await download(source);
  if (!downloaded) return soft("download_failed", source);
  const webp = await toWebp(downloaded);
  if (!webp) return soft("webp_unavailable", downloaded.type);

  const path = productImagePath(tenantId, productId, crypto.randomUUID());
  const up = await admin.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, webp, { contentType: "image/webp", upsert: false });
  if (up.error) return soft("upload_failed", up.error.message);
  const publicUrl = admin.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;

  const { error: updErr } = await admin
    .from("product_images")
    .update({ path, url: publicUrl })
    .eq("id", pending.id)
    .eq("tenant_id", tenantId);
  if (updErr) {
    await admin.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
    return soft("row_update_failed", updErr.message);
  }
  // La principal apunta a la copia (sólo si seguía apuntando a la externa).
  if (pending.is_primary || product.image_url === pending.url) {
    await admin
      .from("products")
      .update({ image_url: publicUrl })
      .eq("id", productId)
      .eq("tenant_id", tenantId);
  }

  return json({ ok: true, path, url: publicUrl });
});
