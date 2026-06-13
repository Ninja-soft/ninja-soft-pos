"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  brandsApi,
  categoriesApi,
  pluSettingsApi,
  productsApi,
  serialsApi,
  variantsApi,
  warrantyPlansApi,
  type ProductsPageParams,
  type VariantRow,
} from "./api";
import type {
  CategoryInput,
  ProductOutput,
  StockAdjustInput,
  MermaInput,
  ProductionInput,
} from "./schemas";

// Cantidad de productos activos del tenant (para el aviso de "vaciar catálogo").
export function useActiveProductCount() {
  return useQuery({
    queryKey: ["products", "active-count"],
    queryFn: () => productsApi.activeCount(),
    staleTime: 30_000,
  });
}

// Vaciar catálogo: da de baja lógica TODOS los productos del tenant. Invalida
// todo lo que cuelga de productos para que el POS/listados queden vacíos.
export function useEmptyCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => productsApi.emptyCatalog(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// Estado del PLU del tenant (habilitado / modo / si ya se preguntó).
export function usePluSettings() {
  return useQuery({
    queryKey: ["products", "plu-settings"],
    queryFn: () => pluSettingsApi.get(),
    staleTime: 60_000,
  });
}

// Resuelve el prompt del primer producto (aceptar/omitir + modo).
export function useDecidePlu() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { accept: boolean; mode: "random" | "incremental" }) =>
      pluSettingsApi.decide(v.accept, v.mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products", "plu-settings"] });
      qc.invalidateQueries({ queryKey: ["pos-settings"] });
    },
  });
}

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

export function useProducts(
  search: string,
  categoryId?: string | null,
  brandId?: string | null,
) {
  return useQuery({
    queryKey: ["products", "list", search, categoryId ?? null, brandId ?? null],
    queryFn: () => productsApi.list(search, categoryId, brandId),
  });
}

// Listado paginado server-side de productos. keepPreviousData evita parpadeos al
// cambiar de página o tipear en la búsqueda (debounce desde la página).
export function useProductsPaged(params: ProductsPageParams) {
  return useQuery({
    queryKey: [
      "products",
      "paged",
      params.page,
      params.pageSize,
      params.search ?? "",
      params.categoryId ?? null,
      params.brandId ?? null,
    ],
    queryFn: () => productsApi.listPaged(params),
    placeholderData: keepPreviousData,
  });
}

export function useTopProducts(enabled: boolean, limit = 12) {
  return useQuery({
    queryKey: ["products", "top", limit],
    queryFn: () => productsApi.top(limit),
    enabled,
  });
}

// Favoritos del POS (H36): botones rápidos. `enabled` evita el fetch cuando la
// grilla rápida no está visible (p. ej. mientras se busca).
export function useFavoriteProducts(enabled = true) {
  return useQuery({
    queryKey: ["products", "favorites"],
    queryFn: () => productsApi.favorites(),
    enabled,
  });
}

// Toggle del favorito desde el listado de productos (un toque).
export function useSetFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; is_favorite: boolean }) =>
      productsApi.setFavorite(v.id, v.is_favorite),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
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

export function useVariants(productId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["products", "variants", productId],
    queryFn: () => variantsApi.list(productId!),
    enabled: enabled && Boolean(productId),
  });
}

export function useSaveVariants(productId: string, tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { rows: VariantRow[]; axes: string[] }) =>
      variantsApi.bulkUpsert(productId, tenantId, vars.rows, vars.axes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products", "variants", productId] });
      qc.invalidateQueries({ queryKey: ["products", "list"] });
    },
  });
}

export function useRemoveVariant(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => variantsApi.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["products", "variants", productId] }),
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
    // Merma tipada (F13 · H50): descuenta stock con sub-motivo.
    registerWaste: useMutation({
      mutationFn: (vars: { id: string; input: MermaInput }) =>
        productsApi.registerWaste(vars.id, vars.input),
      onSuccess: invalidate,
    }),
    // Producción / batch (F13 · H50): suma stock del producto preparado.
    registerProduction: useMutation({
      mutationFn: (vars: { id: string; input: ProductionInput }) =>
        productsApi.registerProduction(vars.id, vars.input),
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

export function useBrandMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["brands"] });
  return {
    update: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        brandsApi.update(id, name),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => brandsApi.remove(id),
      onSuccess: inv,
    }),
  };
}
