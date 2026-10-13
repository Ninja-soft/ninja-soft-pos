"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomCatalog, CustomValue } from "@/lib/tax/custom";
import { taxCustomApi, type CustomSaveInput } from "./customApi";

// Valores impositivos del negocio (ADR-105).
const KEY = ["tax-custom"] as const;

export function useCustomValues(enabled = true) {
  return useQuery({ queryKey: [...KEY, "values"], queryFn: taxCustomApi.values, enabled });
}

/** Versiones de un valor (catálogo + clave). */
export function versionsOf(all: readonly CustomValue[] | undefined, catalog: CustomCatalog, key: string): CustomValue[] {
  return (all ?? []).filter((v) => v.catalog === catalog && v.item_key === key);
}

export function useParameterTemplates(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "parameters"],
    queryFn: taxCustomApi.parameterTemplates,
    enabled,
    staleTime: 30 * 60_000,
  });
}

export function useScale(code: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "scale", code],
    queryFn: () => taxCustomApi.scale(code!),
    enabled: enabled && Boolean(code),
  });
}

export function useCustomHistory(catalog: string, key: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "history", catalog, key],
    queryFn: () => taxCustomApi.history(catalog, key!),
    enabled: enabled && Boolean(key),
  });
}

export function usePadronProfiles(enabled = true) {
  return useQuery({ queryKey: [...KEY, "profiles"], queryFn: taxCustomApi.profiles, enabled });
}

/** Invalida todo lo que depende de los valores del negocio. */
function useDone() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["tax"] });
    void qc.invalidateQueries({ queryKey: ["tax-subject"] });
  };
}

export function useCustomMutations() {
  const done = useDone();
  return {
    save: useMutation({ mutationFn: (p: CustomSaveInput) => taxCustomApi.save(p), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => taxCustomApi.remove(id), onSuccess: done }),
    reset: useMutation({
      mutationFn: (v: { catalog: CustomCatalog; key: string }) => taxCustomApi.reset(v.catalog, v.key),
      onSuccess: done,
    }),
  };
}

export function useProfileMutations() {
  const done = useDone();
  return {
    save: useMutation({ mutationFn: taxCustomApi.saveProfile, onSuccess: done }),
    remove: useMutation({ mutationFn: taxCustomApi.removeProfile, onSuccess: done }),
    manual: useMutation({ mutationFn: taxCustomApi.manualRate, onSuccess: done }),
  };
}
