import type { SupabaseClient, User } from "@supabase/supabase-js";

// Membresía del usuario en el NEGOCIO ACTIVO (app_metadata.current_tenant_id).
//
// Leer tenant_users sólo por user_id con limit(1) es un bug: con dos
// membresías (o staff que también es dueño de otro negocio) devuelve una
// cualquiera y mezcla datos de cuentas (nombre, foto, rol, configuración). Todo
// lo que lea "mi membresía" en el front pasa por acá.

/** Negocio activo del JWT, o null si el usuario todavía no tiene uno. */
export function activeTenantIdOf(
  user: Pick<User, "app_metadata"> | null | undefined,
): string | null {
  const id = (user?.app_metadata as { current_tenant_id?: unknown } | undefined)
    ?.current_tenant_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Lee la membresía activa del usuario en el negocio activo con las columnas
 * pedidas. Sin negocio activo en el JWT (caso raro: alta en curso) cae a la
 * membresía más vieja, siempre en orden determinístico.
 */
export async function fetchMyMembership<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  user: Pick<User, "id" | "app_metadata">,
  columns: string,
): Promise<T | null> {
  const tenantId = activeTenantIdOf(user);
  let q = supabase
    .from("tenant_users")
    .select(columns)
    .eq("user_id", user.id)
    .eq("status", "active");
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data } = await q
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as unknown as T | null) ?? null;
}
