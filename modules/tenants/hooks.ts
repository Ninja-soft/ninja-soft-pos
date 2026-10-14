"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { businessDisplayNameOrNull } from "@/lib/branding/businessName";
import { fetchTradeName } from "./businessName";

export interface MyTenant {
  tenantId: string;
  industry: string | null;
  // Nombre del negocio PARA MOSTRAR (ADR-123): fantasía, si no el de la cuenta.
  // Lo usan la barra lateral, impresiones y textos listos para enviar.
  name: string | null;
  /** tenants.name (nombre de la cuenta). */
  tenantName: string | null;
  /** tenant_branding.trade_name (nombre de fantasía, Configuración > Marca). */
  tradeName: string | null;
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
      const [{ data: t }, tradeName] = await Promise.all([
        supabase.from("tenants").select("industry, name").eq("id", mem.tenant_id).maybeSingle(),
        fetchTradeName(supabase, mem.tenant_id),
      ]);
      const tenantName = t?.name ?? null;
      return {
        tenantId: mem.tenant_id,
        industry: t?.industry ?? null,
        name: businessDisplayNameOrNull({ tradeName, tenantName }),
        tenantName,
        tradeName,
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
