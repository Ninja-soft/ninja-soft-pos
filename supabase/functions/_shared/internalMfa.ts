// =============================================================================
// _shared/internalMfa.ts (SEC-23 · ADR-186)
//
// Las Edges de staff (staff_admin, set_platform_secret, internal_impersonate,
// internal_tenant_members, platform_billing) rechazan sesiones aal1 cuando el
// flag global `internal_mfa_required` (system_settings) está prendido.
//
// El claim `aal` se lee del JWT del header Authorization DESPUÉS de que
// `auth.getUser()` lo validó contra Supabase Auth: acá sólo se decodifica el
// payload, no se verifica la firma (eso ya lo hizo getUser).
//
// Puro (sin Deno.*): lo usan las Edge y los tests de Vitest.
// =============================================================================

/** Payload del JWT (sin verificar la firma). null si no se puede leer. */
export function decodeJwtPayload(authHeader: string | null | undefined): Record<string, unknown> | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Claim `aal` del JWT ("aal1" si falta o no se puede leer). */
export function aalFromAuthHeader(authHeader: string | null | undefined): string {
  const aal = decodeJwtPayload(authHeader)?.aal;
  return typeof aal === "string" && aal ? aal : "aal1";
}

/** true si la sesión de staff tiene que rechazarse por falta de MFA. */
export function staffMfaBlocked(flagOn: boolean, aal: string): boolean {
  return flagOn && aal !== "aal2";
}

/**
 * true si el error dice que la RPC no existe (Edges desplegadas antes que la
 * migración): PostgREST PGRST202 ("Could not find the function …") o
 * Postgres 42883 (undefined_function). En ese caso el flag no puede estar
 * prendido: se trata como APAGADO. Cualquier otro error falla cerrado.
 */
export function isMissingFunctionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  return code === "PGRST202" || code === "42883" || /could not find the function/i.test(message);
}

type RpcClient = {
  rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * "mfa_required" si la Edge tiene que responder 403, null si puede seguir.
 * Lee el flag con el cliente del usuario (RPC internal_mfa_required, que
 * authenticated puede ejecutar). Si la RPC no existe (migración todavía sin
 * aplicar) el flag cuenta como apagado; cualquier otra falla de lectura se
 * asume PRENDIDO (falla cerrado): una sesión aal2 pasa igual.
 */
export async function staffMfaRejection(
  userClient: RpcClient,
  authHeader: string | null | undefined,
): Promise<"mfa_required" | null> {
  const aal = aalFromAuthHeader(authHeader);
  if (aal === "aal2") return null;
  let flagOn = true;
  try {
    const { data, error } = await userClient.rpc("internal_mfa_required");
    if (!error && typeof data === "boolean") flagOn = data;
    else if (isMissingFunctionError(error)) flagOn = false;
  } catch {
    flagOn = true;
  }
  return staffMfaBlocked(flagOn, aal) ? "mfa_required" : null;
}
