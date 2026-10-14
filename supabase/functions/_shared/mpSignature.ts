// =============================================================================
// _shared/mpSignature.ts (F20-0b · H126)
//
// Validación de la firma `x-signature` de los webhooks de Mercado Pago
// (doc "Notificaciones > Webhooks > Validar origen"):
//   x-signature: ts=<unix>,v1=<hmac hex>
//   manifest   = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
//   v1         = HMAC-SHA256(clave secreta del webhook, manifest)
// data.id sale de la query (`data.id`) y va en minúsculas si es alfanumérico.
// Una parte que no vino se omite del manifest. Comparación en tiempo constante
// y ventana contra repeticiones. WebCrypto: corre en Deno (Edge) y en Node
// (tests/unit/mpSignature.test.ts).
// =============================================================================
import { hmacSha256Hex, timingSafeEqualStr } from "./deliveryChannels/signature.ts";

export interface MpSignatureParts {
  ts: string;
  v1: string;
}

export function parseMpSignature(header: string | null | undefined): MpSignatureParts | null {
  if (!header) return null;
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, ...rest] = part.split("=");
    const key = (k ?? "").trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "ts" && /^\d{1,13}$/.test(value)) ts = value;
    if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) v1 = value.toLowerCase();
  }
  return ts !== null && v1 !== null ? { ts, v1 } : null;
}

export function buildMpManifest(dataId: string | null | undefined, requestId: string | null | undefined, ts: string): string {
  let id = (dataId ?? "").trim();
  if (/^[a-z0-9]+$/i.test(id)) id = id.toLowerCase();
  let out = "";
  if (id) out += `id:${id};`;
  if (requestId) out += `request-id:${requestId.trim()};`;
  out += `ts:${ts};`;
  return out;
}

export type MpSignatureResult = "valid" | "invalid" | "missing" | "expired";

/**
 * Valida la firma. `ts` de Mercado Pago viene en milisegundos (o segundos en
 * integraciones viejas): se normaliza para la ventana de repetición.
 */
export async function verifyMpSignature(input: {
  secret: string;
  signature: string | null | undefined;
  requestId: string | null | undefined;
  dataId: string | null | undefined;
  nowMs?: number;
  toleranceSec?: number;
}): Promise<MpSignatureResult> {
  const { secret, signature, requestId, dataId } = input;
  if (!secret) return "invalid";
  const parts = parseMpSignature(signature);
  if (!parts) return signature ? "invalid" : "missing";
  const tsNum = Number(parts.ts);
  const tsMs = parts.ts.length >= 13 ? tsNum : tsNum * 1000;
  const tolerance = (input.toleranceSec ?? 600) * 1000;
  if (Math.abs((input.nowMs ?? Date.now()) - tsMs) > tolerance) return "expired";
  const expected = await hmacSha256Hex(secret, buildMpManifest(dataId, requestId, parts.ts));
  return timingSafeEqualStr(expected, parts.v1) ? "valid" : "invalid";
}

/** Para los tests: arma un header válido. */
export async function signMpWebhook(secret: string, dataId: string, requestId: string, ts: string): Promise<string> {
  const v1 = await hmacSha256Hex(secret, buildMpManifest(dataId, requestId, ts));
  return `ts=${ts},v1=${v1}`;
}
