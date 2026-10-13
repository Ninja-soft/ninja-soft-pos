"use client";

import { useBranchContext } from "@/modules/branches/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { useFeature } from "@/modules/saas/gating";
import type { TransferSettings } from "@/lib/stock/transfers";
import {
  stockApi,
  type ReceiveLine,
  type TransferFilters,
  type TransferSaveInput,
} from "./api";

export function useStores() {
  return useQuery({
    queryKey: ["stock-stores"],
    queryFn: () => stockApi.stores(),
    staleTime: 60_000,
  });
}

/**
 * ¿Mostrar el stock por sucursal? Sólo con 2+ sucursales y la feature en el
 * plan. Con una sola sucursal la UI queda como siempre.
 */
export function useMultiStoreStock() {
  const { data: stores } = useStores();
  const enabled = useFeature("stock_sucursales");
  const multi = (stores?.length ?? 0) > 1;
  return {
    stores: stores ?? [],
    multi,
    enabled: multi && enabled === true,
    /** La feature falta pero hay varias sucursales (mostrar el upsell). */
    locked: multi && enabled === false,
  };
}

/** Sucursal "actual" del usuario, desde el contexto de sucursal (F17 · H90). */
export function useCurrentStoreId(): string | null {
  const { data: stores } = useStores();
  // Contexto de sucursal (H90): la elegida en el panel o, con "Todas", la del
  // POS; si el contexto todavía no cargó, la sucursal por defecto.
  const ctx = useBranchContext();
  return (
    ctx.filterStoreId ??
    ctx.posStoreId ??
    stores?.find((s) => s.is_default)?.id ??
    stores?.[0]?.id ??
    null
  );
}

export function useCurrentUserId() {
  return useQuery({
    queryKey: ["current-user-id"],
    queryFn: async () => (await getCurrentUser())?.id ?? null,
    staleTime: 5 * 60_000,
  });
}

export function useStockByStore(productIds: string[], enabled = true) {
  const ids = [...new Set(productIds)].sort();
  return useQuery({
    queryKey: ["products", "stock-by-store", ids],
    queryFn: () => stockApi.byStore(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 15_000,
  });
}

export function useLowStockByStore(enabled = true) {
  return useQuery({
    queryKey: ["products", "stock-low-by-store"],
    queryFn: () => stockApi.lowByStore(),
    enabled,
  });
}

function useInvalidateStock() {
  const qc = useQueryClient();
  return () => {
    // Incluye stock por sucursal, faltantes y movimientos (todos cuelgan de "products").
    void qc.invalidateQueries({ queryKey: ["products"] });
    void qc.invalidateQueries({ queryKey: ["stock-transfers"] });
    void qc.invalidateQueries({ queryKey: ["stock-transfer"] });
  };
}

export function useStoreStockMutations() {
  const inv = useInvalidateStock();
  return {
    adjust: useMutation({ mutationFn: stockApi.adjust, onSuccess: inv }),
    saveSettings: useMutation({
      mutationFn: stockApi.saveSettings,
      onSuccess: inv,
    }),
  };
}

export function useTransfers(filters: TransferFilters, enabled = true) {
  return useQuery({
    queryKey: ["stock-transfers", filters],
    queryFn: () => stockApi.listTransfers(filters),
    enabled,
  });
}

// Artículos en tránsito (F17 · H95). Cuelga de ["stock-transfers"] para que
// despachar o recibir lo refresque.
export function useInTransitLines(enabled = true) {
  return useQuery({
    queryKey: ["stock-transfers", "in-transit-lines"],
    queryFn: () => stockApi.inTransitLines(),
    enabled,
  });
}

export function useTransfer(id: string | null) {
  return useQuery({
    queryKey: ["stock-transfer", id],
    queryFn: () => stockApi.getTransfer(id!),
    enabled: Boolean(id),
  });
}

export function useTransferSettings(enabled = true) {
  return useQuery({
    queryKey: ["stock-transfer-settings"],
    queryFn: () => stockApi.settings(),
    enabled,
    staleTime: 60_000,
  });
}

export function useTransferMutations() {
  const qc = useQueryClient();
  const inv = useInvalidateStock();
  return {
    save: useMutation({
      mutationFn: (v: TransferSaveInput) => stockApi.saveTransfer(v),
      onSuccess: inv,
    }),
    submit: useMutation({
      mutationFn: (id: string) => stockApi.submit(id),
      onSuccess: inv,
    }),
    approve: useMutation({
      mutationFn: (v: { id: string; notes?: string | null }) =>
        stockApi.approve(v.id, v.notes),
      onSuccess: inv,
    }),
    reject: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        stockApi.reject(v.id, v.reason),
      onSuccess: inv,
    }),
    reschedule: useMutation({
      mutationFn: (v: { id: string; date: string | null }) =>
        stockApi.reschedule(v.id, v.date),
      onSuccess: inv,
    }),
    dispatch: useMutation({
      mutationFn: (v: {
        id: string;
        items?: Array<{ item_id: string; qty: number }> | null;
        notes?: string | null;
      }) => stockApi.dispatch(v.id, v.items, v.notes),
      onSuccess: inv,
    }),
    receive: useMutation({
      mutationFn: (v: {
        id: string;
        items: ReceiveLine[];
        close: boolean;
        notes?: string | null;
      }) => stockApi.receive(v.id, v.items, v.close, v.notes),
      onSuccess: inv,
    }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason: string }) =>
        stockApi.cancel(v.id, v.reason),
      onSuccess: inv,
    }),
    saveSettings: useMutation({
      mutationFn: (v: { tenantId: string; settings: TransferSettings }) =>
        stockApi.saveTransferSettings(v.tenantId, v.settings),
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: ["stock-transfer-settings"] }),
    }),
  };
}
