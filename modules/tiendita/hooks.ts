"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { storefrontApi } from "./storefront";

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
