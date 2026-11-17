// =============================================================================
// _shared/mpWebhookSignature.ts (SEC-60 · ADR-189)
//
// Verificación de `x-signature` en mp_webhook y mp_orders_webhook, con un modo
// global leído de system_settings.mp_webhook_signature_mode:
//   * off     → no se mira la firma (comportamiento anterior).
//   * report  → se verifica; si falta el secreto o la firma no coincide se
//               anota el motivo en webhook_events (wh.note) y se procesa igual.
//   * enforce → firma inválida, sin ts, ausente o vencida → 401 sin escribir.
//               Si no hay secreto para ese aviso se sigue como en report.
// Sin fila, valor desconocido o lectura fallida → report (nunca enforce por
// error). El modo se cachea 60 s en el isolate.
//
// Qué secreto firma: MP firma con la "clave secreta" de webhooks de la
// APLICACIÓN dueña de la notificación. Para cobros creados con un token OAuth
// (app de NinjaSoft) y para los avisos de la app (orders, contracargos,
// reclamos) es la de la app de plataforma: platform_secrets.mercadopago
// .webhook_secret (la misma que usa mp_billing_webhook). Para negocios con
// Access Token manual (su propia app) no guardamos ningún secreto: el aviso
// cuenta como "sin secreto" (signature_missing_secret) y nunca se corta.
//
// Puro (sin Deno.* ni imports de URL): lo prueban los tests de Vitest.
// =============================================================================
import { parseMpSignature, verifyMpSignature } from "./mpSignature.ts";

export type MpSignatureMode = "off" | "report" | "enforce";

export const MP_SIGNATURE_MODE_KEY = "mp_webhook_signature_mode";
export const MP_SIGNATURE_DEFAULT_MODE: MpSignatureMode = "report";
/** Vida del cache del modo y del secreto en el isolate. */
export const MP_SIGNATURE_CACHE_MS = 60_000;
/** Ventana anti-replay de verifyMpSignature (default de mpSignature.ts). */
export const MP_SIGNATURE_TOLERANCE_SEC = 600;

export type MpSignatureReason =
  | "signature_missing_secret"
  | "signature_missing"
  | "signature_no_ts"
  | "signature_invalid"
  | "signature_expired"
  | "signature_check_failed";

export type MpSignatureDecision =
  | { action: "continue"; reason: MpSignatureReason | null }
  | { action: "reject"; reason: MpSignatureReason };

/** Lo mínimo del query builder que usan las lecturas (service_role). */
type ReadDb = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): { maybeSingle(): PromiseLike<{ data: unknown; error?: unknown }> };
    };
  };
};

export function parseSignatureMode(value: unknown): MpSignatureMode {
  return value === "off" || value === "report" || value === "enforce" ? value : MP_SIGNATURE_DEFAULT_MODE;
}

let modeCache: { mode: MpSignatureMode; at: number } | null = null;
let secretCache: { secret: string | null; at: number } | null = null;

/** Para los tests: vacía el cache del isolate. */
export function resetMpSignatureCache(): void {
  modeCache = null;
  secretCache = null;
}

/** Modo global (cache 60 s). Una lectura fallida da report y no se cachea. */
export async function readMpSignatureMode(db: ReadDb, nowMs: number = Date.now()): Promise<MpSignatureMode> {
  if (modeCache && nowMs - modeCache.at < MP_SIGNATURE_CACHE_MS) return modeCache.mode;
  try {
    const { data, error } = await db
      .from("system_settings")
      .select("value")
      .eq("key", MP_SIGNATURE_MODE_KEY)
      .maybeSingle();
    if (error) return MP_SIGNATURE_DEFAULT_MODE;
    const mode = parseSignatureMode((data as { value?: unknown } | null)?.value);
    modeCache = { mode, at: nowMs };
    return mode;
  } catch {
    return MP_SIGNATURE_DEFAULT_MODE;
  }
}

/**
 * Clave secreta de webhooks de la app de plataforma (cache 60 s). null si no
 * está cargada o la lectura falla (cuenta como "sin secreto": no se corta).
 */
export async function readPlatformWebhookSecret(db: ReadDb, nowMs: number = Date.now()): Promise<string | null> {
  if (secretCache && nowMs - secretCache.at < MP_SIGNATURE_CACHE_MS) return secretCache.secret;
  try {
    const { data, error } = await db
      .from("platform_secrets")
      .select("secrets")
      .eq("key", "mercadopago")
      .maybeSingle();
    if (error) return null;
    const raw = (data as { secrets?: { webhook_secret?: unknown } } | null)?.secrets?.webhook_secret;
    const secret = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    secretCache = { secret, at: nowMs };
    return secret;
  } catch {
    return null;
  }
}

/** Motivo de una firma que no verificó (sin header, sin ts, vencida, otra). */
export async function mpSignatureReason(input: {
  secret: string;
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
  nowMs: number;
}): Promise<MpSignatureReason | null> {
  const { signature } = input;
  if (!signature || !signature.trim()) return "signature_missing";
  if (!parseMpSignature(signature) && !/(^|,)\s*ts\s*=\s*\d{1,13}\s*(,|$)/i.test(signature)) return "signature_no_ts";
  const res = await verifyMpSignature({
    secret: input.secret,
    signature,
    requestId: input.requestId,
    dataId: input.dataId,
    nowMs: input.nowMs,
    toleranceSec: MP_SIGNATURE_TOLERANCE_SEC,
  });
  if (res === "valid") return null;
  if (res === "expired") return "signature_expired";
  if (res === "missing") return "signature_missing";
  return "signature_invalid";
}

/** Decide qué hacer con el aviso según el modo y el secreto disponible. */
export async function decideMpSignature(input: {
  mode: MpSignatureMode;
  secret: string | null;
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
  nowMs: number;
}): Promise<MpSignatureDecision> {
  if (input.mode === "off") return { action: "continue", reason: null };
  if (!input.secret) return { action: "continue", reason: "signature_missing_secret" };
  const reason = await mpSignatureReason({ ...input, secret: input.secret });
  if (!reason) return { action: "continue", reason: null };
  return input.mode === "enforce" ? { action: "reject", reason } : { action: "continue", reason };
}
