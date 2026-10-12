"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { storefrontApi, type CatalogImportOverrides } from "./storefront";

// Catálogos disponibles para el tenant + estado de acceso (Acceder / Comprar).
export function useStorefrontCatalogs() {
  return useQuery({
    queryKey: ["tiendita", "catalogs"],
    queryFn: () => storefrontApi.listCatalogs(),
  });
}

// Buscador dentro de un catálogo comprado. `enabled` se controla desde la UI
// (solo busca cuando hay catálogo seleccionado y acceso). keepPreviousData para
// que la lista no parpadee al tipear.
export function useCatalogSearch(
  catalogId: string | null,
  query: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["tiendita", "search", catalogId, query],
    queryFn: () => storefrontApi.search(catalogId as string, query),
    enabled: Boolean(catalogId) && enabled,
    placeholderData: (prev) => prev,
    staleTime: 30 * 1000,
  });
}

// Agregar un producto del catálogo a mis productos. Invalida la lista de
// productos del tenant para que aparezca al instante en /productos.
export function useAddCatalogProduct(catalogId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (catalogProductId: number) =>
      storefrontApi.addProduct(catalogId as string, catalogProductId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// Import con edición previa. Tras crear, dispara la copia de la foto al bucket
// del negocio en segundo plano (no bloquea ni falla el import).
export function useImportCatalogProduct(catalogId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      catalogProductId: number;
      overrides: CatalogImportOverrides;
    }) => {
      const res = await storefrontApi.importProduct(
        catalogId as string,
        vars.catalogProductId,
        vars.overrides,
      );
      if (res.imagePending && res.productId) {
        void storefrontApi.copyImage(res.productId).then(() => {
          qc.invalidateQueries({ queryKey: ["product-images", res.productId] });
          qc.invalidateQueries({ queryKey: ["products"] });
        });
      }
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
  });
}
