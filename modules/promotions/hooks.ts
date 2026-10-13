"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFeature } from "@/modules/saas/gating";
import { promotionsApi, type PromotionInput } from "./api";

// Promociones (F9, ADR-074): admin, POS y ticket. El POS sólo las evalúa si el
// plan trae `promociones` (el servidor tampoco las aplica sin la feature).

export function usePromotions() {
  return useQuery({ queryKey: ["promotions", "list"], queryFn: () => promotionsApi.list() });
}

export function useActivePromotions(enabled = true) {
  const feature = useFeature("promociones");
  return useQuery({
    queryKey: ["promotions", "active"],
    queryFn: () => promotionsApi.listActive(),
    enabled: enabled && feature === true,
    staleTime: 60_000,
  });
}

/** Usos de las promos con tope (para la vista previa); sólo si hay alguna con tope. */
export function usePromotionUsage(customerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["promotions", "usage", customerId],
    queryFn: () => promotionsApi.usage(customerId),
    enabled,
    staleTime: 30_000,
  });
}

export function useSalePromotions(saleId: string | null) {
  return useQuery({
    queryKey: ["promotions", "sale", saleId],
    queryFn: () => promotionsApi.forSale(saleId!),
    enabled: Boolean(saleId),
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
      mutationFn: ({ id, input }: { id: string; input: PromotionInput }) => promotionsApi.update(id, input),
      onSuccess: invalidate,
    }),
    setActive: useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) => promotionsApi.setActive(id, active),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => promotionsApi.remove(id),
      onSuccess: invalidate,
    }),
  };
}
