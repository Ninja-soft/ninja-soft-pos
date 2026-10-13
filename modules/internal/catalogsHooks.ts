"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogsApi, type CatalogInput } from "./catalogs";
import { catalogSyncApi } from "./catalogSync";

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

// Sincronización con el feed (ADR-107): mientras haya una corrida abierta se
// consulta cada 4 s para mostrar el progreso.
export function useCatalogSyncRuns() {
  return useQuery({
    queryKey: ["internal", "catalog-sync-runs"],
    queryFn: () => catalogSyncApi.listRuns(5),
    refetchInterval: (query) =>
      query.state.data?.[0]?.status === "running" ? 4000 : false,
  });
}

export function useStartCatalogSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (full: boolean) => catalogSyncApi.start(full),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-sync-runs"] });
    },
  });
}
