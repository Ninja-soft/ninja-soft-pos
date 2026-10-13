// =============================================================================
// _shared/mercadolibre/config.ts (H87 · ADR-104). PURO (recibe el env).
//
// Credenciales de la app de Mercado Libre de NinjaSoft (DevCenter, separada de
// la app de Mercado Pago desde el 30/08/2026). Viven SÓLO como secrets de las
// Edge Functions, nunca en la base ni en el front:
//
//   ML_CLIENT_ID      APP_ID numérico de la app.
//   ML_CLIENT_SECRET  secreto de la app.
//   ML_REDIRECT_URI   la URL exacta registrada en DevCenter (HTTPS, sin partes
//                     variables). Si falta: <APP_URL>/api/ml/oauth/callback.
//
// Mientras no estén cargados, todo responde `ml_app_not_configured` con el
// mensaje "Falta configurar la app de Mercado Libre" (docs/38-mercadolibre.md).
// =============================================================================

export const ML_API = "https://api.mercadolibre.com";
export const ML_AUTH = "https://auth.mercadolibre.com.ar/authorization";
export const ML_SITE = "MLA";

export const ML_NOT_CONFIGURED = "ml_app_not_configured";
export const ML_NOT_CONFIGURED_MSG =
  "Falta configurar la app de Mercado Libre (ML_CLIENT_ID y ML_CLIENT_SECRET en los secrets de las Edge Functions).";

export interface MlAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type MlConfigResult = { ok: true; config: MlAppConfig } | { ok: false; error: typeof ML_NOT_CONFIGURED; message: string };

/** Lee la config de la app; nunca lanza. */
export function readMlConfig(env: Record<string, string | undefined>): MlConfigResult {
  const clientId = (env.ML_CLIENT_ID ?? "").trim();
  const clientSecret = (env.ML_CLIENT_SECRET ?? "").trim();
  const appUrl = (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  const redirectUri = (env.ML_REDIRECT_URI ?? "").trim() || (appUrl ? `${appUrl}/api/ml/oauth/callback` : "");
  if (!/^\d{4,20}$/.test(clientId) || clientSecret.length < 8 || !/^https:\/\//.test(redirectUri)) {
    return { ok: false, error: ML_NOT_CONFIGURED, message: ML_NOT_CONFIGURED_MSG };
  }
  return { ok: true, config: { clientId, clientSecret, redirectUri } };
}

/** El APP_ID numérico (para validar `application_id` de las notificaciones). */
export function appIdOf(env: Record<string, string | undefined>): string | null {
  const id = (env.ML_CLIENT_ID ?? "").trim();
  return /^\d{4,20}$/.test(id) ? id : null;
}
