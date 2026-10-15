"use client";

// Orígenes para vender (ADR-136): salón y depósitos vendibles de la sucursal
// del POS y depósitos de otras sucursales habilitados para ella. Lo calcula el
// servidor (warehouse_sources) con lo reservado descontado.

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { FulfillmentSource } from "@/lib/stock/fulfillment";

export const fulfillmentApi = {
  sources: async (storeId: string, items: { product_id: string; variant_id: string | null }[]): Promise<FulfillmentSource[]> => {
    const { data, error } = await createClient().rpc("warehouse_sources" as never, { p_store_id: storeId, p_items: items } as never);
    if (error) throw error;
    return ((data ?? []) as unknown as FulfillmentSource[]).map((s) => ({
      ...s,
      available: Number(s.available),
      sale_priority: Number(s.sale_priority),
    }));
  },
};

export function useFulfillmentSources(
  storeId: string | null,
  items: { product_id: string; variant_id: string | null }[],
  enabled: boolean,
) {
  const key = items
    .map((i) => `${i.product_id}|${i.variant_id ?? ""}`)
    .sort()
    .join(",");
  return useQuery({
    queryKey: ["fulfillment-sources", storeId, key],
    queryFn: () => fulfillmentApi.sources(storeId!, items),
    enabled: enabled && Boolean(storeId) && items.length > 0,
    staleTime: 15_000,
  });
}
