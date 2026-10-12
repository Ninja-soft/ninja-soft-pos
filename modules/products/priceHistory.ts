"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

// Historial de precios (F18 · H100, ADR-056). La tabla es nueva y
// types/database.ts no se regenera: cliente "suelto". La RLS filtra por negocio
// y por la feature `historial_precios`; acá además se filtra por producto.

export type PriceHistorySource = "manual" | "import" | "bulk" | "list";

export interface PriceHistoryRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  list_id: string | null;
  old_price: number | null;
  new_price: number | null;
  changed_by: string | null;
  source: PriceHistorySource;
  at: string;
  changed_by_name: string | null;
}

export const PRICE_SOURCE_LABEL: Record<PriceHistorySource, string> = {
  manual: "Manual",
  import: "Importación",
  bulk: "Actualización masiva",
  list: "Lista de precios",
};

export const priceHistoryApi = {
  list: async (productId: string, limit = 200): Promise<PriceHistoryRow[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("product_price_history" as never)
      .select("id, product_id, variant_id, list_id, old_price, new_price, changed_by, source, at")
      .eq("product_id", productId)
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Omit<PriceHistoryRow, "changed_by_name">[];
    const ids = [...new Set(rows.map((r) => r.changed_by).filter((x): x is string => Boolean(x)))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const { data: users } = await supabase.from("users").select("id, full_name, email").in("id", ids);
      for (const u of (users ?? []) as { id: string; full_name: string | null; email: string | null }[]) {
        names.set(u.id, u.full_name || u.email || "");
      }
    }
    return rows.map((r) => ({
      ...r,
      old_price: r.old_price == null ? null : Number(r.old_price),
      new_price: r.new_price == null ? null : Number(r.new_price),
      changed_by_name: r.changed_by ? (names.get(r.changed_by) ?? null) : null,
    }));
  },
};

export function usePriceHistory(productId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["products", "price-history", productId ?? null],
    enabled: Boolean(productId) && enabled,
    queryFn: () => priceHistoryApi.list(productId!),
  });
}

export interface PricePoint {
  at: string;
  price: number;
}

/**
 * Serie del precio base del producto (sin variantes ni listas) en orden
 * cronológico, para el gráfico escalonado. PURO.
 */
export function basePriceSeries(rows: PriceHistoryRow[]): PricePoint[] {
  return rows
    .filter((r) => r.variant_id == null && r.list_id == null && r.new_price != null)
    .map((r) => ({ at: r.at, price: r.new_price as number }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Precio base vigente en una fecha ("¿cuánto valía el 3 de marzo?"). PURO. */
export function basePriceAt(rows: PriceHistoryRow[], at: Date): number | null {
  let out: number | null = null;
  for (const p of basePriceSeries(rows)) {
    if (new Date(p.at).getTime() <= at.getTime()) out = p.price;
    else break;
  }
  return out;
}
