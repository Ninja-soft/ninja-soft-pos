import { createClient } from "@/lib/supabase/client";

export interface SalesReport {
  total: number;
  count: number;
  by_day: { day: string; total: number; count: number }[];
  by_method: { method: string; total: number }[];
  by_category: { category: string; total: number; qty: number }[];
  by_user: { cashier: string; total: number; count: number }[];
  by_product: { product: string; total: number; qty: number }[];
}

export const reportsApi = {
  sales: async (fromISO: string, toISO: string): Promise<SalesReport> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("sales_report", {
      p_from: fromISO,
      p_to: toISO,
    });
    if (error) throw error;
    return data as unknown as SalesReport;
  },
};
