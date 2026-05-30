import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";

export type Sale = Tables<"sales">;
export type SaleItem = Tables<"sale_items">;
export type Payment = Tables<"payments">;

export interface SaleDetail {
  sale: Sale;
  items: SaleItem[];
  payments: Payment[];
}

export const salesApi = {
  list: async (): Promise<Sale[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("sales")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return (data ?? []) as Sale[];
  },

  get: async (id: string): Promise<SaleDetail> => {
    const supabase = createClient();
    const [saleRes, itemsRes, paymentsRes] = await Promise.all([
      supabase.from("sales").select("*").eq("id", id).single(),
      supabase.from("sale_items").select("*").eq("sale_id", id),
      supabase.from("payments").select("*").eq("sale_id", id),
    ]);
    if (saleRes.error) throw saleRes.error;
    return {
      sale: saleRes.data as Sale,
      items: (itemsRes.data ?? []) as SaleItem[],
      payments: (paymentsRes.data ?? []) as Payment[],
    };
  },

  void: async (id: string, reason: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("void_sale", {
      p_sale_id: id,
      p_reason: reason,
    });
    if (error) throw error;
  },
};
