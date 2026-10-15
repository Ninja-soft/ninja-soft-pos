"use client";

import { useQuery } from "@tanstack/react-query";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";

/**
 * Negocio activo del JWT para armar query keys particionadas por negocio
 * (ADR-152). `undefined` mientras carga: las queries que lo usan en la key
 * esperan (`enabled: tenantId !== undefined`) para no cachear bajo "none".
 * Cuando cambia la cuenta, TenantCacheGuard resetea la caché y esto se
 * vuelve a leer con la sesión nueva.
 */
export function useActiveTenantId(): string | null | undefined {
  const { data } = useQuery({
    queryKey: ["active-tenant-id"],
    queryFn: async () => (await getCurrentTenantId()) ?? null,
    staleTime: 5 * 60_000,
  });
  return data;
}
