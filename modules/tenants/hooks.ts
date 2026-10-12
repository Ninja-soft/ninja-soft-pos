"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";

export interface MyTenant {
  tenantId: string;
  industry: string | null;
  // Nombre del negocio (lo usan textos listos para enviar, p. ej. el mail a Nave).
  name: string | null;
  role: string;
  canManage: boolean;
}

// Contexto del negocio activo del usuario: id, rubro y rol.
// Lo consumen el POS (para features por rubro) y la pantalla de Configuración.
export function useMyTenant() {
  return useQuery<MyTenant | null>({
    queryKey: ["my-tenant"],
    queryFn: async (): Promise<MyTenant | null> => {
      const supabase = createClient();
      const user = await getCurrentUser();
      if (!user) return null;
      // Membresía del negocio ACTIVO del JWT (con dos membresías no vale cualquiera).
      const activeTenant = (user.app_metadata as { current_tenant_id?: string } | null)?.current_tenant_id;
      let memQ = supabase.from("tenant_users").select("tenant_id, role").eq("user_id", user.id).eq("status", "active");
      if (activeTenant) memQ = memQ.eq("tenant_id", activeTenant);
      const { data: mem } = await memQ.limit(1).maybeSingle();
      if (!mem) return null;
      const { data: t } = await supabase
        .from("tenants")
        .select("industry, name")
        .eq("id", mem.tenant_id)
        .maybeSingle();
      return {
        tenantId: mem.tenant_id,
        industry: t?.industry ?? null,
        name: t?.name ?? null,
        role: mem.role,
        canManage: ["owner", "manager"].includes(mem.role),
      };
    },
  });
}

// El dueño/encargado cambia el rubro de su negocio (RPC con guard server-side).
export function useSetMyIndustry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (industry: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_my_tenant_industry", {
        p_industry: industry,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-tenant"] });
    },
  });
}
