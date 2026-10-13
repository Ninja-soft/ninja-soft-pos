"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiScope } from "@/lib/api-publica/scopes";
import { apiPublicaApi } from "./api";

const KEY = ["api-publica"] as const;

export function useApiClients(enabled = true) {
  return useQuery({ queryKey: [...KEY, "clients"], queryFn: () => apiPublicaApi.list(), enabled });
}

export function useApiClientMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    create: useMutation({
      mutationFn: (v: { name: string; scopes: ApiScope[]; rateLimit: number }) =>
        apiPublicaApi.create(v.name, v.scopes, v.rateLimit),
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
