// =============================================================================
// Getnet: helpers server-side (Deno) compartidos por `getnet`,
// `getnet_webhook` y `payment_provider_data` (ADR-065). Resuelven el token con
// el perfil de API guardado (o lo detectan y lo guardan), y dejan un log
// estructurado de cada rechazo, sin secretos. La lógica pura vive en
// ./getnet.ts (Vitest).
// =============================================================================
import {
  describeDetectFailure,
  type GetnetDiag,
  logGetnetError,
  resolveGetnetAuth,
  type ResolvedAuth,
} from "./getnet.ts";
import { type LoadedSecret, updateSecretRow } from "./paymentSecrets.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

/** Switch Sandbox del medio (fallback del ambiente si la credencial no lo trae). */
export async function loadGetnetSandbox(admin: Admin, tenantId: string): Promise<boolean> {
  const { data } = await admin
    .from("tenant_payment_methods")
    .select("sandbox")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "getnet")
    .maybeSingle();
  return (data as { sandbox?: boolean } | null)?.sandbox === true;
}

export type AuthOk = Extract<ResolvedAuth, { ok: true }>;
export type AuthFail = { ok: false; detail: string; attempts: GetnetDiag[]; env: string };

/**
 * Token para la credencial cargada. Si el perfil se detectó ahora (credencial
 * vieja sin api_profile, o el guardado dejó de andar), se guarda en la fila
 * para no volver a probar todos los servicios en cada cobro.
 */
export async function getnetAuth(
  admin: Admin,
  tenantId: string,
  row: LoadedSecret,
  fn: string,
): Promise<AuthOk | AuthFail> {
  const sec = row.secrets ?? {};
  const sandbox = await loadGetnetSandbox(admin, tenantId);
  const r = await resolveGetnetAuth(sec, sandbox);
  if (!r.ok) {
    for (const d of r.attempts) logGetnetError(fn, d, { tenant_id: tenantId, mismatch: r.mismatch });
    return { ok: false, detail: describeDetectFailure(r), attempts: r.attempts, env: r.env };
  }
  if (r.detected) {
    try {
      await updateSecretRow(
        admin,
        { rowId: row.rowId, tenantId, providerKey: "getnet", storeId: row.scopeStoreId },
        { ...sec, api_profile: r.profile.key, environment: r.env },
      );
    } catch (e) {
      console.error(JSON.stringify({ fn, step: "persist_profile", error: String(e).slice(0, 200) }));
    }
  }
  return r;
}
