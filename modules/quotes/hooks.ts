"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { quotesApi, type QuoteSaveInput, type QuoteSettings } from "./api";

export const QUOTES_KEY = ["quotes"] as const;

export function useQuotes(enabled = true) {
  return useQuery({ queryKey: [...QUOTES_KEY, "list"], queryFn: () => quotesApi.list(), enabled, staleTime: 15_000 });
}

export function useQuote(id: string | null) {
  return useQuery({
    queryKey: [...QUOTES_KEY, "one", id],
    queryFn: () => quotesApi.get(id!),
    enabled: Boolean(id),
  });
}

export function useQuoteRevisions(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...QUOTES_KEY, "revisions", id],
    queryFn: () => quotesApi.revisions(id!),
    enabled: Boolean(id) && enabled,
  });
}

export function useQuoteSettings(enabled = true) {
  return useQuery({ queryKey: [...QUOTES_KEY, "settings"], queryFn: () => quotesApi.settings(), enabled, staleTime: 60_000 });
}

export function useQuoteMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: QUOTES_KEY });
  return {
    save: useMutation({
      mutationFn: (v: { quote: QuoteSaveInput; items: Record<string, unknown>[] }) => quotesApi.save(v.quote, v.items),
      onSuccess: inv,
    }),
    setStatus: useMutation({
      mutationFn: (v: { id: string; status: "sent" | "accepted" | "rejected"; reason?: string | null }) =>
        quotesApi.setStatus(v.id, v.status, v.reason),
      onSuccess: inv,
    }),
    share: useMutation({ mutationFn: (id: string) => quotesApi.share(id), onSuccess: inv }),
    duplicate: useMutation({ mutationFn: (id: string) => quotesApi.duplicate(id), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => quotesApi.remove(id), onSuccess: inv }),
    linkSale: useMutation({
      mutationFn: (v: { id: string; saleId: string }) => quotesApi.linkSale(v.id, v.saleId),
      onSuccess: inv,
    }),
    saveSettings: useMutation({ mutationFn: (s: QuoteSettings) => quotesApi.saveSettings(s), onSuccess: inv }),
  };
}
