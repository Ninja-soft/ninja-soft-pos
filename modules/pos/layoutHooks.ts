"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { loadPosLayoutPref, savePosLayoutPref } from "@/lib/theme/preferences";
import { resolveLayout, sanitizeLayout, type PosLayoutOverride } from "@/lib/pos/layout";
import { resolveTenders, type ResolvedTender } from "@/lib/pos/tenders";
import { useGating } from "@/modules/saas/gating";
import { effectiveProviderRows, overridesTouch } from "@/lib/config/inheritance";
import { useConfigOverrides, usePosResolveTarget, usePosTargetReady } from "@/modules/config/hooks";
import { configApi } from "@/modules/config/api";
import { DINING_ENABLED_KEY, fetchDiningEnabled } from "@/modules/dining/hooks";
import { POS_BOOT_STORAGE_KEY, readPosBoot, safeLocalStorage, type PosBootSnap } from "@/lib/pos/bootCache";
import { useMyTenant } from "@/modules/tenants/hooks";
import { posApi } from "./api";
import { usePosSettings } from "./hooks";

// ── Diseño del POS ───────────────────────────────────────────────────────────

const USER_LAYOUT_KEY = ["pos", "layout", "user"] as const;

export function usePosLayoutUserPref() {
  return useQuery({
    queryKey: USER_LAYOUT_KEY,
    queryFn: loadPosLayoutPref,
    staleTime: 5 * 60_000,
  });
}

/**
 * Diseño efectivo del POS: defaults del preset ← negocio (con overrides de
 * grupo, sucursal o caja, ADR-049) ← usuario. `ready` es false hasta conocer
 * TODO lo que lo define: settings, override del usuario, overrides por lugar y,
 * si alguno toca el diseño, la sucursal y la caja del dispositivo. Así nunca se
 * pinta un preset para después saltar a otro.
 */
export function usePosLayout() {
  const { data: settings, isFetched } = usePosSettings();
  const { data: userPref, isFetched: userFetched } = usePosLayoutUserPref();
  const { data: overrides, isFetched: overridesFetched } = useConfigOverrides();
  const targetReady = usePosTargetReady();
  const byPlace = overridesTouch(overrides ?? [], "pos_settings", "pos_layout");
  const layout = useMemo(
    () => resolveLayout(settings?.posLayout ?? null, userPref ?? null),
    [settings?.posLayout, userPref],
  );
  return {
    layout,
    business: sanitizeLayout(settings?.posLayout ?? null),
    user: sanitizeLayout(userPref ?? null, { allowQuickKeys: false }),
    hasUserOverride: Boolean(userPref && typeof userPref === "object"),
    ready: isFetched && userFetched && overridesFetched && (!byPlace || targetReady),
  };
}

// ── Foto del arranque (lib/pos/bootCache) ────────────────────────────────────

const noopSubscribe = () => () => {};
let memo: { raw: string | null; key: string | null; scope: string | null; snap: PosBootSnap | null } | null = null;

function snapshotFor(key: string | null, scope: string | null): PosBootSnap | null {
  const st = safeLocalStorage();
  let raw: string | null = null;
  try {
    raw = st?.getItem(POS_BOOT_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (memo && memo.raw === raw && memo.key === key && memo.scope === scope) return memo.snap;
  const snap = readPosBoot(st, key, scope);
  memo = { raw, key, scope, snap };
  return snap;
}

/**
 * Última foto del POS guardada en este dispositivo. En el servidor (y al
 * hidratar) es null: el HTML del servidor muestra el esqueleto neutro y el
 * cliente pasa directo al diseño guardado, nunca al default.
 */
export function usePosBootSnapshot(key: string | null, scope: string | null): PosBootSnap | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => snapshotFor(key, scope),
    () => null,
  );
}

/** ¿Ya se sabe qué medios de cobro tiene la caja (para fijarlos en el carrito)? */
export function useTendersReady(): boolean {
  const { isFetched } = usePaymentMethodsStatus();
  const { isFetched: gatingFetched } = useGating();
  const { data: overrides, isFetched: overridesFetched } = useConfigOverrides();
  const targetReady = usePosTargetReady();
  return (
    isFetched &&
    gatingFetched &&
    overridesFetched &&
    (!overridesTouch(overrides ?? [], "payment_method") || targetReady)
  );
}

/**
 * Precarga lo que define la pantalla de venta (diseño, overrides, modo
 * gastronómico y medios). Se llama al pasar o enfocar "Vender" y en idle.
 */
/** Callback estable para precargar el POS desde la navegación (hover / foco / idle). */
export function usePrefetchPos(): () => void {
  const qc = useQueryClient();
  return useCallback(() => prefetchPosBoot(qc), [qc]);
}

export function prefetchPosBoot(qc: QueryClient) {
  const opts = { staleTime: 60_000 };
  void qc.prefetchQuery({ queryKey: ["pos", "settings"], queryFn: () => posApi.posSettingsRaw(), ...opts });
  void qc.prefetchQuery({ queryKey: USER_LAYOUT_KEY, queryFn: loadPosLayoutPref, ...opts });
  void qc.prefetchQuery({ queryKey: ["config-overrides"], queryFn: configApi.overrides, ...opts });
  void qc.prefetchQuery({ queryKey: DINING_ENABLED_KEY, queryFn: fetchDiningEnabled, ...opts });
  void qc.prefetchQuery({
    queryKey: ["pos", "payment-methods-status"],
    queryFn: () => posApi.paymentMethodsStatus(),
    ...opts,
  });
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

// Medios con la configuración EFECTIVA de la sucursal y la caja del POS
// (F17 · H93, ADR-049): habilitado, recargo, modo de cuotas y n° de comercio
// pueden estar pisados por grupo, sucursal o caja. El servidor vuelve a mirar
// al cobrar (trigger de payments y Edges).
export function usePaymentMethodsStatus() {
  const q = useQuery({
    queryKey: ["pos", "payment-methods-status"],
    queryFn: () => posApi.paymentMethodsStatus(),
    staleTime: 60_000,
  });
  const { data: overrides } = useConfigOverrides();
  const target = usePosResolveTarget();
  const data = useMemo(
    () => (q.data ? effectiveProviderRows(q.data, overrides ?? [], target) : q.data),
    [q.data, overrides, target],
  );
  return { data, isFetched: q.isFetched, isLoading: q.isLoading };
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
