"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shippingApi, type ShipmentFilters } from "./api";

const KEY = ["shipping"] as const;

export function useShippingProviders() {
  return useQuery({ queryKey: [...KEY, "providers"], queryFn: () => shippingApi.providers(), staleTime: 10 * 60_000, retry: 1 });
}

export function useShippingConnections(enabled = true) {
  return useQuery({ queryKey: [...KEY, "connections"], queryFn: () => shippingApi.connections(), enabled, retry: 1 });
}

export function useEffectiveCarriers(storeId: string | null) {
  return useQuery({
    queryKey: [...KEY, "effective", storeId],
    queryFn: () => shippingApi.effective(storeId!),
    enabled: Boolean(storeId),
  });
}

/** Lista con sondeo: cada 20 s si hay envíos generándose, cada 2 min si no. */
export function useShipments(f: ShipmentFilters) {
  return useQuery({
    queryKey: [...KEY, "list", f],
    queryFn: () => shippingApi.list(f),
    refetchInterval: (q) => {
      const rows = q.state.data ?? [];
      return rows.some((s) => s.status === "pending" || (s.status === "created" && !s.label_path)) ? 20_000 : 120_000;
    },
  });
}

export function useShipment(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "one", id],
    queryFn: () => shippingApi.get(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 5_000 : false),
  });
}

export function useShipmentEvents(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "events", id],
    queryFn: () => shippingApi.events(id!),
    enabled: Boolean(id),
  });
}

export function useShippingMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    create: useMutation({ mutationFn: shippingApi.create, onSuccess: invalidate }),
    submit: useMutation({
      mutationFn: (v: Parameters<typeof shippingApi.submit>) => shippingApi.submit(...v),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (v: { id: string; reason: string; local: boolean }) => shippingApi.cancel(v.id, v.reason, v.local),
      onSuccess: invalidate,
    }),
    retry: useMutation({
      mutationFn: (v: { id: string; force: boolean }) => shippingApi.retry(v.id, v.force),
      onSuccess: invalidate,
    }),
    process: useMutation({ mutationFn: shippingApi.process, onSettled: invalidate }),
    track: useMutation({ mutationFn: shippingApi.track, onSettled: invalidate }),
    saveConnection: useMutation({ mutationFn: shippingApi.saveConnection, onSuccess: invalidate }),
    deleteConnection: useMutation({ mutationFn: shippingApi.deleteConnection, onSuccess: invalidate }),
    testConnection: useMutation({ mutationFn: shippingApi.testConnection, onSettled: invalidate }),
  };
}
