"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { opsApi, type SegmentSendInput } from "./opsApi";
import type { MemberRole } from "@/supabase/functions/_shared/tenantMembers";

export function useTenantImpersonations(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "impersonations", tenantId],
    queryFn: () => opsApi.listImpersonations(tenantId),
  });
}

export function useEndImpersonation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => opsApi.endImpersonation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "impersonations", tenantId] });
      qc.invalidateQueries({ queryKey: ["internal", "audit"] });
    },
  });
}

export function useTenantMembers(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "members", tenantId],
    queryFn: () => opsApi.listMembers(tenantId),
  });
}

export function useTenantMemberMutations(tenantId: string) {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["internal", "members", tenantId] });
    qc.invalidateQueries({ queryKey: ["internal", "tenant-360", tenantId] });
    qc.invalidateQueries({ queryKey: ["internal", "audit"] });
  };
  return {
    admin: useMutation({
      mutationFn: (v: {
        userId: string;
        action: "set_role" | "suspend" | "reactivate";
        role?: MemberRole | null;
        reason: string;
      }) => opsApi.memberAdmin({ tenantId, ...v }),
      onSuccess: inv,
    }),
    invite: useMutation({
      mutationFn: (v: { email: string; role: MemberRole; displayName: string; reason: string }) =>
        opsApi.inviteMember({ tenantId, ...v }),
      onSuccess: inv,
    }),
    edge: useMutation({
      mutationFn: (v: { userId: string; action: "resend_invite" | "reset_access"; reason: string }) =>
        opsApi.memberEdgeAction({ tenantId, ...v }),
      onSuccess: inv,
    }),
  };
}

export function useTenant360(tenantId: string) {
  return useQuery({
    queryKey: ["internal", "tenant-360", tenantId],
    queryFn: () => opsApi.tenant360(tenantId),
    staleTime: 60 * 1000,
  });
}

export function useNotifySegment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SegmentSendInput) => opsApi.notifySegment(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["internal", "notifications"] }),
  });
}

export function useDeleteNotificationBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) => opsApi.deleteNotificationBatch(batchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["internal", "notifications"] }),
  });
}
