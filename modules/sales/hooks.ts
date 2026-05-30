"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { salesApi } from "./api";

export function useSales() {
  return useQuery({ queryKey: ["sales", "list"], queryFn: () => salesApi.list() });
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
