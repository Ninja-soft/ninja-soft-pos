"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { taxSubjectApi } from "./subjectApi";

// Impuestos como sujeto (ADR-095): retenciones y percepciones sufridas y
// liquidación de IIBB.

const KEY = ["tax-subject"] as const;

export function useSufferedList(period: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "suffered", period],
    queryFn: () => taxSubjectApi.sufferedList(period),
    enabled: enabled && Boolean(period),
  });
}

export function useSufferedMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, "suffered"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "iibb-preview"] });
  };
  return {
    register: useMutation({ mutationFn: taxSubjectApi.sufferedRegister, onSuccess: done }),
    update: useMutation({
      mutationFn: (v: { id: string; p: Record<string, unknown> }) => taxSubjectApi.sufferedUpdate(v.id, v.p),
      onSuccess: done,
    }),
    void: useMutation({
      mutationFn: (v: { id: string; reason: string }) => taxSubjectApi.sufferedVoid(v.id, v.reason),
      onSuccess: done,
    }),
    import: useMutation({
      mutationFn: (v: { rows: Parameters<typeof taxSubjectApi.sufferedImport>[0]; source: string }) =>
        taxSubjectApi.sufferedImport(v.rows, v.source),
      onSuccess: done,
    }),
    sync: useMutation({
      mutationFn: (v: { from: string; to: string }) => taxSubjectApi.sufferedSyncSettlements(v.from, v.to),
      onSuccess: done,
    }),
  };
}

export function useIibbActivities(enabled = true) {
  return useQuery({ queryKey: [...KEY, "activities"], queryFn: taxSubjectApi.activities, enabled });
}

export function useIibbTemplates(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "templates"],
    queryFn: taxSubjectApi.activityTemplates,
    enabled,
    staleTime: 30 * 60_000,
  });
}

export function useIibbCoefficients(enabled = true) {
  return useQuery({ queryKey: [...KEY, "coefficients"], queryFn: taxSubjectApi.coefficients, enabled });
}

export function useIibbLiquidations(enabled = true) {
  return useQuery({ queryKey: [...KEY, "liquidations"], queryFn: taxSubjectApi.liquidations, enabled });
}

export function useIibbPreview(jurisdiction: string, period: string, opening: number | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "iibb-preview", jurisdiction, period, opening],
    queryFn: () => taxSubjectApi.preview(jurisdiction, period, opening),
    enabled: enabled && Boolean(jurisdiction) && Boolean(period),
    retry: false,
  });
}

export function useIibbMutations() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, "activities"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "coefficients"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "liquidations"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "iibb-preview"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "suffered"] });
  };
  return {
    saveActivity: useMutation({ mutationFn: taxSubjectApi.saveActivity, onSuccess: done }),
    saveCoefficient: useMutation({ mutationFn: taxSubjectApi.saveCoefficient, onSuccess: done }),
    confirm: useMutation({ mutationFn: taxSubjectApi.confirm, onSuccess: done }),
    void: useMutation({
      mutationFn: (v: { id: string; reason: string }) => taxSubjectApi.voidLiquidation(v.id, v.reason),
      onSuccess: done,
    }),
  };
}
