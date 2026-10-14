"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogVocab, effectiveCatalogMode, type CatalogMode, type CatalogVocab } from "@/lib/catalog/mode";
import { useMyTenant } from "@/modules/tenants/hooks";
import { servicesApi, type ServiceClarificationInput, type ServiceProductInfo } from "./api";

export const CATALOG_MODE_KEY = ["services", "catalog-mode"] as const;

/** Modo del catálogo efectivo (Configuración o rubro) y su vocabulario. */
export function useCatalogMode(): { mode: CatalogMode; vocab: CatalogVocab; loading: boolean } {
  const { data: tenant, isLoading: tLoading } = useMyTenant();
  const { data: setting, isLoading } = useQuery({
    queryKey: CATALOG_MODE_KEY,
    queryFn: () => servicesApi.catalogModeSetting(),
    staleTime: 60_000,
  });
  const mode = effectiveCatalogMode(setting, tenant?.industry);
  return { mode, vocab: catalogVocab(mode), loading: isLoading || tLoading };
}

export function useServiceClarifications(activeOnly = false, enabled = true) {
  return useQuery({
    queryKey: ["services", "clarifications", activeOnly],
    queryFn: () => servicesApi.clarifications(activeOnly),
    enabled,
    staleTime: 30_000,
  });
}

export function useClarificationMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["services", "clarifications"] });
  return {
    create: useMutation({ mutationFn: (i: ServiceClarificationInput) => servicesApi.createClarification(i), onSuccess: inv }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: Partial<ServiceClarificationInput> }) => servicesApi.updateClarification(v.id, v.patch),
      onSuccess: inv,
    }),
    remove: useMutation({ mutationFn: (id: string) => servicesApi.removeClarification(id), onSuccess: inv }),
  };
}

/** Servicios del catálogo por id (el POS ofrece la aclaración por renglón). */
export function useServiceProducts(enabled: boolean) {
  const q = useQuery({
    queryKey: ["services", "products"],
    queryFn: () => servicesApi.serviceProducts(),
    enabled,
    staleTime: 60_000,
  });
  const map = useMemo(() => new Map<string, ServiceProductInfo>((q.data ?? []).map((p) => [p.id, p])), [q.data]);
  return { ...q, map };
}
