// =============================================================================
// Cifrado de la clave privada (ADR-072). AES-256-GCM con WebCrypto (Deno y
// Node 18+). La clave maestra es el secret de Edge ARCA_KEY_ENC: 32 bytes en
// base64 (generar con `openssl rand -base64 32`). Nunca llega al front ni a
// la base: la base guarda "v1:" + base64(iv de 12 bytes || cifrado || tag).
// El tenant y el ambiente van como datos adicionales autenticados (AAD): un
// blob copiado a otro negocio no descifra.
// =============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function importMaster(masterB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(masterB64 ?? "");
  } catch {
    throw new Error("arca_key_enc_invalid");
  }
  if (raw.length !== 32) throw new Error("arca_key_enc_invalid");
  return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, masterB64: string, aad: string): Promise<string> {
  const key = await importMaster(masterB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource },
      key,
      enc.encode(plain) as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return `v1:${bytesToB64(out)}`;
}

export async function decryptSecret(blob: string, masterB64: string, aad: string): Promise<string> {
  if (!blob?.startsWith("v1:")) throw new Error("arca_blob_invalid");
  const key = await importMaster(masterB64);
  const all = b64ToBytes(blob.slice(3));
  if (all.length < 13 + 16) throw new Error("arca_blob_invalid");
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource },
      key,
      ct as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    throw new Error("arca_decrypt_failed");
  }
}

/** AAD de la clave de un negocio o de la plataforma. */
export const keyAad = (owner: string, env: string) => `arca-key:${owner}:${env}`;
