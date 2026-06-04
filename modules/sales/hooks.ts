"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { salesApi, returnReasonsApi, type ReturnItemInput } from "./api";

export function useSales(range?: { from?: Date; to?: Date }) {
  return useQuery({
    queryKey: [
      "sales",
      "list",
      range?.from?.toISOString() ?? null,
      range?.to?.toISOString() ?? null,
    ],
    queryFn: () => salesApi.list(range),
  });
}

export function useSalesByNumber(n: number | null) {
  return useQuery({
    queryKey: ["sales", "by-number", n],
    enabled: n !== null && Number.isFinite(n),
    queryFn: () => salesApi.byNumber(n as number),
  });
}

export function useReturnsList() {
  return useQuery({
    queryKey: ["sales", "returns-list"],
    queryFn: () => salesApi.listReturns(),
  });
}

export function useSaleNumberFormat() {
  return useQuery({
    queryKey: ["sales", "number-format"],
    queryFn: () => salesApi.numberFormat(),
  });
}

export function useSaleDetail(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "detail", id],
    queryFn: () => salesApi.get(id!),
    enabled: enabled && Boolean(id),
  });
}

export function useVoidSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      salesApi.void(vars.id, vars.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useReturnReasons(activeOnly = true) {
  return useQuery({
    queryKey: ["return-reasons", activeOnly],
    queryFn: () => returnReasonsApi.list(activeOnly),
  });
}

export function useReturnReasonMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["return-reasons"] });
  return {
    create: useMutation({ mutationFn: (label: string) => returnReasonsApi.create(label), onSuccess: inv }),
    setActive: useMutation({
      mutationFn: (v: { id: string; is_active: boolean }) =>
        returnReasonsApi.setActive(v.id, v.is_active),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => returnReasonsApi.remove(id), onSuccess: inv }),
  };
}

export function useReturnSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      saleId: string;
      items: ReturnItemInput[];
      reason: string;
      refund: "cash" | "store_credit";
    }) => salesApi.return(vars.saleId, vars.items, vars.reason, vars.refund),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}
