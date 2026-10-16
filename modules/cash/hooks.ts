"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { cashApi } from "./api";

export function useShiftMovements(shiftId: string | null) {
  return useQuery({
    queryKey: ["cash", "movements", shiftId],
    queryFn: () => cashApi.movements(shiftId!),
    enabled: Boolean(shiftId),
  });
}

export function useZClosures(
  range?: { from?: Date; to?: Date },
  storeId?: string | null,
  registerId?: string | null,
) {
  return useQuery({
    queryKey: [
      "cash",
      "z-closures",
      range?.from?.toISOString() ?? null,
      range?.to?.toISOString() ?? null,
      storeId ?? null,
      registerId ?? null,
    ],
    queryFn: () => cashApi.zClosures(range, storeId, registerId),
  });
}

export function useCashMonitor(storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["cash", "monitor", storeId],
    queryFn: () => cashApi.monitor(storeId),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

// Vista general de sucursales del monitor (ADR-057). Mismo refresco que el monitor.
export function useBranchOverview(enabled = true) {
  return useQuery({
    queryKey: ["cash", "branch-overview"],
    queryFn: () => cashApi.branchOverview(),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useForceClose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { shiftId: string; closing: number; reason: string }) =>
      cashApi.forceClose(v.shiftId, v.closing, v.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cash"] });
      qc.invalidateQueries({ queryKey: ["pos"] });
      qc.invalidateQueries({ queryKey: ["owner-stats"] });
    },
  });
}

export function useAddMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      shiftId: string;
      type: "income" | "expense";
      amount: number;
      reason: string;
    }) => cashApi.addMovement(vars.shiftId, vars.type, vars.amount, vars.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cash", "movements"] }),
  });
}

export function useReviewZ() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; kind: string; reason: string }) => cashApi.reviewZ(v.id, v.kind, v.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cash", "z-closures"] }),
  });
}
