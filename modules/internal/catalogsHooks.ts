"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogsApi, type CatalogInput } from "./catalogs";
import { catalogSyncApi, type SyncControlAction } from "./catalogSync";
import type { SyncScheduleConfig } from "./catalogSyncSchedule";

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
    // Al guardar se recuentan sus productos (las tiendas pudieron cambiar). Si el
    // recuento falla, el catálogo igual quedó guardado: lo corrige la próxima sync.
    mutationFn: async (input: CatalogInput) => {
      const id = await catalogsApi.saveCatalog(input);
      await catalogsApi.recountCatalog(id).catch(() => undefined);
      return id;
    },
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
    queryFn: () => catalogSyncApi.listRuns(10),
    refetchInterval: (query) =>
      query.state.data?.[0]?.status === "running" ? 4000 : false,
  });
}

// ADR-109: productos únicos vs ofertas por tienda (deduplicación).
export function useCatalogDedupeStats() {
  return useQuery({
    queryKey: ["internal", "catalog-dedupe-stats"],
    queryFn: () => catalogSyncApi.dedupeStats(),
    staleTime: 5 * 60_000,
  });
}

// ADR-109: comparador de precios del panel interno (todas las tiendas).
export function useInternalPriceCompare(ean: string) {
  const clean = ean.trim();
  return useQuery({
    queryKey: ["internal", "catalog-price-compare", clean],
    queryFn: () => catalogSyncApi.compare(clean),
    enabled: clean.length >= 6,
    staleTime: 60_000,
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

// ADR-113: agenda editable de la sync automática.
export function useCatalogSyncConfig() {
  return useQuery({
    queryKey: ["internal", "catalog-sync-config"],
    queryFn: () => catalogSyncApi.getConfig(),
    staleTime: 60_000,
  });
}

export function useSaveCatalogSyncConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: SyncScheduleConfig) => catalogSyncApi.saveConfig(config),
    onSuccess: (saved) => {
      qc.setQueryData(["internal", "catalog-sync-config"], saved);
    },
  });
}

// ADR-113: pausar / reanudar / cancelar la corrida abierta.
export function useCatalogSyncControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; action: SyncControlAction }) => catalogSyncApi.control(v.runId, v.action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["internal", "catalog-sync-runs"] });
    },
  });
}
