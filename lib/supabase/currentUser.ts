"use client";

import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

// Usuario actual validado contra Supabase Auth (getUser), compartido entre las
// queries del navegador. Cada `auth.getUser()` es un round-trip a /auth/v1/user:
// al montar el panel lo pedían en paralelo el shell, el menú de usuario, el
// estado de la cuenta, el tenant, notificaciones… (5-8 requests idénticas).
// Acá se deduplica: una sola request en vuelo y el resultado se reusa por
// unos segundos. Cualquier cambio de sesión (login, logout, refresh de token,
// update de usuario) invalida el cache. La seguridad no cambia: RLS sigue
// validando el JWT en cada query.
const TTL_MS = 30_000;

let cached: { user: User; at: number } | null = null;
let inflight: Promise<User | null> | null = null;
let listening = false;

function reset() {
  cached = null;
  inflight = null;
}

export async function getCurrentUser(): Promise<User | null> {
  const supabase = createClient();
  if (!listening) {
    listening = true;
    supabase.auth.onAuthStateChange((event) => {
      if (event !== "INITIAL_SESSION") reset();
    });
  }
  if (cached && Date.now() - cached.at < TTL_MS) return cached.user;
  if (!inflight) {
    const p = supabase.auth
      .getUser()
      .then(({ data }) => {
        // Sólo se cachea un usuario válido: un null (sin sesión o error de red)
        // se vuelve a consultar en la próxima llamada.
        if (data.user && inflight === p) cached = { user: data.user, at: Date.now() };
        return data.user;
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }
  return inflight;
}

/**
 * Negocio activo del usuario (app_metadata.current_tenant_id del JWT). El staff
 * interno pasa la RLS de varias tablas para todos los negocios (is_internal()),
 * así que las listas del panel del negocio filtran explícitamente por este id.
 */
export async function getCurrentTenantId(): Promise<string | null> {
  const user = await getCurrentUser();
  return ((user?.app_metadata as { current_tenant_id?: string } | undefined)?.current_tenant_id) ?? null;
}
