"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";
import { currentSupervisorToken, SUPERVISOR_TOKEN_HEADER } from "@/lib/security/supervisorToken";

// Header que habilita el acceso cruzado del staff interno en RLS
// (internal_scope(), ADR-052). Sólo se manda desde las rutas /internal: en el
// panel del negocio un usuario interno ve únicamente su negocio actual, aunque
// una consulta olvide filtrar por tenant.
export const INTERNAL_SCOPE_HEADER = "x-ninja-scope";

function scopedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const internal = typeof window !== "undefined" && window.location.pathname.startsWith("/internal");
  // Autorización de supervisor en curso (ADR-051): viaja como header.
  const supervisor = currentSupervisorToken();
  if (!internal && !supervisor) return fetch(input, init);
  const headers = new Headers(init?.headers);
  if (internal) headers.set(INTERNAL_SCOPE_HEADER, "internal");
  if (supervisor) headers.set(SUPERVISOR_TOKEN_HEADER, supervisor);
  return fetch(input, { ...init, headers });
}

// Cliente Supabase para el navegador (anon key, respeta RLS).
// Nunca usar service_role aquí. Ver docs/05-security.md §2.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: scopedFetch } },
  );
}
