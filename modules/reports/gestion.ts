"use client";

// F24 · H161 (ADR-174): reportes de gestión (Reportes > Gestión). Cada RPC
// controla en el servidor la capacidad, el plan y las sucursales del usuario.

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

type Loose = { rpc: <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };
const loose = () => createClient() as unknown as Loose;

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await loose().rpc<T>(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface CollectionsGroup {
  amount: number;
  count: number;
}
export interface CollectionsReport {
  total: number;
  count: number;
  by_method: (CollectionsGroup & { method: string })[];
  by_user: (CollectionsGroup & { user_id: string | null; name: string })[];
  by_register: (CollectionsGroup & { register_id: string | null; name: string })[];
  rows: {
    id: string;
    created_at: string;
    amount: number;
    method: string;
    receipt_no: number | null;
    customer_id: string;
    customer_name: string | null;
    user_name: string | null;
    register_name: string | null;
  }[];
}

export interface StockMovementsReport {
  total_count: number;
  in: number;
  out: number;
  opening: number | null;
  closing: number | null;
  by_reason: { reason: string; count: number; qty: number }[];
  rows: {
    id: string;
    created_at: string;
    product_id: string;
    product_name: string | null;
    sku: string | null;
    store_name: string | null;
    delta: number;
    reason: string;
    loss_reason: string | null;
    notes: string | null;
    reference_id: string | null;
    user_name: string | null;
    balance: number | null;
    unit_cost: number | null;
  }[];
}

export interface DeadStockReport {
  days: number;
  count: number;
  never_sold: number;
  value_price: number;
  value_cost: number | null;
  rows: {
    product_id: string;
    name: string;
    sku: string | null;
    category: string | null;
    qty: number;
    last_sale_at: string | null;
    days: number | null;
    value_price: number;
    value_cost: number | null;
  }[];
}

export interface ProfitRow {
  month?: string;
  sales: number;
  taxes?: number;
  net_sales: number;
  returns?: number;
  cmv: number;
  gross_margin: number;
  expenses: number;
  result: number;
  sales_count?: number;
  cost_coverage_pct?: number | null;
  approx?: boolean;
}
export interface ProfitabilityReport {
  from: string;
  to: string;
  previous_from: string;
  previous_to: string;
  expenses_included: boolean;
  months: ProfitRow[];
  totals: ProfitRow | null;
  previous: ProfitRow | null;
}

export const gestionApi = {
  collections: (from: string, to: string, storeId: string | null) =>
    call<CollectionsReport>("report_collections", { p_from: from, p_to: to, p_store_id: storeId }),
  stockMovements: (p: {
    from: string;
    to: string;
    storeId: string | null;
    productId: string | null;
    reason: string | null;
    limit: number;
    offset: number;
  }) =>
    call<StockMovementsReport>("report_stock_movements", {
      p_from: p.from,
      p_to: p.to,
      p_store_id: p.storeId,
      p_product_id: p.productId,
      p_reason: p.reason,
      p_limit: p.limit,
      p_offset: p.offset,
    }),
  deadStock: (days: number, storeId: string | null) =>
    call<DeadStockReport>("report_dead_stock", { p_days: days, p_store_id: storeId }),
  profitability: (from: string, to: string, storeId: string | null) =>
    call<ProfitabilityReport>("report_profitability", { p_from: from, p_to: to, p_store_id: storeId }),
};

const on = (b: boolean) => ({ enabled: b, staleTime: 60_000, retry: false as const });

export function useCollectionsReport(from: string | null, to: string | null, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reports", "gestion", "collections", from, to, storeId],
    queryFn: () => gestionApi.collections(from!, to!, storeId),
    ...on(enabled && Boolean(from && to)),
  });
}

export function useStockMovementsReport(
  p: { from: string | null; to: string | null; storeId: string | null; productId: string | null; reason: string | null; page: number },
  enabled = true,
) {
  return useQuery({
    queryKey: ["reports", "gestion", "stock", p],
    queryFn: () =>
      gestionApi.stockMovements({
        from: p.from!,
        to: p.to!,
        storeId: p.storeId,
        productId: p.productId,
        reason: p.reason,
        limit: 200,
        offset: p.page * 200,
      }),
    ...on(enabled && Boolean(p.from && p.to)),
  });
}

export function useDeadStockReport(days: number, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reports", "gestion", "dead", days, storeId],
    queryFn: () => gestionApi.deadStock(days, storeId),
    ...on(enabled),
  });
}

export function useProfitabilityReport(from: string | null, to: string | null, storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["reports", "gestion", "profit", from, to, storeId],
    queryFn: () => gestionApi.profitability(from!, to!, storeId),
    ...on(enabled && Boolean(from && to)),
  });
}
