"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { promotionsApi, type PromotionInput } from "./api";

// Promociones (F9 · H53). CRUD para el admin. El POS consumirá `useActivePromotions`
// cuando se integre la evaluación en el carrito (follow-up).

export function usePromotions() {
  return useQuery({ queryKey: ["promotions", "list"], queryFn: () => promotionsApi.list() });
}

export function useActivePromotions(enabled = true) {
  return useQuery({
    queryKey: ["promotions", "active"],
    queryFn: () => promotionsApi.listActive(),
    enabled,
    staleTime: 60_000,
  });
}

export function usePromotionMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["promotions"] });

  return {
    create: useMutation({
      mutationFn: (input: PromotionInput) => promotionsApi.create(input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: PromotionInput }) =>
        promotionsApi.update(id, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => promotionsApi.remove(id),
      onSuccess: invalidate,
    }),
  };
}
