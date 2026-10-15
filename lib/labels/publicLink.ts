// Link público de la ficha de producto (ADR-148): /p/<slug>/<código>.
// El código es el UUID del producto en base64url (22 caracteres en vez de
// 36): el QR queda más chico y legible en etiquetas de 30 mm. Es reversible
// sin tabla nueva; el servidor igual valida que el producto sea del negocio
// del slug, que esté activo y que el plan incluya la ficha.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function uuidToShort(uuid: string): string {
  if (!UUID.test(uuid)) throw new Error("uuid_invalid");
  const hex = uuid.replace(/-/g, "").toLowerCase();
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64[b2 & 63];
  }
  return out; // 16 bytes → 22 caracteres, sin relleno
}

export function shortToUuid(code: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return null;
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const ch of code) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  if (bytes.length !== 16) return null;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  // Rechaza códigos con bits sobrantes distintos de cero (no canónicos).
  return uuidToShort(uuid) === code ? uuid : null;
}

/** URL pública de la ficha. `origin` sin barra final. */
export function productPublicUrl(origin: string, slug: string, productId: string): string {
  return `${origin.replace(/\/+$/, "")}/p/${encodeURIComponent(slug)}/${uuidToShort(productId)}`;
}
