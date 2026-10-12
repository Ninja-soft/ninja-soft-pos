"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SecuritySettings } from "@/lib/security/pinPolicy";
import { securityApi, type AuditFilters } from "./api";

export function useSecuritySettings() {
  return useQuery({ queryKey: ["security", "settings"], queryFn: () => securityApi.settings(), staleTime: 60_000 });
}

export function useSaveSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<SecuritySettings>) => securityApi.saveSettings(patch),
    onSuccess: (s) => {
      qc.setQueryData(["security", "settings"], s);
      qc.invalidateQueries({ queryKey: ["security", "supervisors"] });
    },
  });
}

export function usePinStatus() {
  return useQuery({ queryKey: ["security", "pin"], queryFn: () => securityApi.pinStatus() });
}

export function useSupervisors(enabled = true) {
  return useQuery({ queryKey: ["security", "supervisors"], queryFn: () => securityApi.supervisors(), enabled });
}

export function usePinMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["security"] });
  return {
    setPin: useMutation({ mutationFn: (pin: string) => securityApi.setPin(pin), onSuccess: inv }),
    clearPin: useMutation({ mutationFn: (userId?: string | null) => securityApi.clearPin(userId), onSuccess: inv }),
  };
}

export function useAuditSearch(f: AuditFilters, enabled = true) {
  return useQuery({
    queryKey: ["security", "audit", f],
    queryFn: () => securityApi.auditSearch(f),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useAuditFacets(enabled = true) {
  return useQuery({ queryKey: ["security", "audit-facets"], queryFn: () => securityApi.auditFacets(), enabled, staleTime: 5 * 60_000 });
}
