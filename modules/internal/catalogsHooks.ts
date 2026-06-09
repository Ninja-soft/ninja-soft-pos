"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogsApi, type CatalogInput } from "./catalogs";

export function useCatalogStores() {
  return useQuery({
    queryKey: ["internal", "catalog-stores"],
    queryFn: () => catalogsApi.listStores(),
    staleTime: 60 * 1000,
  });
}

export function useCatalogs() {
  return useQuery({
    queryKey: ["internal", "catalogs"],
    queryFn: () => catalogsApi.listCatalogs(),
  });
}

export function useSetStoreLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { storeKey: string; logoUrl: string | null }) =>
      catalogsApi.setStoreLogo(v.storeKey, v.logoUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-stores"] });
    },
  });
}

export function useSaveCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CatalogInput) => catalogsApi.saveCatalog(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "catalogs"] });
    },
  });
}

export function useCatalogGrants(catalogId: string | null) {
  return useQuery({
    queryKey: ["internal", "catalog-grants", catalogId],
    queryFn: () => catalogsApi.listGrants(catalogId as string),
    enabled: Boolean(catalogId),
  });
}

export function useGrantCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tenantId: string; catalogId: string }) =>
      catalogsApi.grantCatalog(v.tenantId, v.catalogId),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-grants", v.catalogId] });
      qc.invalidateQueries({ queryKey: ["internal", "catalogs"] });
    },
  });
}

export function useRevokeCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tenantId: string; catalogId: string }) =>
      catalogsApi.revokeCatalog(v.tenantId, v.catalogId),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-grants", v.catalogId] });
      qc.invalidateQueries({ queryKey: ["internal", "catalogs"] });
    },
  });
}
