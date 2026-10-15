"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useMyTenant } from "@/modules/tenants/hooks";
import { ROLE_CAPABILITIES, isCapability, type Capability } from "./capabilities";
import { normalizeRole } from "./roles";

// Capacidades efectivas del usuario en el negocio activo (ADR-137): las del
// rol más las otorgadas, según my_capabilities() del servidor. Mientras carga
// (o si la RPC todavía no existe en la base) usa las del rol: la base igual
// revalida cada acción.
export function useCapabilities() {
  const { data: me } = useMyTenant();
  const role = normalizeRole(me?.role);
  const { data } = useQuery({
    queryKey: ["my-capabilities", me?.tenantId ?? null],
    enabled: Boolean(me?.tenantId),
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<Capability[]> => {
      const { data: caps, error } = await createClient().rpc("my_capabilities" as never);
      if (error) throw error;
      return ((caps as string[] | null) ?? []).filter(isCapability);
    },
  });
  const caps: readonly Capability[] = data ?? (role ? ROLE_CAPABILITIES[role] : []);
  return {
    role,
    loaded: Boolean(me),
    caps,
    can: (cap: Capability) => caps.includes(cap),
  };
}
