// Imágenes del producto en la API pública (ADR-168). La base guarda la URL
// pública; las subidas viejas pueden tener sólo el path del bucket público
// product-images: acá se completa la URL para que el cliente siempre reciba
// una dirección que abre.

const BUCKET = "product-images";

type Image = { url?: string | null; path?: string | null };

export function publicImageUrl(path: string, base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string | null {
  const root = base.replace(/\/+$/, "");
  if (!root || !path) return null;
  const clean = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `${root}/storage/v1/object/public/${BUCKET}/${clean}`;
}

/** Completa url desde path en cada imagen de cada producto (no toca lo demás). */
export function withImageUrls(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    const r = row as { images?: unknown };
    if (!r || !Array.isArray(r.images)) return row;
    return {
      ...(row as object),
      images: (r.images as Image[]).map((img) =>
        img && !img.url && img.path ? { ...img, url: publicImageUrl(img.path) } : img,
      ),
    };
  });
}
