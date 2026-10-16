"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { fetchMyMembership } from "@/lib/tenant/myMembership";
import { useGating } from "@/modules/saas/gating";
import { useProfileContext } from "@/modules/profiles/hooks";
import { useOnboardingActivation } from "@/modules/help/hooks";
import {
  buildActivationChecklist,
  checklistProfile,
  checklistStatusFromSignals,
  type ChecklistStatus,
  type ChecklistStep,
} from "@/lib/onboarding/activationChecklist";

// Datos de la "Puesta en marcha" compartidos por la tarjeta del panel y por
// los avisos de "qué sigue" (ADR-154): negocio activo, pasos por rubro y plan,
// estado con datos reales y si el dueño la ocultó para siempre.
export interface OnboardingChecklistData {
  tenantId: string;
  steps: ChecklistStep[];
  /** null mientras falta alguna señal. */
  status: ChecklistStatus | null;
  /** null mientras carga (no mostrar nada todavía). */
  dismissed: boolean | null;
}

export function useOnboardingChecklist(
  enabled = true,
): OnboardingChecklistData {
  const supabase = createClient();

  const { data: ctx } = useQuery({
    queryKey: ["onboarding-ctx"],
    enabled,
    queryFn: async (): Promise<{ tenantId: string } | null> => {
      const user = await getCurrentUser();
      if (!user) return null;
      const mem = await fetchMyMembership<{ tenant_id: string }>(
        supabase,
        user,
        "tenant_id",
      );
      return mem ? { tenantId: mem.tenant_id } : null;
    },
  });
  const tenantId = ctx?.tenantId ?? "";

  const { data: base } = useQuery({
    queryKey: ["onboarding-status"],
    enabled: enabled && !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("onboarding_status");
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
  });

  const { data: dismissed } = useQuery({
    queryKey: ["onboarding-dismissed", tenantId],
    enabled: enabled && !!tenantId,
    queryFn: async (): Promise<boolean> => {
      const { data } = await supabase
        .from("pos_settings")
        .select("onboarding_dismissed")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      return Boolean(
        (data as { onboarding_dismissed?: boolean } | null)
          ?.onboarding_dismissed,
      );
    },
  });

  // Señales extra (caja, equipo, salón, agenda, ARCA, Escuela). Sin la
  // migración la RPC falla y el checklist sigue con los pasos base.
  const { data: extra, isFetched: extraFetched } = useOnboardingActivation(
    enabled && !!tenantId,
  );
  const { tenant, applied } = useProfileContext();
  const { data: gating } = useGating();
  const steps = buildActivationChecklist({
    profile: checklistProfile(applied?.profile_key, tenant?.industry),
    features: gating?.features ?? {},
  });
  const status =
    base && extraFetched && gating
      ? checklistStatusFromSignals({ ...(extra ?? {}), ...base })
      : null;

  return { tenantId, steps, status, dismissed: dismissed ?? null };
}
