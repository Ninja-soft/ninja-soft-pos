"use client";

// Perfiles por rubro (F5 · ADR-075). Lee lo necesario para la vista previa y
// aplica el perfil por la RPC apply_business_profile (sólo el dueño; el
// servidor valida rol, plan y escribe audit_logs). Las tablas nuevas no están
// en types/database.ts: se castean.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useGating } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import type { ProfileContext } from "@/lib/profiles/preview";
import type { ProfileFlag } from "@/lib/profiles/businessProfiles";

type LooseResult = { data: unknown; error: { message: string } | null };
type LooseQuery = PromiseLike<LooseResult> & {
  select: (cols: string) => LooseQuery;
  eq: (col: string, v: unknown) => LooseQuery;
  is: (col: string, v: null) => LooseQuery;
  maybeSingle: () => PromiseLike<LooseResult>;
};
type Loose = {
  from: (t: string) => LooseQuery;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<LooseResult>;
};
const loose = () => createClient() as unknown as Loose;

export interface AppliedProfile {
  profile_key: string;
  profile_version: number;
  previous_key: string | null;
  applied_at: string;
}

export interface ApplyProfileResult {
  profile: string;
  version: number;
  activated: ProfileFlag[];
  already_on: ProfileFlag[];
  locked: ProfileFlag[];
  categories_created: string[];
  layout_applied: boolean;
  industry: string;
}

/** Perfil aplicado a un negocio (o null). En /internal lo lee el staff (RLS internal_scope). */
export function useTenantProfile(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ["business-profile", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<AppliedProfile | null> => {
      const { data, error } = await loose()
        .from("tenant_business_profiles")
        .select("profile_key, profile_version, previous_key, applied_at")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as AppliedProfile | null) ?? null;
    },
  });
}

interface SettingsRow {
  dining_enabled?: boolean;
  delivery_enabled?: boolean;
  scale_enabled?: boolean;
  plu_enabled?: boolean;
  allow_free_sale?: boolean;
  pos_layout?: Record<string, unknown> | null;
}

/** Estado actual del negocio para armar la vista previa de un perfil. */
export function useProfileContext() {
  const { data: tenant } = useMyTenant();
  const tenantId = tenant?.tenantId ?? null;
  const gating = useGating();
  const applied = useTenantProfile(tenantId);

  const base = useQuery({
    queryKey: ["business-profile-ctx", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const db = loose();
      const [settings, cats] = await Promise.all([
        db
          .from("pos_settings")
          .select("dining_enabled, delivery_enabled, scale_enabled, plu_enabled, allow_free_sale, pos_layout")
          .eq("tenant_id", tenantId!)
          .maybeSingle(),
        db.from("categories").select("name").eq("tenant_id", tenantId!).is("deleted_at", null),
      ]);
      if (settings.error) throw new Error(settings.error.message);
      if (cats.error) throw new Error(cats.error.message);
      return {
        settings: (settings.data as SettingsRow | null) ?? null,
        categories: ((cats.data as { name: string }[] | null) ?? []).map((c) => c.name),
      };
    },
  });

  const ready = Boolean(tenant && base.data && gating.data && applied.isFetched);
  const ctx: ProfileContext | null = ready
    ? {
        currentProfile: applied.data?.profile_key ?? null,
        currentVertical: tenant!.industry,
        flags: {
          dining_enabled: Boolean(base.data!.settings?.dining_enabled),
          delivery_enabled: Boolean(base.data!.settings?.delivery_enabled),
          scale_enabled: Boolean(base.data!.settings?.scale_enabled),
          plu_enabled: Boolean(base.data!.settings?.plu_enabled),
          allow_free_sale: Boolean(base.data!.settings?.allow_free_sale),
        },
        posLayout: base.data!.settings?.pos_layout ?? {},
        categories: base.data!.categories,
        features: gating.data!.features,
      }
    : null;

  return {
    ctx,
    tenant: tenant ?? null,
    applied: applied.data ?? null,
    isOwner: tenant?.role === "owner",
    isLoading: !ready && (base.isLoading || gating.isLoading || applied.isLoading),
  };
}

/** Aplica un perfil (RPC). Invalida lo que el perfil puede cambiar. */
export function useApplyBusinessProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { key: string; createCategories: boolean }): Promise<ApplyProfileResult> => {
      const { data, error } = await loose().rpc("apply_business_profile", {
        p_key: args.key,
        p_create_categories: args.createCategories,
      });
      if (error) throw new Error(error.message);
      return data as ApplyProfileResult;
    },
    onSuccess: () => {
      for (const key of [
        ["business-profile"],
        ["business-profile-ctx"],
        ["my-tenant"],
        ["pos", "settings"],
        ["dining", "enabled"],
        ["delivery", "enabled"],
        ["categories"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** Mensaje entendible para los errores de la RPC. */
export function profileErrorMessage(message: string): string {
  if (message.includes("forbidden")) return "Sólo el dueño del negocio puede cambiar el rubro.";
  if (message.includes("invalid_profile")) return "Ese perfil no existe o ya no está disponible.";
  if (message.includes("no_tenant")) return "No hay un negocio activo en tu sesión.";
  return "No se pudo aplicar el perfil. Probá de nuevo.";
}
