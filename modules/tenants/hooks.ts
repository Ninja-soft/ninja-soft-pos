"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface MyTenant {
  tenantId: string;
  industry: string | null;
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
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      const { data: t } = await supabase
        .from("tenants")
        .select("industry")
        .eq("id", mem.tenant_id)
        .maybeSingle();
      return {
        tenantId: mem.tenant_id,
        industry: t?.industry ?? null,
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
