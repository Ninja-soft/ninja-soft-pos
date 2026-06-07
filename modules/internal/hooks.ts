"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  internalApi,
  type AuditFilters,
  type BillingRecordInput,
  type DiscountInput,
  type GrantAccessInput,
  type InviteCodeInput,
  type PlanLimits,
  type SavePlanInput,
  type SendNotificationInput,
} from "./api";

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

// ── H11c — Impersonation ──────────────────────────────────────────────────

export function useImpersonateTenant() {
  return useMutation({
    mutationFn: (tenantId: string) =>
      internalApi.generateImpersonateLink(tenantId),
  });
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
  const invTenants = () =>
    qc.invalidateQueries({ queryKey: ["internal", "tenants"] });
  return {
    add: useMutation({
      mutationFn: (input: BillingRecordInput) => internalApi.addBillingRecord(input),
      onSuccess: inv,
    }),
    extendTrial: useMutation({
      mutationFn: (days: number) => internalApi.extendTrial(tenantId, days),
      onSuccess: invTenants,
    }),
    setTrialEnd: useMutation({
      mutationFn: (vars: { endsAt: string; reason?: string | null }) =>
        internalApi.setTrialEnd(tenantId, vars.endsAt, vars.reason),
      onSuccess: invTenants,
    }),
    trialOutcome: useMutation({
      mutationFn: (vars: { outcome: "converted" | "lost"; reason?: string | null }) =>
        internalApi.trialOutcome(tenantId, vars.outcome, vars.reason),
      onSuccess: invTenants,
    }),
  };
}

export function usePlanPrices() {
  return useQuery({
    queryKey: ["internal", "plan-prices"],
    queryFn: () => internalApi.planPrices(),
    staleTime: 5 * 60 * 1000,
  });
}

// ── H12b — Planes custom, overrides y descuentos ────────────────────────────

export function useGlobalPlans() {
  return useQuery({
    queryKey: ["internal", "global-plans"],
    queryFn: () => internalApi.globalPlans(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useTenantPlanDetail(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "plan-detail", tenantId],
    queryFn: () => internalApi.tenantPlanDetail(tenantId),
  });
}

export function usePlanMutations(tenantId: string) {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["internal", "plan-detail", tenantId] });
    qc.invalidateQueries({ queryKey: ["internal", "tenants"] });
    qc.invalidateQueries({ queryKey: ["internal", "plan-prices"] });
  };
  return {
    clone: useMutation({
      mutationFn: (vars: {
        basePlanKey: string;
        name: string;
        monthlyPrice: number;
      }) =>
        internalApi.clonePlan(
          tenantId,
          vars.basePlanKey,
          vars.name,
          vars.monthlyPrice,
        ),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (vars: {
        planId: string;
        name: string;
        monthlyPrice: number;
        limits: PlanLimits;
        reason?: string | null;
      }) =>
        internalApi.updateCustomPlan(
          vars.planId,
          vars.name,
          vars.monthlyPrice,
          vars.limits,
          vars.reason,
        ),
      onSuccess: inv,
    }),
    setOverride: useMutation({
      mutationFn: (vars: {
        key: string;
        value: number | null;
        reason?: string | null;
      }) =>
        internalApi.setLimitOverride(
          tenantId,
          vars.key,
          vars.value,
          vars.reason,
        ),
      onSuccess: inv,
    }),
    grantAccess: useMutation({
      mutationFn: (input: GrantAccessInput) =>
        internalApi.grantAccess(tenantId, input),
      onSuccess: inv,
    }),
  };
}

// ── Fase C — Addons por tenant (ficha del tenant) ───────────────────────────

export function useTenantAddons(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "tenant-addons", tenantId],
    queryFn: () => internalApi.tenantAddons(tenantId),
  });
}

export function usePlanAddons() {
  return useQuery({
    queryKey: ["internal", "plan-addons"],
    queryFn: () => internalApi.planAddons(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetAddon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { addonKey: string; active: boolean }) =>
      internalApi.setAddon(tenantId, vars.addonKey, vars.active),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["internal", "tenant-addons", tenantId],
      }),
  });
}

// ── Fase C — Creador dinámico de planes (/internal/planes) ──────────────────

export function useFeatures() {
  return useQuery({
    queryKey: ["internal", "features"],
    queryFn: () => internalApi.features(),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePlansWithCounts() {
  return useQuery({
    queryKey: ["internal", "plans-with-counts"],
    queryFn: () => internalApi.listPlansWithCounts(),
  });
}

export function useSavePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SavePlanInput) => internalApi.savePlan(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "plans-with-counts"] });
      qc.invalidateQueries({ queryKey: ["internal", "global-plans"] });
      qc.invalidateQueries({ queryKey: ["internal", "plan-prices"] });
    },
  });
}

export function useInviteCodes() {
  return useQuery({
    queryKey: ["internal", "invite-codes"],
    queryFn: () => internalApi.listInviteCodes(),
  });
}

export function useInviteCodeMutations() {
  const qc = useQueryClient();
  const inv = () =>
    qc.invalidateQueries({ queryKey: ["internal", "invite-codes"] });
  return {
    create: useMutation({
      mutationFn: (input: InviteCodeInput) =>
        internalApi.createInviteCode(input),
      onSuccess: inv,
    }),
    setActive: useMutation({
      mutationFn: (vars: { id: string; active: boolean }) =>
        internalApi.setInviteCodeActive(vars.id, vars.active),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => internalApi.deleteInviteCode(id),
      onSuccess: inv,
    }),
  };
}

// ── H13b — Composer de notificaciones ───────────────────────────────────────

export function useSentNotifications() {
  return useQuery({
    queryKey: ["internal", "notifications"],
    queryFn: () => internalApi.listSentNotifications(),
  });
}

export function useSendNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendNotificationInput) =>
      internalApi.sendNotification(input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["internal", "notifications"] }),
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => internalApi.deleteNotification(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["internal", "notifications"] }),
  });
}

// ── Bitácora de envíos de email ─────────────────────────────────────────────

export function useSystemEmails() {
  return useQuery({
    queryKey: ["internal", "system-emails"],
    queryFn: () => internalApi.listSystemEmails(),
  });
}

export function useTenantDiscounts(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "discounts", tenantId],
    queryFn: () => internalApi.listDiscounts(tenantId),
  });
}

export function useDiscountMutations(tenantId: string) {
  const qc = useQueryClient();
  const inv = () =>
    qc.invalidateQueries({ queryKey: ["internal", "discounts", tenantId] });
  return {
    add: useMutation({
      mutationFn: (input: DiscountInput) =>
        internalApi.addDiscount(tenantId, input),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => internalApi.removeDiscount(id),
      onSuccess: inv,
    }),
  };
}
