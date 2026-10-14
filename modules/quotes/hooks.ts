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

/** Envíos por email del presupuesto (ADR-123). */
export function useQuoteEmails(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...QUOTES_KEY, "emails", id],
    queryFn: () => quotesApi.emails(id!),
    enabled: Boolean(id) && enabled,
  });
}

/** Contacto de la ficha del cliente (ADR-123). */
export function useQuoteCustomerContact(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...QUOTES_KEY, "customer-contact", id],
    queryFn: () => quotesApi.customerContact(id!),
    enabled: Boolean(id) && enabled,
    staleTime: 30_000,
  });
}

/** Presupuestos por emisor en el período (ADR-123). */
export function useQuoteIssuerReport(fromISO: string, toISO: string, enabled = true) {
  return useQuery({
    queryKey: [...QUOTES_KEY, "issuers", fromISO, toISO],
    queryFn: () => quotesApi.issuerReport(fromISO, toISO),
    enabled,
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
    sendEmail: useMutation({ mutationFn: quotesApi.sendEmail, onSuccess: inv }),
    saveSettings: useMutation({ mutationFn: (s: QuoteSettings) => quotesApi.saveSettings(s), onSuccess: inv }),
  };
}
