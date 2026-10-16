"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { accountingApi, type AccountInput, type EntryFilters, type ManualEntryInput, type AccSettings } from "./api";

/** Estado de acceso para la UI (la barrera real es el servidor). */
export function useAccountingAccess() {
  const feature = useFeature("contabilidad");
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  return {
    ready: feature !== undefined && me !== undefined,
    enabled: feature === true && canManage,
    locked: feature === false,
    forbidden: me !== undefined && !canManage,
    isOwner: me?.role === "owner",
  };
}

const K = ["accounting"] as const;

export function useAccSettings(enabled = true) {
  return useQuery({ queryKey: [...K, "settings"], queryFn: () => accountingApi.settings(), enabled });
}

export function useAccAccounts(enabled = true) {
  return useQuery({ queryKey: [...K, "accounts"], queryFn: () => accountingApi.accounts(), enabled, staleTime: 30_000 });
}

export function useCostCenters(enabled = true) {
  return useQuery({ queryKey: [...K, "cost-centers"], queryFn: () => accountingApi.costCenters(), enabled, staleTime: 30_000 });
}

export function useAccMappings(enabled = true) {
  return useQuery({ queryKey: [...K, "mappings"], queryFn: () => accountingApi.mappings(), enabled });
}

export function useAccEntries(f: EntryFilters, page: number, pageSize: number, enabled = true) {
  return useQuery({
    queryKey: [...K, "entries", f, page, pageSize],
    queryFn: () => accountingApi.entries(f, page, pageSize),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** Asientos de un documento ("Ver asiento", ADR-158). Se pide al abrir. */
export function useEntriesForSource(sourceType: string | null, sourceId: string | null) {
  return useQuery({
    queryKey: [...K, "for-source", sourceType, sourceId],
    queryFn: () => accountingApi.entriesForSource(sourceType!, sourceId!),
    enabled: Boolean(sourceType && sourceId),
  });
}

export function useEntryLines(entryId: string | null) {
  return useQuery({
    queryKey: [...K, "entry-lines", entryId],
    queryFn: () => accountingApi.entryLines(entryId!),
    enabled: Boolean(entryId),
  });
}

export function useJournal(f: { from: string; to: string; storeId?: string | null; accountId?: string | null }, enabled = true) {
  return useQuery({ queryKey: [...K, "journal", f], queryFn: () => accountingApi.journal(f), enabled });
}

export function useTrialBalance(f: { from: string; to: string; storeId?: string | null }, enabled = true) {
  return useQuery({ queryKey: [...K, "trial", f], queryFn: () => accountingApi.trialBalance(f), enabled });
}

export function useVatSales(f: { from: string; to: string }, enabled = true) {
  return useQuery({ queryKey: [...K, "vat-sales", f], queryFn: () => accountingApi.vatSales(f), enabled });
}

export function useVatPurchases(f: { from: string; to: string }, enabled = true) {
  return useQuery({ queryKey: [...K, "vat-purchases", f], queryFn: () => accountingApi.vatPurchases(f), enabled });
}

export function useAccPeriods(enabled = true) {
  return useQuery({ queryKey: [...K, "periods"], queryFn: () => accountingApi.periods(), enabled });
}

export function useAccIssues(enabled = true) {
  return useQuery({ queryKey: [...K, "issues"], queryFn: () => accountingApi.issues(), enabled });
}

export function useAccountingMutations() {
  const qc = useQueryClient();
  const inv = () => void qc.invalidateQueries({ queryKey: K });
  return {
    setup: useMutation({ mutationFn: accountingApi.setup, onSuccess: inv }),
    saveSettings: useMutation({ mutationFn: (p: Partial<AccSettings>) => accountingApi.saveSettings(p), onSuccess: inv }),
    saveAccount: useMutation({
      mutationFn: (v: { id: string | null; input: AccountInput }) => accountingApi.saveAccount(v.id, v.input),
      onSuccess: inv,
    }),
    deleteAccount: useMutation({ mutationFn: (id: string) => accountingApi.deleteAccount(id), onSuccess: inv }),
    saveCostCenter: useMutation({
      mutationFn: (v: { id: string | null; input: { code: string; name: string; store_id: string | null; is_active: boolean } }) =>
        accountingApi.saveCostCenter(v.id, v.input),
      onSuccess: inv,
    }),
    setMapping: useMutation({ mutationFn: accountingApi.setMapping, onSuccess: inv }),
    generate: useMutation({ mutationFn: accountingApi.generate, onSuccess: inv }),
    saveManual: useMutation({ mutationFn: (p: ManualEntryInput) => accountingApi.saveManual(p), onSuccess: inv }),
    reverse: useMutation({ mutationFn: accountingApi.reverse, onSuccess: inv }),
    closePeriod: useMutation({ mutationFn: accountingApi.closePeriod, onSuccess: inv }),
    reopenPeriod: useMutation({ mutationFn: accountingApi.reopenPeriod, onSuccess: inv }),
    retryIssue: useMutation({ mutationFn: (id: string) => accountingApi.retryIssue(id), onSuccess: inv }),
    dismissIssue: useMutation({ mutationFn: (id: string) => accountingApi.dismissIssue(id), onSuccess: inv }),
  };
}
