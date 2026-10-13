"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { arcaApi, type DocFilter } from "./api";
import type { ArcaEnv } from "@/lib/arca/labels";

// Facturación electrónica ARCA (F3 · ADR-072).
const KEY = ["arca"] as const;

export function useArcaConfig(enabled = true) {
  return useQuery({ queryKey: [...KEY, "config"], queryFn: arcaApi.config, enabled, staleTime: 30_000 });
}

/** Estado para el POS (cualquier miembro). Silencioso ante errores. */
export function useArcaStatus(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "status"],
    queryFn: arcaApi.status,
    enabled,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });
}

export function useFiscalDocuments(filter: DocFilter, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "docs", filter],
    queryFn: () => arcaApi.documents(filter),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useSaleFiscalDocuments(saleId: string | null) {
  return useQuery({
    queryKey: [...KEY, "sale", saleId],
    queryFn: () => arcaApi.saleDocuments(saleId!),
    enabled: Boolean(saleId),
    retry: false,
    // Mientras la factura está en camino, se refresca sola.
    refetchInterval: (q) => {
      const docs = q.state.data;
      return docs?.some((d) => d.status === "pendiente" || d.status === "enviando") ? 8_000 : false;
    },
  });
}

export function useFiscalEvents(enabled = true) {
  return useQuery({ queryKey: [...KEY, "events"], queryFn: () => arcaApi.events(), enabled, refetchInterval: 60_000 });
}

export function useArcaPlatform(enabled = true) {
  return useQuery({ queryKey: [...KEY, "platform"], queryFn: arcaApi.platformGet, enabled });
}

export function useArcaMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  return {
    saveSettings: useMutation({ mutationFn: arcaApi.saveSettings, onSuccess: done }),
    setEnvironment: useMutation({
      mutationFn: (v: { env: ArcaEnv; reason?: string }) => arcaApi.setEnvironment(v.env, v.reason),
      onSuccess: done,
    }),
    retry: useMutation({
      mutationFn: async (id: string) => {
        const r = await arcaApi.retryDocument(id);
        // Vuelve a la cola: se intenta ya (si falla, queda para el cron).
        if (r.status === "pendiente") await arcaApi.reintentar(id).catch(() => undefined);
        return r;
      },
      onSuccess: done,
    }),
    enqueueSale: useMutation({
      mutationFn: async (saleId: string) => {
        const r = await arcaApi.enqueueSale(saleId);
        await arcaApi.emitir(r.id).catch(() => undefined);
        return r;
      },
      onSuccess: done,
    }),
    emitir: useMutation({ mutationFn: (id?: string) => arcaApi.emitir(id), onSuccess: done }),
    deleteCertificate: useMutation({ mutationFn: arcaApi.deleteCertificate, onSuccess: done }),
    setStorePos: useMutation({
      mutationFn: (v: { id: string; n: number | null }) => arcaApi.setStorePos(v.id, v.n),
      onSuccess: done,
    }),
    setRegisterPos: useMutation({
      mutationFn: (v: { id: string; n: number | null }) => arcaApi.setRegisterPos(v.id, v.n),
      onSuccess: done,
    }),
    testConexion: useMutation({ mutationFn: arcaApi.testConexion, onSuccess: done }),
    generarCsr: useMutation({
      mutationFn: (v: { env: ArcaEnv; alias?: string; organization?: string }) =>
        arcaApi.generarCsr(v.env, v.alias, v.organization),
      onSuccess: done,
    }),
    subirCertificado: useMutation({
      mutationFn: (v: { env: ArcaEnv; cert: string }) => arcaApi.subirCertificado(v.env, v.cert),
      onSuccess: done,
    }),
    caeaTareas: useMutation({ mutationFn: arcaApi.caeaTareas, onSuccess: done }),
  };
}

export function usePlatformMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: [...KEY, "platform"] });
  return {
    setCuit: useMutation({
      mutationFn: (v: { env: ArcaEnv; cuit: string }) => arcaApi.platformSetCuit(v.env, v.cuit),
      onSuccess: done,
    }),
    generarCsr: useMutation({
      mutationFn: (v: { env: ArcaEnv; alias?: string; organization?: string }) =>
        arcaApi.platformGenerarCsr(v.env, v.alias, v.organization),
      onSuccess: done,
    }),
    subirCertificado: useMutation({
      mutationFn: (v: { env: ArcaEnv; cert: string }) => arcaApi.platformSubirCertificado(v.env, v.cert),
      onSuccess: done,
    }),
  };
}
