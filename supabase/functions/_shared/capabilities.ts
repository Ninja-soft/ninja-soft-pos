// Capacidades del usuario para las Edge Functions (ADR-138).
//
// Pregunta a la base con user_has_capability (service_role), la misma
// resolución que usan las RPC y las policies. Si la función todavía no existe
// (Edge desplegada antes que la migración 20261204100100), cae a la regla por
// rol de antes para no cortar a nadie.
// deno-lint-ignore-file no-explicit-any

export async function userHasCapability(
  admin: any,
  tenantId: string,
  userId: string,
  capability: string,
  legacyRoles: string[],
  callerRole: string | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc("user_has_capability", {
    p_tenant: tenantId,
    p_user: userId,
    p_cap: capability,
  });
  if (error) {
    const missing = /user_has_capability|does not exist|PGRST202/i.test(`${error.message} ${error.code ?? ""}`);
    if (missing) return callerRole !== null && legacyRoles.includes(callerRole);
    throw new Error(error.message);
  }
  return data === true;
}
