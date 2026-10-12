"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { loadPosLayoutPref, savePosLayoutPref } from "@/lib/theme/preferences";
import { resolveLayout, sanitizeLayout, type PosLayoutOverride } from "@/lib/pos/layout";
import { resolveTenders, type ResolvedTender } from "@/lib/pos/tenders";
import { useGating } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { posApi } from "./api";
import { usePosSettings } from "./hooks";

// ── Diseño del POS ───────────────────────────────────────────────────────────

export function usePosLayoutUserPref() {
  return useQuery({
    queryKey: ["pos", "layout", "user"],
    queryFn: loadPosLayoutPref,
    staleTime: 5 * 60_000,
  });
}

/**
 * Diseño efectivo del POS: defaults del preset ← negocio ← usuario. `ready`
 * es false hasta tener los settings (evita pintar un preset y saltar a otro).
 */
export function usePosLayout() {
  const { data: settings, isFetched } = usePosSettings();
  const { data: userPref, isFetched: userFetched } = usePosLayoutUserPref();
  const layout = useMemo(
    () => resolveLayout(settings?.posLayout ?? null, userPref ?? null),
    [settings?.posLayout, userPref],
  );
  return {
    layout,
    business: sanitizeLayout(settings?.posLayout ?? null),
    user: sanitizeLayout(userPref ?? null, { allowQuickKeys: false }),
    hasUserOverride: Boolean(userPref && typeof userPref === "object"),
    ready: isFetched && userFetched,
  };
}

export function usePosLayoutMutations() {
  const qc = useQueryClient();
  const { data: myTenant } = useMyTenant();
  return {
    // Diseño del negocio (owner/manager). El trigger de pos_settings valida las
    // teclas rápidas pro (feature pos_quick_keys_pro).
    saveBusiness: useMutation({
      mutationFn: async (layout: PosLayoutOverride) => {
        if (!myTenant?.tenantId) throw new Error("no_tenant");
        const supabase = createClient();
        const { error } = await supabase
          .from("pos_settings")
          .upsert({ tenant_id: myTenant.tenantId, pos_layout: layout } as never, {
            onConflict: "tenant_id",
          });
        if (error) throw error;
      },
      onSuccess: () => qc.invalidateQueries({ queryKey: ["pos", "settings"] }),
    }),
    // Override del usuario (users.settings.pos_layout). null = volver al del negocio.
    saveUser: useMutation({
      mutationFn: (layout: PosLayoutOverride | null) =>
        savePosLayoutPref(layout as Record<string, unknown> | null),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["pos", "layout", "user"] }),
    }),
  };
}

// ── Medios de cobro ──────────────────────────────────────────────────────────

export function usePaymentMethodsStatus() {
  return useQuery({
    queryKey: ["pos", "payment-methods-status"],
    queryFn: () => posApi.paymentMethodsStatus(),
    staleTime: 60_000,
  });
}

/** Tenders utilizables por el negocio (registro + config + plan). */
export function useResolvedTenders(opts: {
  hasCustomer: boolean;
  storeCreditBalance: number;
}): ResolvedTender[] {
  const { data: providers } = usePaymentMethodsStatus();
  const { data: gating } = useGating();
  return useMemo(
    () =>
      resolveTenders({
        providers,
        features: gating?.features,
        hasCustomer: opts.hasCustomer,
        storeCreditBalance: opts.storeCreditBalance,
      }),
    [providers, gating?.features, opts.hasCustomer, opts.storeCreditBalance],
  );
}
