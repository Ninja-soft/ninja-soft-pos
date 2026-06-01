"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  brandsApi,
  categoriesApi,
  productsApi,
  serialsApi,
  warrantyPlansApi,
} from "./api";
import type { CategoryInput, ProductOutput, StockAdjustInput } from "./schemas";

export function useWarrantyPlans(activeOnly = false) {
  return useQuery({
    queryKey: ["warranty-plans", activeOnly],
    queryFn: () => warrantyPlansApi.list(activeOnly),
  });
}

export function useWarrantyPlanMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["warranty-plans"] });
  return {
    create: useMutation({
      mutationFn: (v: {
        label: string;
        months: number;
        price: number;
        price_pct: number;
        commission_pct: number;
        description: string | null;
      }) => warrantyPlansApi.create(v),
      onSuccess: inv,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; is_active: boolean }) =>
        warrantyPlansApi.setActive(v.id, v.is_active),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => warrantyPlansApi.remove(id), onSuccess: inv }),
  };
}

export function useProducts(search: string, categoryId?: string | null) {
  return useQuery({
    queryKey: ["products", "list", search, categoryId ?? null],
    queryFn: () => productsApi.list(search, categoryId),
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

export function useKitComponents(kitId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "kit", kitId],
    queryFn: () => productsApi.kitComponents(kitId!),
    enabled: enabled && Boolean(kitId),
  });
}

export function useSaveKitComponents(kitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (components: { componentProductId: string; quantity: number }[]) =>
      productsApi.saveKitComponents(kitId, components),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products", "kit", kitId] }),
  });
}

export function useProductSerials(productId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "serials", productId],
    queryFn: () => serialsApi.list(productId!),
    enabled: enabled && Boolean(productId),
  });
}

export function useSerialMutations(productId: string) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["products", "serials", productId] });
  return {
    add: useMutation({
      mutationFn: (serials: string[]) => serialsApi.add(productId, serials),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => serialsApi.remove(id),
      onSuccess: invalidate,
    }),
  };
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

export function useCategoryMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["categories"] });
  return {
    create: useMutation({
      mutationFn: (input: CategoryInput) => categoriesApi.create(input),
      onSuccess: invalidate,
    }),
    rename: useMutation({
      mutationFn: (vars: { id: string; name: string }) =>
        categoriesApi.rename(vars.id, vars.name),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => categoriesApi.softDelete(id),
      onSuccess: invalidate,
    }),
  };
}

export function useBrands() {
  return useQuery({
    queryKey: ["brands", "list"],
    queryFn: () => brandsApi.list(),
  });
}

export function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => brandsApi.create(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["brands"] }),
  });
}
