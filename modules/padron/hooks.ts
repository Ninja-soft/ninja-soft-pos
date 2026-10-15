"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { padronApi, type PadronConfigInput } from "./api";

const KEY = ["arca-padron"] as const;

/** ¿Se puede verificar en ARCA desde este negocio? (no falla: sin Edge, no disponible) */
export function usePadronStatus(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "status"],
    queryFn: async () => {
      try {
        return await padronApi.status();
      } catch {
        return { available: false, reason: "disabled", environment: null, cache_days: null } as const;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function usePadronLookup() {
  return useMutation({
    mutationFn: (v: { cuit: string; refresh?: boolean }) => padronApi.lookup(v.cuit, { refresh: v.refresh }),
  });
}

export function useInternalPadron(enabled = true) {
  return useQuery({ queryKey: [...KEY, "internal"], queryFn: padronApi.internalGet, enabled, refetchInterval: 60_000 });
}

export function useInternalPadronMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: [...KEY, "internal"] });
  return {
    save: useMutation({
      mutationFn: (v: { p: PadronConfigInput; reason: string }) => padronApi.internalSave(v.p, v.reason),
      onSuccess: (data) => qc.setQueryData([...KEY, "internal"], data),
    }),
    test: useMutation({ mutationFn: (cuit: string) => padronApi.internalTest(cuit), onSuccess: done }),
  };
}
