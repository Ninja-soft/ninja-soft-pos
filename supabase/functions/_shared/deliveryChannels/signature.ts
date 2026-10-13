// =============================================================================
// _shared/deliveryChannels/signature.ts (ADR-102)
//
// Firma HMAC-SHA256 de webhooks con el formato que documenta Rappi
// (`t=<unix>,sign=<hex>` sobre `<t>.<cuerpo crudo>`), que también usa el
// simulador. Comparación en tiempo constante y ventana de tolerancia contra
// repeticiones. WebCrypto: corre igual en Deno (Edge) y en Node (tests).
// =============================================================================

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface SignatureParts {
  t: number;
  sign: string;
}

/** Lee `t=...,sign=...` (en cualquier orden, con o sin espacios). */
export function parseSignatureHeader(header: string | null | undefined): SignatureParts | null {
  if (!header) return null;
  let t: number | null = null;
  let sign: string | null = null;
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("=");
    const key = (k ?? "").trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "t" && /^\d{1,13}$/.test(value)) t = Number(value);
    if (key === "sign" && /^[0-9a-f]{64}$/i.test(value)) sign = value.toLowerCase();
  }
  return t !== null && sign !== null ? { t, sign } : null;
}

export async function buildSignatureHeader(secret: string, rawBody: string, tSeconds: number): Promise<string> {
  const sign = await hmacSha256Hex(secret, `${tSeconds}.${rawBody}`);
  return `t=${tSeconds},sign=${sign}`;
}

/**
 * Valida la firma. `toleranceSec` acota la repetición de un webhook viejo
 * firmado (5 minutos por defecto). Secreto vacío = siempre falso.
 */
export async function verifySignatureHeader(
  header: string | null | undefined,
  secret: string,
  rawBody: string,
  nowMs: number = Date.now(),
  toleranceSec = 300,
): Promise<boolean> {
  if (!secret) return false;
  const parts = parseSignatureHeader(header);
  if (!parts) return false;
  if (Math.abs(nowMs / 1000 - parts.t) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${parts.t}.${rawBody}`);
  return timingSafeEqualStr(expected, parts.sign);
}
