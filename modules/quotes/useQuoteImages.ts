"use client";

// Fotos de los productos de un presupuesto (ADR-122 sobre ADR-119): la foto
// principal actual de cada producto, para el motor de comprobantes. El
// export a PDF pasa las remotas a data URL antes de capturar.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { QuoteItem } from "@/lib/quotes/logic";

export function useQuoteImages(items: QuoteItem[] | null, enabled: boolean): Map<string, string> | null {
  const ids = useMemo(
    () => Array.from(new Set((items ?? []).map((i) => i.product_id).filter((x): x is string => Boolean(x)))).sort(),
    [items],
  );
  const { data } = useQuery({
    queryKey: ["quotes", "images", ids],
    enabled: enabled && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: rows } = await createClient().from("products").select("id, image_url").in("id", ids);
      return new Map(
        ((rows ?? []) as { id: string; image_url: string | null }[])
          .filter((r) => r.image_url)
          .map((r) => [r.id, r.image_url!] as [string, string]),
      );
    },
  });
  return data ?? null;
}
