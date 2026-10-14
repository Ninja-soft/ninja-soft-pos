"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { syncRememberedBusiness } from "@/lib/auth/rememberedBusiness";
import { businessDisplayNameOrNull } from "@/lib/branding/businessName";
import { fetchTradeName } from "@/modules/tenants/businessName";

type Snapshot = { name: string | null; logoUrl: string | null } | null;

// Recuerda en este dispositivo el negocio activo (nombre + logo público) para
// que el login lo muestre la próxima vez. Ver lib/auth/rememberedBusiness.ts.
// Montado en el AppShell: corre en toda sesión autenticada del panel/POS.
// No escribe nada durante un acceso del staff como el negocio (ADR-084): ese
// dispositivo no es del negocio. El staff interno que además es miembro activo
// del negocio (su propio negocio) sí se recuerda: la membresía es la prueba.
export function RememberBusiness() {
  const { data } = useQuery({
    queryKey: ["remember-business"],
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: async (): Promise<Snapshot> => {
      const supabase = createClient();
      const user = await getCurrentUser();
      if (!user) return null;
      const meta = (user.app_metadata ?? {}) as { current_tenant_id?: string };
      const { data: imp, error: impErr } = await (supabase as any).rpc("my_impersonation");
      if (impErr || imp) return null;
      // Negocio ACTIVO del JWT (con dos membresías no vale cualquiera).
      let memQ = supabase.from("tenant_users").select("tenant_id").eq("user_id", user.id).eq("status", "active");
      if (meta.current_tenant_id) memQ = memQ.eq("tenant_id", meta.current_tenant_id);
      const { data: mem } = await memQ.limit(1).maybeSingle();
      if (!mem) return null;
      const [{ data: t, error: tErr }, { data: b, error: bErr }, tradeName] = await Promise.all([
        supabase.from("tenants").select("name").eq("id", mem.tenant_id).maybeSingle(),
        supabase.from("tenant_branding").select("logo_url").eq("tenant_id", mem.tenant_id).maybeSingle(),
        fetchTradeName(supabase, mem.tenant_id),
      ]);
      // Ante un error de red no se toca lo guardado (no es "sin logo").
      if (tErr || bErr) return null;
      return {
        // ADR-124: el login saluda con el nombre de fantasía (si no, el de la cuenta).
        name: businessDisplayNameOrNull({ tradeName, tenantName: (t as { name: string | null } | null)?.name }),
        logoUrl: (b as { logo_url: string | null } | null)?.logo_url ?? null,
      };
    },
  });

  useEffect(() => {
    if (!data) return;
    try {
      syncRememberedBusiness(data);
    } catch {
      /* nunca romper el panel por esto */
    }
  }, [data]);

  return null;
}
