"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { internalApi, type AuditFilters } from "./api";

export function useInternalTenants() {
  return useQuery({
    queryKey: ["internal", "tenants"],
    queryFn: () => internalApi.listTenants(),
  });
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
