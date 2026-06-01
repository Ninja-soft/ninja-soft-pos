import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";

export interface ReturnItemInput {
  sale_item_id: string;
  quantity: number;
  restock: "stock" | "review" | "discard";
}

export type Sale = Tables<"sales">;
export type ReturnReason = Tables<"return_reasons">;

export const returnReasonsApi = {
  list: async (activeOnly = true): Promise<ReturnReason[]> => {
    const supabase = createClient();
    let q = supabase.from("return_reasons").select("*").order("sort").order("label");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as ReturnReason[];
  },
  create: async (label: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("return_reasons").insert({ label });
    if (error) throw error;
  },
  setActive: async (id: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("return_reasons")
      .update({ is_active })
      .eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("return_reasons").delete().eq("id", id);
    if (error) throw error;
  },
};
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

  listReturns: async (): Promise<
    {
      id: string;
      number: number;
      total: number;
      refund_method: string;
      reason: string | null;
      created_at: string;
    }[]
  > => {
    const supabase = createClient();
    const { data } = await supabase
      .from("sale_returns")
      .select("id, number, total, refund_method, reason, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    return (data ?? []) as never;
  },

  numberFormat: async (): Promise<{ prefix: string; pad: number }> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("pos_settings")
      .select("sale_prefix, sale_pad")
      .maybeSingle();
    return {
      prefix: (data?.sale_prefix as string) ?? "",
      pad: Number(data?.sale_pad) || 0,
    };
  },

  return: async (
    saleId: string,
    items: ReturnItemInput[],
    reason: string,
    refund: "cash" | "store_credit",
  ): Promise<{ return_id: string; number: number; total: number }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("return_sale", {
      p_sale_id: saleId,
      p_items: items as unknown as Json,
      p_reason: reason || undefined,
      p_refund: refund,
    });
    if (error) throw error;
    return data as unknown as { return_id: string; number: number; total: number };
  },
};
