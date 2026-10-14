// =============================================================================
// Edge Function: tiendita_copy_image — copia la foto de un producto importado
// desde Tiendita al bucket product-images del TENANT.
//
// Contexto (bug "al importar no lleva la foto / la borra"): el import dejaba la
// URL del maestro del catálogo como products.image_url (hotlink) y sin fila en
// product_images. Ahora el RPC import_catalog_product crea la fila con
// path '' (externa) y esta función la reemplaza por una copia propia:
//   <tenant>/<product>/<uuid>.<ext>  → product_images.path/url + products.image_url
//
// Formato: se CONSERVA el de origen con su content-type y extensión. imagescript
// (deno.land/x 1.3.0 y 1.4.0) no trae encoder WebP en Deno (sólo PNG/JPEG; el
// encodeWEBP del paquete npm usa un binario nativo de Node que no corre en
// Edge), así que no se convierte. JPEG/PNG más anchos que 900px se achican y
// se re-codifican en su mismo formato; WebP/GIF/AVIF se copian tal cual.
//
// Seguridad:
//   • verify_jwt = true. El tenant sale SIEMPRE del JWT (current_tenant_id).
//   • La URL de origen NO se toma del body ni de product_images (el tenant puede
//     escribir esa tabla): tiene que ser una foto del producto maestro
//     (catalog_items.foto_url / fotos, ADR-109) al que apunta
//     products.metadata.catalog_product_id (la oferta), administrado por
//     NinjaSoft, y se valida (https, sin hosts privados) antes de descargar
//     (anti SSRF). Se copian todas las fotos pendientes del producto (hasta 3).
//   • Descarga con timeout y tope de tamaño; sólo content-type de imagen.
//
// Degradación: si algo falla (origen caído, subida rechazada), responde
// { ok: false, reason } con 200 y la foto externa QUEDA: el producto nunca se
// queda sin foto por culpa de la copia.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import {
  PRODUCT_IMAGES_BUCKET,
  MAX_SOURCE_BYTES,
  fitWidth,
  imageExtension,
  isAllowedSourceUrl,
  isExternalImage,
  isImageContentType,
  normalizeImageType,
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
    return { bytes: buf, type: normalizeImageType(type) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Achica JPEG/PNG a 900px de ancho como máximo, en su mismo formato. El resto
// (o si el decode falla) se copia tal cual: mejor la foto original que ninguna.
async function prepare(src: { bytes: Uint8Array; type: string }): Promise<Uint8Array> {
  if (src.type !== "image/jpeg" && src.type !== "image/png") return src.bytes;
  try {
    const img = await Image.decode(src.bytes);
    const { width, height } = fitWidth(img.width, img.height);
    if (width === img.width) return src.bytes;
    img.resize(width, height);
    const out = src.type === "image/png" ? await img.encode(1) : await img.encodeJPEG(82);
    return out.byteLength > 0 ? out : src.bytes;
  } catch (e) {
    console.warn("[tiendita_copy_image] resize", String(e));
    return src.bytes;
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

  // Filas externas pendientes en la galería.
  const { data: rows } = await admin
    .from("product_images")
    .select("id, path, url, is_primary")
    .eq("product_id", productId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  const pendingRows = (rows ?? []).filter((r) => isExternalImage(r.path, r.url)).slice(0, 3);
  if (!pendingRows.length) return json({ ok: true, skipped: "nothing_pending" });

  // Origen confiable: las fotos del producto maestro, no lo que diga la fila.
  const { data: offer } = await admin
    .from("catalog_offers")
    .select("item_id")
    .eq("id", meta.catalog_product_id)
    .maybeSingle();
  const { data: item } = offer
    ? await admin.from("catalog_items").select("foto_url, fotos").eq("id", offer.item_id).maybeSingle()
    : { data: null };
  const allowed = new Set(
    [item?.foto_url, ...(Array.isArray(item?.fotos) ? (item?.fotos as unknown[]) : [])]
      .map((u) => String(u ?? "").trim())
      .filter(Boolean),
  );

  const copied: { path: string; url: string }[] = [];
  let firstFailure: Response | null = null;
  let imageUrl = product.image_url;
  for (const pending of pendingRows) {
    const source = pending.url.trim();
    if (!allowed.has(source)) {
      firstFailure ??= soft("source_mismatch");
      continue;
    }
    if (!isAllowedSourceUrl(source)) {
      firstFailure ??= soft("source_not_allowed", source);
      continue;
    }
    const downloaded = await download(source);
    if (!downloaded) {
      firstFailure ??= soft("download_failed", source);
      continue;
    }
    const bytes = await prepare(downloaded);
    const path = productImagePath(tenantId, productId, crypto.randomUUID(), imageExtension(downloaded.type));
    const up = await admin.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(path, bytes, { contentType: downloaded.type, upsert: false });
    if (up.error) {
      firstFailure ??= soft("upload_failed", up.error.message);
      continue;
    }
    const publicUrl = admin.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
    const { error: updErr } = await admin
      .from("product_images")
      .update({ path, url: publicUrl })
      .eq("id", pending.id)
      .eq("tenant_id", tenantId);
    if (updErr) {
      await admin.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
      firstFailure ??= soft("row_update_failed", updErr.message);
      continue;
    }
    // La principal apunta a la copia (sólo si seguía apuntando a la externa).
    if (pending.is_primary || imageUrl === pending.url) {
      await admin
        .from("products")
        .update({ image_url: publicUrl })
        .eq("id", productId)
        .eq("tenant_id", tenantId);
      imageUrl = publicUrl;
    }
    copied.push({ path, url: publicUrl });
  }

  if (!copied.length && firstFailure) return firstFailure;
  const first = copied[0];
  return json({ ok: true, path: first?.path, url: first?.url, copied: copied.length });
});
