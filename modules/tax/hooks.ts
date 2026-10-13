"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taxApi, type PreviewItem, type SaleTaxPreview, type TaxSettings } from "./api";

// Impuestos (ADR-068): datos fiscales, regímenes, padrones y vista previa.

const KEY = ["tax"] as const;

export function useTaxSettings(enabled = true) {
  return useQuery({ queryKey: [...KEY, "settings"], queryFn: taxApi.settings, enabled, staleTime: 5 * 60_000 });
}

export function useSaveTaxSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<TaxSettings>) => taxApi.saveSettings(p),
    onSuccess: (data) => qc.setQueryData([...KEY, "settings"], data),
  });
}

export function useTaxRegimes(enabled = true) {
  return useQuery({ queryKey: [...KEY, "regimes"], queryFn: taxApi.regimes, enabled });
}

export function useTaxRegimeMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, "regimes"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "settings"] });
  };
  return {
    save: useMutation({ mutationFn: taxApi.saveRegime, onSuccess: done }),
    remove: useMutation({ mutationFn: taxApi.deleteRegime, onSuccess: done }),
  };
}

export function usePadronImports(enabled = true) {
  return useQuery({ queryKey: [...KEY, "padrones"], queryFn: taxApi.padronImports, enabled });
}

export function usePadronLookup(cuit: string | null, enabled = true) {
  const d = (cuit ?? "").replace(/\D/g, "");
  return useQuery({
    queryKey: [...KEY, "padron-lookup", d],
    queryFn: () => taxApi.padronLookup(d),
    enabled: enabled && d.length === 11,
    staleTime: 5 * 60_000,
  });
}

export function useExemptions(party: "customer" | "supplier", partyId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "exemptions", party, partyId],
    queryFn: () => taxApi.exemptions(party, partyId!),
    enabled: enabled && Boolean(partyId),
  });
}

export function useExemptionMutations(party: "customer" | "supplier", partyId: string | null) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: [...KEY, "exemptions", party, partyId] });
  return {
    add: useMutation({ mutationFn: taxApi.addExemption, onSuccess: done }),
    remove: useMutation({ mutationFn: taxApi.removeExemption, onSuccess: done }),
  };
}

export function useSaleTaxLines(saleId: string | null) {
  return useQuery({
    queryKey: [...KEY, "sale-lines", saleId],
    queryFn: () => taxApi.saleTaxLines(saleId!),
    enabled: Boolean(saleId),
  });
}

export function useIvaReport(from: string, to: string, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "iva-report", from, to, storeId],
    queryFn: () => taxApi.ivaReport(from, to, storeId),
    enabled: enabled && Boolean(from && to),
  });
}

/**
 * Percepciones de la venta en curso (POS). Sólo consulta si el negocio es
 * agente y hay cliente: el resto de las ventas no cambia. Se recalcula cuando
 * cambian los ítems o el total (con una pequeña espera para no consultar en
 * cada tecla). El servidor vuelve a calcular al confirmar (create_sale).
 */
export function useSalePerceptions(args: {
  items: PreviewItem[];
  total: number;
  customerId: string | null;
  enabled: boolean;
}): { data: SaleTaxPreview | null; total: number; loading: boolean; error: boolean } {
  const settings = useTaxSettings(args.enabled);
  const active = args.enabled && Boolean(args.customerId) && Boolean(settings.data?.agent) && args.total > 0;
  const sig = useMemo(
    () => JSON.stringify([args.items, Math.round(args.total * 100), args.customerId]),
    [args.items, args.total, args.customerId],
  );
  const [debounced, setDebounced] = useState(sig);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(sig), 250);
    return () => clearTimeout(t);
  }, [sig]);
  const q = useQuery({
    queryKey: [...KEY, "preview", debounced],
    queryFn: () => taxApi.preview(args.items, args.total, args.customerId),
    enabled: active && debounced === sig,
    staleTime: 30_000,
  });
  if (!active) return { data: null, total: 0, loading: false, error: false };
  return {
    data: q.data ?? null,
    total: q.data ? Number(q.data.perception_total) || 0 : 0,
    loading: q.isFetching || debounced !== sig,
    error: Boolean(q.error),
  };
}
