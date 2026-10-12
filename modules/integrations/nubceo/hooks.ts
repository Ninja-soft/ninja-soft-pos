"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import type { LedgerHeaderInput } from "@/lib/integrations/nubceo/ledgerCsv";
import { nubceoApi, type MonitorFilters, type NubceoEnv } from "./api";

const KEY = ["nubceo"] as const;

/** Estado de la feature para la UI (la barrera real es el servidor). */
export function useNubceoAccess() {
  const f = useFeature("integracion_nubceo");
  return { ready: f !== undefined, enabled: f === true, locked: f === false };
}

export function useNubceoConfig(enabled = true) {
  return useQuery({ queryKey: [...KEY, "config"], queryFn: () => nubceoApi.config(), enabled });
}

export function useNubceoMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({ mutationFn: (p: Record<string, unknown>) => nubceoApi.saveSettings(p), onSuccess: invalidate }),
    setCredentials: useMutation({
      mutationFn: (v: Parameters<typeof nubceoApi.setCredentials>[0]) => nubceoApi.setCredentials(v),
      onSuccess: invalidate,
    }),
    clearCredentials: useMutation({ mutationFn: (env: NubceoEnv) => nubceoApi.clearCredentials(env), onSuccess: invalidate }),
    test: useMutation({ mutationFn: (env: NubceoEnv) => nubceoApi.testConnection(env), onSuccess: invalidate }),
    runNow: useMutation({ mutationFn: () => nubceoApi.runNow(), onSuccess: invalidate }),
    retry: useMutation({ mutationFn: (ids: string[]) => nubceoApi.retry(ids), onSuccess: invalidate }),
    retryBulk: useMutation({
      mutationFn: (v: { status: "error" | "simulated"; from: string; to: string }) => nubceoApi.retryBulk(v.status, v.from, v.to),
      onSuccess: invalidate,
    }),
    exclude: useMutation({
      mutationFn: (v: { ids: string[]; reason: string }) => nubceoApi.exclude(v.ids, v.reason),
      onSuccess: invalidate,
    }),
    requestDelete: useMutation({
      mutationFn: (v: { ids: string[]; reason: string }) => nubceoApi.requestDelete(v.ids, v.reason),
      onSuccess: invalidate,
    }),
    ledgerImportApi: useMutation({ mutationFn: (since: string | null) => nubceoApi.ledgerImportApi(since), onSuccess: invalidate }),
    ledgerImportCsv: useMutation({
      mutationFn: (headers: LedgerHeaderInput[]) => nubceoApi.ledgerImportCsv(headers),
      onSuccess: invalidate,
    }),
    ledgerStatus: useMutation({
      mutationFn: (v: { ids: string[]; status: "confirmed" | "not_confirmed" }) => nubceoApi.ledgerStatus(v.ids, v.status),
      onSuccess: invalidate,
    }),
  };
}

export function useNubceoSync(f: MonitorFilters, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "sync", f],
    queryFn: () => nubceoApi.list(f),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useNubceoCounts(from: string, to: string, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "counts", from, to, storeId],
    queryFn: () => nubceoApi.counts(from, to, storeId),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useNubceoDaily(fromDay: string, toDay: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "daily", fromDay, toDay],
    queryFn: () => nubceoApi.daily(fromDay, toDay),
    enabled,
  });
}

export function useNubceoRuns(enabled = true) {
  return useQuery({ queryKey: [...KEY, "runs"], queryFn: () => nubceoApi.runs(), enabled, refetchInterval: 60_000 });
}

export function useNubceoPreview(syncId: string | null) {
  return useQuery({
    queryKey: [...KEY, "preview", syncId],
    queryFn: () => nubceoApi.preview(syncId as string),
    enabled: Boolean(syncId),
    retry: false,
  });
}

export function useNubceoLedger(f: { from: string; to: string; status: "all" | "confirmed" | "not_confirmed" }, enabled = true) {
  return useQuery({ queryKey: [...KEY, "ledger", f], queryFn: () => nubceoApi.ledger(f), enabled, placeholderData: keepPreviousData });
}
