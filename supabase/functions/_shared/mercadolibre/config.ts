// =============================================================================
// _shared/mercadolibre/config.ts (H87 · ADR-104 · ADR-126). PURO.
//
// Credenciales de la app de Mercado Libre de NinjaSoft (DevCenter, separada de
// la app de Mercado Pago desde el 30/08/2026). Dos orígenes, en este orden:
//
//   1. platform_secrets key `ml_app` (se carga desde el panel interno
//      > Mercado Libre, Edge set_platform_secret). Se usa sólo si está
//      COMPLETA: client_id + client_secret válidos. La redirect_uri es
//      opcional ahí; si falta se toma la de los secrets de Edge.
//   2. Secrets de las Edge Functions (compatibilidad, como hasta ADR-126):
//        ML_CLIENT_ID      APP_ID numérico de la app.
//        ML_CLIENT_SECRET  secreto de la app.
//        ML_REDIRECT_URI   la URL exacta registrada en DevCenter (HTTPS, sin
//                          partes variables). Si falta: <APP_URL>/api/ml/oauth/callback.
//
// Nunca se mezclan id y secret de orígenes distintos (el id de una app con el
// secreto de otra no autentica). Mientras ninguno esté completo, todo responde
// `ml_app_not_configured` (docs/38-mercadolibre.md). El secreto nunca sale de
// las Edge Functions: ni al front ni a los logs.
// =============================================================================

export const ML_API = "https://api.mercadolibre.com";
export const ML_AUTH = "https://auth.mercadolibre.com.ar/authorization";
export const ML_SITE = "MLA";

/** Key de platform_secrets con la config de la app. */
export const ML_APP_SECRET_KEY = "ml_app";

export const ML_NOT_CONFIGURED = "ml_app_not_configured";
export const ML_NOT_CONFIGURED_MSG =
  "Falta configurar la app de Mercado Libre (panel interno > Mercado Libre, o los secrets ML_CLIENT_ID y ML_CLIENT_SECRET de las Edge Functions).";

export interface MlAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** De dónde salió la config efectiva. */
export type MlConfigOrigin = "platform" | "env";

export type MlConfigResult =
  | { ok: true; config: MlAppConfig; origin: MlConfigOrigin }
  | { ok: false; error: typeof ML_NOT_CONFIGURED; message: string };

/** Campos de la app que se guardan en platform_secrets.ml_app. */
export type MlAppField = "client_id" | "client_secret" | "redirect_uri";
export const ML_APP_FIELDS: readonly MlAppField[] = ["client_id", "client_secret", "redirect_uri"];

export type MlEnv = Record<string, string | undefined>;
/** Contenido crudo de platform_secrets.ml_app (jsonb). */
export type MlPlatformSecrets = Partial<Record<MlAppField, unknown>> | null | undefined;

const ID_RE = /^\d{4,20}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Mensaje de error legible, o null si el valor tiene formato válido (vacío = válido). */
export function validateMlAppField(field: MlAppField, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (field) {
    case "client_id":
      if (v.includes("@")) return "Cargaste un email. El App ID de Mercado Libre es un número (DevCenter > Mis aplicaciones).";
      return ID_RE.test(v) ? null : "El App ID tiene que ser sólo números.";
    case "client_secret":
      return SECRET_RE.test(v) ? null : "La Clave secreta tiene letras y números, sin espacios.";
    case "redirect_uri": {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return "La Redirect URI no es una URL válida.";
      }
      if (u.protocol !== "https:") return "La Redirect URI tiene que ser https.";
      if (u.search || u.hash || v.includes("?") || v.includes("#"))
        return "La Redirect URI no puede tener parámetros: Mercado Libre la compara exacta.";
      return null;
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function envRedirect(env: MlEnv): string {
  const appUrl = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  return (env.ML_REDIRECT_URI ?? "").trim() || (appUrl ? `${appUrl}/api/ml/oauth/callback` : "");
}

const validId = (v: string) => ID_RE.test(v);
const validSecret = (v: string) => v.length >= 8 && !/\s/.test(v);
const validRedirect = (v: string) => Boolean(v) && !validateMlAppField("redirect_uri", v);

/** Qué le falta a la config guardada en platform_secrets (vacío = completa, con redirect propia). */
export function missingPlatformFields(db: MlPlatformSecrets): MlAppField[] {
  const out: MlAppField[] = [];
  if (!validId(str(db?.client_id))) out.push("client_id");
  if (!validSecret(str(db?.client_secret))) out.push("client_secret");
  if (!validRedirect(str(db?.redirect_uri))) out.push("redirect_uri");
  return out;
}

/**
 * Config efectiva con prioridad platform_secrets > secrets de Edge. Pura y
 * nunca lanza. `db` es el jsonb de platform_secrets.ml_app (o null).
 */
export function resolveMlConfig(sources: { db?: MlPlatformSecrets; env: MlEnv }): MlConfigResult {
  const { db, env } = sources;
  const fail: MlConfigResult = { ok: false, error: ML_NOT_CONFIGURED, message: ML_NOT_CONFIGURED_MSG };

  const dbId = str(db?.client_id);
  const dbSecret = str(db?.client_secret);
  if (validId(dbId) && validSecret(dbSecret)) {
    const dbRedirect = str(db?.redirect_uri);
    const redirectUri = validRedirect(dbRedirect) ? dbRedirect : envRedirect(env);
    if (!/^https:\/\//.test(redirectUri)) return fail;
    return { ok: true, origin: "platform", config: { clientId: dbId, clientSecret: dbSecret, redirectUri } };
  }

  const clientId = (env.ML_CLIENT_ID ?? "").trim();
  const clientSecret = (env.ML_CLIENT_SECRET ?? "").trim();
  const redirectUri = envRedirect(env);
  if (!validId(clientId) || clientSecret.length < 8 || !/^https:\/\//.test(redirectUri)) return fail;
  return { ok: true, origin: "env", config: { clientId, clientSecret, redirectUri } };
}

/** Compatibilidad: sólo secrets de Edge. */
export function readMlConfig(env: MlEnv): MlConfigResult {
  return resolveMlConfig({ db: null, env });
}

/**
 * El APP_ID numérico (para validar `application_id` de las notificaciones):
 * el de la config efectiva o, si está incompleta, el ML_CLIENT_ID del env.
 */
export function appIdOf(env: MlEnv, db?: MlPlatformSecrets): string | null {
  const r = resolveMlConfig({ db, env });
  if (r.ok) return r.config.clientId;
  const id = (env.ML_CLIENT_ID ?? "").trim();
  return validId(id) ? id : null;
}

/**
 * Memo de la config: una sola lectura de platform_secrets por invocación
 * (ttlMs = 0 y un loader por request) o por isolate con vencimiento corto
 * (ml_webhook, que tiene que responder en menos de 500 ms). Si la base falla
 * se resuelve sólo con el env y el resultado no se cachea.
 */
export function createMlConfigLoader(
  read: () => Promise<MlPlatformSecrets>,
  env: MlEnv,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<MlConfigResult> {
  const ttl = opts.ttlMs ?? 0;
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: Promise<MlConfigResult> } | null = null;
  return () => {
    if (cached && (ttl === 0 || now() - cached.at < ttl)) return cached.value;
    const entry = { at: now(), value: null as unknown as Promise<MlConfigResult> };
    entry.value = read().then(
      (db) => resolveMlConfig({ db, env }),
      () => {
        if (cached === entry) cached = null;
        return resolveMlConfig({ db: null, env });
      },
    );
    cached = entry;
    return entry.value;
  };
}

// -----------------------------------------------------------------------------
// "Probar conexión" del panel interno: valida id + secret contra
// POST /oauth/token sin tocar cuentas de clientes.
// -----------------------------------------------------------------------------

export type MlProbeVerdict = "valid" | "invalid_credentials" | "unknown";

/**
 * Clasifica la respuesta de /oauth/token. Con un refresh_token inventado, ML
 * responde `invalid_grant` si el par id/secret es correcto (el token no
 * existe) e `invalid_client` si el par está mal. Un 200 con access_token
 * (client_credentials) también prueba que el par es correcto.
 */
export function classifyMlTokenProbe(status: number, body: unknown): MlProbeVerdict {
  const b = (body ?? {}) as { access_token?: unknown; error?: unknown; message?: unknown };
  if (status >= 200 && status < 300 && typeof b.access_token === "string") return "valid";
  const err = String(b.error ?? "").toLowerCase();
  const msg = String(b.message ?? "").toLowerCase();
  if (err === "invalid_client" || /invalid client|client_secret|client_id/.test(msg)) return "invalid_credentials";
  if (err === "invalid_grant") return "valid";
  return "unknown";
}
