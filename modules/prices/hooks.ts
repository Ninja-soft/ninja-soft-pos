"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pricesApi, type PriceChannel, type PriceList } from "./api";

export function usePriceLists() {
  return useQuery({
    queryKey: ["price-lists"],
    queryFn: () => pricesApi.listLists(),
  });
}

export function usePriceListItems(listId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["price-list-items", listId],
    queryFn: () => pricesApi.listItems(listId!),
    enabled: enabled && Boolean(listId),
  });
}

export function usePriceListMutations(tenantId: string | null | undefined) {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["price-lists"] });
  return {
    create: useMutation({
      mutationFn: (input: {
        name: string;
        channel: PriceChannel;
        adjustment_pct: number | null;
      }) => pricesApi.createList(tenantId!, input),
      onSuccess: inv,
    }),
    update: useMutation({
      mutationFn: (vars: {
        id: string;
        patch: Partial<Pick<PriceList, "name" | "adjustment_pct" | "is_active">>;
      }) => pricesApi.updateList(vars.id, vars.patch),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => pricesApi.removeList(id),
      onSuccess: inv,
    }),
  };
}

export function usePriceItemMutations(
  tenantId: string | null | undefined,
  listId: string,
) {
  const qc = useQueryClient();
  const inv = () =>
    qc.invalidateQueries({ queryKey: ["price-list-items", listId] });
  return {
    upsert: useMutation({
      mutationFn: (vars: {
        productId: string;
        variantId: string | null;
        price: number;
      }) =>
        pricesApi.upsertItem(
          tenantId!,
          listId,
          vars.productId,
          vars.variantId,
          vars.price,
        ),
      onSuccess: inv,
    }),
    remove: useMutation({
      mutationFn: (id: string) => pricesApi.removeItem(id),
      onSuccess: inv,
    }),
  };
}

// Lista 'mostrador' activa + todos sus items, para resolver el precio de venta
// del POS. Si no hay lista → null y el POS usa el precio base sin cambios.
export function useMostradorPricing() {
  return useQuery({
    queryKey: ["price-lists", "mostrador-pricing"],
    queryFn: () => pricesApi.channelPricing("mostrador"),
  });
}
