"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  altCodesApi,
  brandsApi,
  categoriesApi,
  packagesApi,
  saleUnitsApi,
  pluSettingsApi,
  productsApi,
  serialsApi,
  variantsApi,
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

// Productos ACTIVOS por ids (F9 · H54 — regalo por compra): el POS resuelve los
// productos de regalo (nombre/sku/stock) para armar la línea a $0 y chequear stock.
export function useProductsByIds(ids: string[]) {
  const key = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ["products", "by-ids", key],
    queryFn: () => productsApi.getByIds(key),
    enabled: key.length > 0,
    staleTime: 30_000,
  });
}

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

// La búsqueda se debouncea acá (no una request por tecla) y se mantiene el
// resultado anterior mientras llega el nuevo: sin esto la grilla del POS y los
// pickers quedaban vacíos y re-pintaban en cada tecla.
export function useProducts(
  search: string,
  categoryId?: string | null,
  brandId?: string | null,
) {
  const q = useDebouncedValue(search, 250);
  return useQuery({
    queryKey: ["products", "list", q, categoryId ?? null, brandId ?? null],
    queryFn: () => productsApi.list(q, categoryId, brandId),
    placeholderData: keepPreviousData,
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
      params.serviceTypeId ?? null,
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

export function useStockMovements(
  productId: string | null,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: ["products", "movements", productId, storeId],
    queryFn: () => productsApi.movements(productId!, storeId),
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
      mutationFn: (vars: { id: string; input: MermaInput; storeId?: string | null }) =>
        productsApi.registerWaste(vars.id, vars.input, vars.storeId ?? null),
      onSuccess: invalidate,
    }),
    // Producción / batch (F13 · H50): suma stock del producto preparado.
    registerProduction: useMutation({
      mutationFn: (vars: { id: string; input: ProductionInput; storeId?: string | null }) =>
        productsApi.registerProduction(vars.id, vars.input, vars.storeId ?? null),
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

// Medidas por bulto de un producto (null = producto nuevo, sin bultos guardados).
// F24 · H163: códigos alternativos y unidades de venta del artículo.
export function useProductAltCodes(productId: string | null) {
  return useQuery({
    queryKey: ["product-alt-codes", productId],
    queryFn: () => altCodesApi.list(productId as string),
    enabled: Boolean(productId),
  });
}

export function useProductSaleUnits(productId: string | null) {
  return useQuery({
    queryKey: ["product-sale-units", productId],
    queryFn: () => saleUnitsApi.list(productId as string),
    enabled: Boolean(productId),
  });
}

/** Unidades de venta activas del negocio, por artículo (POS). */
export function useActiveSaleUnits(enabled = true) {
  return useQuery({
    queryKey: ["sale-units-active"],
    queryFn: async () => {
      const rows = await saleUnitsApi.active();
      const map = new Map<string, typeof rows>();
      for (const r of rows) map.set(r.productId, [...(map.get(r.productId) ?? []), r]);
      return map;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useProductPackages(productId: string | null) {
  return useQuery({
    queryKey: ["product-packages", productId],
    queryFn: () => packagesApi.list(productId as string),
    enabled: Boolean(productId),
  });
}
