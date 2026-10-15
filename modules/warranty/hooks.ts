"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { warrantyApi, type WarrantyTypeInput } from "./api";
import type { ScopeRowInput } from "@/lib/warranty/scopes";

const KEY = ["warranty-catalog"] as const;

/** Tipos de garantía (vivos) y su alcance. Una sola consulta para POS y config. */
export function useWarrantyCatalog(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => warrantyApi.catalog(),
    enabled,
    staleTime: 60_000,
  });
}

export function useWarrantyMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({
      mutationFn: (v: { plan: WarrantyTypeInput; scopes: ScopeRowInput[] | null }) => warrantyApi.save(v.plan, v.scopes),
      onSuccess: inv,
    }),
    setActive: useMutation({
      mutationFn: (v: { id: string; active: boolean }) => warrantyApi.setActive(v.id, v.active),
      onSuccess: inv,
    }),
    archive: useMutation({ mutationFn: (id: string) => warrantyApi.archive(id), onSuccess: inv }),
    reorder: useMutation({ mutationFn: (ids: string[]) => warrantyApi.reorder(ids), onSuccess: inv }),
  };
}

export function useCustomerWarranties(customerId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["customer-warranties", customerId],
    queryFn: () => warrantyApi.soldToCustomer(customerId!),
    enabled: enabled && Boolean(customerId),
  });
}
