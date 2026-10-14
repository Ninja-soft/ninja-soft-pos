"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fiscalProfileApi, type ProfileInput } from "./api";

const KEY = ["fiscal-profile"] as const;

/** Datos de facturación del negocio actual (dueño o encargado). */
export function useMyBillingProfile() {
  return useQuery({ queryKey: [...KEY, "mine"], queryFn: fiscalProfileApi.mine, staleTime: 30_000, retry: false });
}

export function useSaveMyBillingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ProfileInput) => fiscalProfileApi.saveMine(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "mine"] }),
  });
}

export function usePadronLookup() {
  return useMutation({
    mutationFn: (v: { cuit: string; tenantId?: string; refresh?: boolean }) =>
      fiscalProfileApi.lookup(v.cuit, { tenantId: v.tenantId, refresh: v.refresh }),
  });
}

// --- Staff -----------------------------------------------------------------
export function useInternalBillingProfile(tenantId: string) {
  return useQuery({
    queryKey: [...KEY, "internal", tenantId],
    queryFn: () => fiscalProfileApi.internalGet(tenantId),
    enabled: Boolean(tenantId),
  });
}

export function useSaveInternalBillingProfile(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { p: ProfileInput; reason: string }) => fiscalProfileApi.internalSave(tenantId, v.p, v.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "internal", tenantId] });
      qc.invalidateQueries({ queryKey: [...KEY, "overview"] });
    },
  });
}

/** Resumen por negocio para el filtro "sin datos fiscales verificados". */
export function useBillingProfilesOverview(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "overview"],
    queryFn: async () => new Map((await fiscalProfileApi.overview()).map((r) => [r.tenant_id, r])),
    enabled,
    staleTime: 60_000,
  });
}

export function usePlatformIssuer() {
  return useQuery({ queryKey: [...KEY, "issuer"], queryFn: fiscalProfileApi.issuerGet });
}

export function useSavePlatformIssuer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { env: string; p: Record<string, unknown>; reason: string }) => fiscalProfileApi.issuerSave(v.env, v.p, v.reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
