import type { SupabaseClient, User } from "@supabase/supabase-js";
import { onlyActiveTenant } from "@/lib/tenant/scope";

// Membresía del usuario en el NEGOCIO ACTIVO (app_metadata.current_tenant_id).
//
// Leer tenant_users sólo por user_id con limit(1) es un bug: con dos
// membresías (o staff que también es dueño de otro negocio) devuelve una
// cualquiera y mezcla datos de cuentas (nombre, foto, rol, configuración). Todo
// lo que lea "mi membresía" en el front pasa por acá. El filtro por negocio
// activo es el de ADR-152 (`onlyActiveTenant` en lib/tenant/scope.ts); este
// helper le suma el orden determinístico y el tipado de columnas.

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
  const { data } = await onlyActiveTenant(
    supabase
      .from("tenant_users")
      .select(columns)
      .eq("user_id", user.id)
      .eq("status", "active"),
    user,
  )
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as unknown as T | null) ?? null;
}
