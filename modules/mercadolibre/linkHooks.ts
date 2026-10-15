"use client";

// "Vincular con un producto" (ADR-141, parte A): datos de la publicación leídos
// de Mercado Libre (fotos, GTIN, SKU, variaciones) y candidatos del catálogo
// con foto, marca y la sugerencia del servidor (ml_link_candidates).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { mlEdge } from "@/modules/mercadolibre/hooks";
import type { LinkMatch } from "@/lib/mercadolibre/linkMatch";

export interface MlLinkContext {
  pictures: string[];
  brand: string | null;
  model: string | null;
  gtins: string[];
  skus: string[];
  variations: Array<{ id: string; label: string; sku: string | null; gtin: string | null; picture: string | null }>;
}

export interface MlLinkCandidate {
  product_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  image_url: string | null;
  has_variants: boolean;
  price: number | null;
  stock: number | null;
  variant_id: string | null;
  variant_label: string | null;
  match: LinkMatch | null;
  score: number;
  words_hit: number;
  linked_elsewhere: number;
}

export interface MlLinkCandidates {
  item: { id: string; ml_item_id: string; title: string; thumbnail: string | null; price: number | null; permalink: string | null };
  words: string[];
  searching: boolean;
  candidates: MlLinkCandidate[];
}

export function useMlLinkContext(accountId: string | null, itemRowId: string | null) {
  return useQuery({
    queryKey: ["ml", "link-context", accountId, itemRowId],
    queryFn: () => mlEdge<MlLinkContext>("ml_api", { action: "link_context", account_id: accountId, item_row_id: itemRowId }),
    enabled: Boolean(accountId && itemRowId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Candidatos del catálogo. Espera a que llegue el contexto de ML (o que falle)
 * para mandar el GTIN y el SKU; sin contexto sugiere sólo por el título.
 */
export function useMlLinkCandidates(
  itemRowId: string | null,
  search: string,
  ids: { gtins: string[]; skus: string[] } | null,
  ready: boolean,
) {
  const q = useDebouncedValue(search.trim(), 250);
  return useQuery({
    queryKey: ["ml", "link-candidates", itemRowId, q, ids?.gtins ?? [], ids?.skus ?? []],
    queryFn: async () => {
      const { data, error } = await createClient().rpc("ml_link_candidates" as never, {
        p_item: itemRowId,
        p_search: q || null,
        p_gtins: ids?.gtins ?? [],
        p_skus: ids?.skus ?? [],
        p_limit: 30,
      } as never);
      if (error) throw error;
      return data as unknown as MlLinkCandidates;
    },
    enabled: Boolean(itemRowId) && ready,
    placeholderData: keepPreviousData,
  });
}
