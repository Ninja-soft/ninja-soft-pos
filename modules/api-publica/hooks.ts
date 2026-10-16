"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiScope } from "@/lib/api-publica/scopes";
import { apiPublicaApi, type ApiEnvironment } from "./api";

const KEY = ["api-publica"] as const;

export function useApiClients(enabled = true) {
  return useQuery({ queryKey: [...KEY, "clients"], queryFn: () => apiPublicaApi.list(), enabled });
}

export function useApiClientMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    create: useMutation({
      mutationFn: (v: { name: string; scopes: ApiScope[]; rateLimit: number; environment?: ApiEnvironment }) =>
        apiPublicaApi.create(v.name, v.scopes, v.rateLimit, v.environment),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { id: string; name?: string; scopes?: ApiScope[]; rateLimit?: number }) =>
        apiPublicaApi.update(v.id, v),
      onSuccess: invalidate,
    }),
    rotate: useMutation({ mutationFn: (id: string) => apiPublicaApi.rotate(id), onSuccess: invalidate }),
    revoke: useMutation({
      mutationFn: (v: { id: string; reason: string }) => apiPublicaApi.revoke(v.id, v.reason),
      onSuccess: invalidate,
    }),
  };
}

/** Enviar la documentación por email (ADR-163). Sin caché que invalidar. */
export function useSendApiDocs() {
  return useMutation({ mutationFn: (v: { email: string; note: string | null }) => apiPublicaApi.sendDocs(v.email, v.note) });
}
