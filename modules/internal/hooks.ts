"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { internalApi, type AuditFilters, type BillingRecordInput } from "./api";

export function useInternalTenants() {
  return useQuery({
    queryKey: ["internal", "tenants"],
    queryFn: () => internalApi.listTenants(),
  });
}

export function useFeatureFlagsCatalog() {
  return useQuery({
    queryKey: ["internal", "flags-catalog"],
    queryFn: () => internalApi.featureFlagsCatalog(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useFlagOverrides(flagKey: string | null) {
  return useQuery({
    queryKey: ["internal", "flag-overrides", flagKey],
    queryFn: () => internalApi.flagOverrides(flagKey as string),
    enabled: Boolean(flagKey),
  });
}

export function useTenantHealth() {
  return useQuery({
    queryKey: ["internal", "tenant-health"],
    queryFn: () => internalApi.tenantHealth(),
    staleTime: 60 * 1000,
  });
}

export function useInternalUsers() {
  return useQuery({
    queryKey: ["internal", "users"],
    queryFn: () => internalApi.listUsers(),
  });
}

export function useSetUserActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: string; active: boolean }) =>
      internalApi.setUserActive(vars.userId, vars.active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["internal", "users"] }),
  });
}

export function useTenantNotes(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "notes", tenantId],
    queryFn: () => internalApi.listNotes(tenantId),
  });
}

export function useTenantNoteMutations(tenantId: string) {
  const qc = useQueryClient();
  const inv = () =>
    qc.invalidateQueries({ queryKey: ["internal", "notes", tenantId] });
  return {
    add: useMutation({
      mutationFn: (body: string) => internalApi.addNote(tenantId, body),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (noteId: string) => internalApi.deleteNote(noteId),
      onSuccess: inv,
    }),
  };
}

export function useInternalAudit(filters: AuditFilters) {
  return useQuery({
    queryKey: ["internal", "audit", filters],
    queryFn: () => internalApi.listAudit(filters),
  });
}

export function useAuditEntityTypes() {
  return useQuery({
    queryKey: ["internal", "audit-entity-types"],
    queryFn: () => internalApi.auditEntityTypes(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useTenantFlags(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "flags", tenantId],
    queryFn: () => internalApi.tenantFlags(tenantId),
  });
}

export function useInternalMutations(tenantId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["internal", "tenants"] });
    qc.invalidateQueries({ queryKey: ["internal", "flags", tenantId] });
  };
  return {
    setPlan: useMutation({
      mutationFn: (planKey: string) => internalApi.setPlan(tenantId, planKey),
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: (status: string) => internalApi.setStatus(tenantId, status),
      onSuccess: invalidate,
    }),
    setFlag: useMutation({
      mutationFn: (vars: { flagKey: string; enabled: boolean }) =>
        internalApi.setFlag(tenantId, vars.flagKey, vars.enabled),
      onSuccess: invalidate,
    }),
    setIndustry: useMutation({
      mutationFn: (industry: string) =>
        internalApi.setIndustry(tenantId, industry),
      onSuccess: invalidate,
    }),
  };
}

// ── H12 — Billing ─────────────────────────────────────────────────────────

export function useBillingRecords(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "billing", tenantId],
    queryFn: () => internalApi.listBillingRecords(tenantId),
  });
}

export function useBillingMutations(tenantId: string) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["internal", "billing", tenantId] });
  return {
    add: useMutation({
      mutationFn: (input: BillingRecordInput) => internalApi.addBillingRecord(input),
      onSuccess: inv,
    }),
    extendTrial: useMutation({
      mutationFn: (days: number) => internalApi.extendTrial(tenantId, days),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["internal", "tenants"] }),
    }),
  };
}
