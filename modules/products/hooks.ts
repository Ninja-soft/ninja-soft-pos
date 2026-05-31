"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { categoriesApi, productsApi } from "./api";
import type { CategoryInput, ProductOutput, StockAdjustInput } from "./schemas";

export function useProducts(search: string) {
  return useQuery({
    queryKey: ["products", "list", search],
    queryFn: () => productsApi.list(search),
  });
}

export function useTopProducts(enabled: boolean, limit = 12) {
  return useQuery({
    queryKey: ["products", "top", limit],
    queryFn: () => productsApi.top(limit),
    enabled,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ["categories", "list"],
    queryFn: () => categoriesApi.list(),
  });
}

export function useStockMovements(productId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "movements", productId],
    queryFn: () => productsApi.movements(productId!),
    enabled: enabled && Boolean(productId),
  });
}

export function useProductMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["products"] });

  return {
    create: useMutation({
      mutationFn: (input: ProductOutput) => productsApi.create(input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (vars: { id: string; input: ProductOutput }) =>
        productsApi.update(vars.id, vars.input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => productsApi.softDelete(id),
      onSuccess: invalidate,
    }),
    adjust: useMutation({
      mutationFn: (vars: { id: string; input: StockAdjustInput }) =>
        productsApi.adjustStock(vars.id, vars.input),
      onSuccess: invalidate,
    }),
  };
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CategoryInput) => categoriesApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });
}
