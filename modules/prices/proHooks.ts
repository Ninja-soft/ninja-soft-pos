"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resolvePrice, resolveUnitPrice, type PriceResolution } from "@/lib/prices/resolve";
import { usePricingContext } from "@/lib/prices/pricingContext";
import { priceProApi, type BulkRequest, type BulkV2Request, type FxSource, type ProListInput } from "./proApi";
import { useMostradorPricing } from "./hooks";

const KEY = ["price-pro"] as const;

export function usePriceSettings() {
  return useQuery({ queryKey: [...KEY, "settings"], queryFn: () => priceProApi.settings(), staleTime: 30_000 });
}

export function usePriceProLists() {
  return useQuery({ queryKey: ["price-lists", "pro"], queryFn: () => priceProApi.lists() });
}

export function usePaymentTerms(enabled = true) {
  return useQuery({ queryKey: [...KEY, "terms"], queryFn: () => priceProApi.terms(), enabled });
}

export function usePriceAssignments() {
  return useQuery({ queryKey: [...KEY, "assignments"], queryFn: () => priceProApi.assignments() });
}

export function useListBreaks(listId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "breaks", listId],
    queryFn: () => priceProApi.breaks(listId!),
    enabled: enabled && Boolean(listId),
  });
}

export function useFxRates(enabled = true) {
  return useQuery({ queryKey: [...KEY, "fx"], queryFn: () => priceProApi.fxRates(), enabled });
}

export function useIndexValues(enabled = true) {
  return useQuery({ queryKey: [...KEY, "index"], queryFn: () => priceProApi.indexValues(), enabled });
}

export function usePriceBatches() {
  return useQuery({ queryKey: [...KEY, "batches"], queryFn: () => priceProApi.batches() });
}

/** ADR-140: dólar del día o la última anterior (negocio o plataforma). */
export function useFxQuote(source: FxSource = "oficial", enabled = true) {
  return useQuery({
    queryKey: [...KEY, "fx-quote", source],
    queryFn: () => priceProApi.fxQuote(source),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useFxRules(enabled = true) {
  return useQuery({ queryKey: [...KEY, "fx-rules"], queryFn: () => priceProApi.fxRules(), enabled });
}

export function useBatchLines(batchId: string | null) {
  return useQuery({
    queryKey: [...KEY, "batch-lines", batchId],
    queryFn: () => priceProApi.bulkLines(batchId!),
    enabled: Boolean(batchId),
  });
}

export function useUpcomingPrices(enabled = true) {
  return useQuery({ queryKey: [...KEY, "upcoming"], queryFn: () => priceProApi.upcoming(), enabled });
}

export function useProductPricesOverview(productId: string | null) {
  return useQuery({
    queryKey: [...KEY, "overview", productId],
    queryFn: () => priceProApi.productOverview(productId!),
    enabled: Boolean(productId),
  });
}

export function useLabelQueue(storeId: string | null) {
  return useQuery({ queryKey: [...KEY, "labels", storeId], queryFn: () => priceProApi.labelQueue(storeId) });
}

/** Consolida los precios programados vencidos una vez al montar (POS, Etiquetas, Precios). */
export function useApplyDuePrices() {
  const qc = useQueryClient();
  useEffect(() => {
    let alive = true;
    void priceProApi.applyDue().then((n) => {
      if (alive && n > 0) {
        void qc.invalidateQueries({ queryKey: ["products"] });
        void qc.invalidateQueries({ queryKey: ["price-lists"] });
        void qc.invalidateQueries({ queryKey: KEY });
      }
    });
    return () => {
      alive = false;
    };
  }, [qc]);
}

export function usePriceProMutations() {
  const qc = useQueryClient();
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ["price-lists"] });
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const invProducts = () => {
    inv();
    void qc.invalidateQueries({ queryKey: ["products"] });
    void qc.invalidateQueries({ queryKey: ["price-list-items"] });
  };
  return {
    saveSettings: useMutation({ mutationFn: priceProApi.saveSettings, onSuccess: inv }),
    createList: useMutation({ mutationFn: (i: ProListInput) => priceProApi.createList(i), onSuccess: inv }),
    updateList: useMutation({
      mutationFn: (v: { id: string; patch: Parameters<typeof priceProApi.updateList>[1] }) =>
        priceProApi.updateList(v.id, v.patch),
      onSuccess: inv,
    }),
    setAssignment: useMutation({
      mutationFn: (v: { scope: Parameters<typeof priceProApi.setAssignment>[0]; scopeId: string; listId: string | null }) =>
        priceProApi.setAssignment(v.scope, v.scopeId, v.listId),
      onSuccess: inv,
    }),
    addBreak: useMutation({ mutationFn: priceProApi.addBreak, onSuccess: inv }),
    removeBreak: useMutation({ mutationFn: priceProApi.removeBreak, onSuccess: inv }),
    saveTerm: useMutation({ mutationFn: priceProApi.saveTerm, onSuccess: inv }),
    removeTerm: useMutation({ mutationFn: priceProApi.removeTerm, onSuccess: inv }),
    setCustomerTerm: useMutation({
      mutationFn: (v: { customerId: string; termId: string | null }) => priceProApi.setCustomerTerm(v.customerId, v.termId),
      onSuccess: () => {
        inv();
        void qc.invalidateQueries({ queryKey: ["customers"] });
      },
    }),
    saveFx: useMutation({ mutationFn: priceProApi.saveFxRate, onSuccess: inv }),
    saveIndex: useMutation({ mutationFn: priceProApi.saveIndexValue, onSuccess: inv }),
    bulkCreate: useMutation({ mutationFn: (p: BulkRequest) => priceProApi.bulkCreate(p), onSuccess: invProducts }),
    bulkV2Create: useMutation({ mutationFn: (p: BulkV2Request) => priceProApi.bulkV2Create(p), onSuccess: invProducts }),
    saveFxRule: useMutation({ mutationFn: priceProApi.saveFxRule, onSuccess: inv }),
    deleteFxRule: useMutation({ mutationFn: (id: string) => priceProApi.deleteFxRule(id), onSuccess: inv }),
    bulkDecide: useMutation({
      mutationFn: (v: { id: string; approve: boolean; note?: string }) => priceProApi.bulkDecide(v.id, v.approve, v.note),
      onSuccess: invProducts,
    }),
    bulkRevert: useMutation({ mutationFn: (id: string) => priceProApi.bulkRevert(id), onSuccess: invProducts }),
    scheduleSet: useMutation({ mutationFn: priceProApi.scheduleSet, onSuccess: invProducts }),
    scheduleCancel: useMutation({ mutationFn: priceProApi.scheduleCancel, onSuccess: invProducts }),
    importList: useMutation({
      mutationFn: (v: { listId: string | null; rows: Parameters<typeof priceProApi.importList>[1] }) =>
        priceProApi.importList(v.listId, v.rows),
      onSuccess: invProducts,
    }),
    markPrinted: useMutation({ mutationFn: (ids: string[]) => priceProApi.markPrinted(ids), onSuccess: inv }),
  };
}

export interface PriceForArgs {
  productId: string;
  variantId?: string | null;
  basePrice: number;
  variantPrice?: number | null;
  qty?: number;
  /** Pisa la condición elegida (para mostrar el precio por plazo). */
  termId?: string | null;
}

/**
 * Resolver de precios del navegador, igual al del servidor. Usa la foto de
 * `price_context_snapshot` (sucursal + cliente) y la lista / condición elegidas
 * en el POS. Contra una base sin la migración cae a la lista mostrador (H10).
 */
export function usePriceResolver({
  storeId,
  customerId,
  enabled = true,
}: {
  storeId: string | null;
  customerId: string | null;
  enabled?: boolean;
}) {
  const listId = usePricingContext((s) => s.listId);
  const termId = usePricingContext((s) => s.termId);
  const snap = useQuery({
    queryKey: [...KEY, "snapshot", storeId, customerId],
    queryFn: () => priceProApi.snapshot(storeId, customerId),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  // La lista mostrador (lista + todos sus items, dos consultas en serie) sólo
  // hace falta si la foto no llega (base sin la migración o error): antes se
  // bajaba siempre, en paralelo con la foto.
  const legacy = useMostradorPricing((snap.isFetched || snap.failureCount > 0) && !snap.data);
  const world = snap.data ?? null;

  const resolve = useCallback(
    (a: PriceForArgs): PriceResolution => {
      if (world) {
        return resolveUnitPrice(world, {
          productId: a.productId,
          variantId: a.variantId ?? null,
          basePrice: a.basePrice,
          variantPrice: a.variantPrice ?? null,
          qty: a.qty ?? 1,
          selectedListId: listId,
          termId: a.termId !== undefined ? a.termId : termId,
        });
      }
      // La base de los productos con variante ya viene con el override aplicado.
      const base = a.variantPrice ?? a.basePrice;
      return {
        price: resolvePrice(base, a.productId, a.variantId ?? null, legacy.data?.list ?? null, legacy.data?.items ?? []),
        listId: legacy.data?.list?.id ?? null,
        termId: null,
      };
    },
    [world, listId, termId, legacy.data],
  );

  const priceFor = useCallback((a: PriceForArgs) => resolve(a).price, [resolve]);

  const selectable = useMemo(() => (world?.lists ?? []).filter((l) => l.pos_selectable && l.is_active), [world]);

  return {
    world,
    ready: !snap.isLoading,
    pro: world?.pro ?? false,
    terms: world?.terms ?? [],
    selectable,
    listId,
    termId,
    resolve,
    priceFor,
  };
}
