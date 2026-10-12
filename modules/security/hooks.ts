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

// ── Mis PINes (ADR-060) ──────────────────────────────────────────────────────
export function useMyPins(enabled = true) {
  return useQuery({ queryKey: ["security", "my-pins"], queryFn: () => securityApi.myPins(), enabled });
}

/** Código rotativo vigente: se vuelve a pedir justo cuando cambia. */
export function useRotatingCode(enabled: boolean) {
  return useQuery({
    queryKey: ["security", "rotating-code"],
    queryFn: () => securityApi.rotatingCode(),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      const until = q.state.data?.valid_until;
      if (!until) return false;
      return Math.max(1_000, Math.min(new Date(until).getTime() - Date.now() + 1_500, 60 * 60_000));
    },
  });
}

export function useOneTimeList(enabled = true) {
  return useQuery({ queryKey: ["security", "one-time"], queryFn: () => securityApi.oneTimeList(), enabled });
}

export function useMyAuthHistory(enabled = true) {
  return useQuery({ queryKey: ["security", "my-history"], queryFn: () => securityApi.myHistory(), enabled });
}

export function useMyPinsMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["security"] });
  return {
    rotatingEnable: useMutation({ mutationFn: (regenerate: boolean) => securityApi.rotatingEnable(regenerate), onSuccess: inv }),
    rotatingDisable: useMutation({ mutationFn: () => securityApi.rotatingDisable(), onSuccess: inv }),
    totpBegin: useMutation({ mutationFn: (step: 30 | 60) => securityApi.totpBegin(step) }),
    totpConfirm: useMutation({ mutationFn: (code: string) => securityApi.totpConfirm(code), onSuccess: inv }),
    totpDisable: useMutation({ mutationFn: () => securityApi.totpDisable(), onSuccess: inv }),
    oneTimeCreate: useMutation({ mutationFn: securityApi.oneTimeCreate, onSuccess: inv }),
    oneTimeRevoke: useMutation({ mutationFn: (id: string) => securityApi.oneTimeRevoke(id), onSuccess: inv }),
    unlock: useMutation({ mutationFn: (userId: string) => securityApi.unlock(userId), onSuccess: inv }),
    resetMethods: useMutation({ mutationFn: (userId?: string | null) => securityApi.resetMethods(userId), onSuccess: inv }),
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
