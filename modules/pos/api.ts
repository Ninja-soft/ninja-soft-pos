import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";

export type CashShift = Tables<"cash_shifts">;
export type CashRegister = Tables<"cash_registers">;

export interface SalePaymentInput {
  method: "cash" | "debit" | "credit" | "transfer" | "qr" | "other";
  amount: number;
  reference?: string;
}
export interface SaleItemInput {
  product_id: string | null; // null = ítem de monto libre (venta rápida)
  name?: string; // nombre del ítem libre (cuando product_id es null)
  quantity: number;
  unit_price: number;
  discount: number;
}
export interface CreateSaleResult {
  sale_id: string;
  number: number;
  total: number;
}

export const posApi = {
  defaultRegister: async (): Promise<CashRegister | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("cash_registers")
      .select("*")
      .eq("is_active", true)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  openShift: async (): Promise<CashShift | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("cash_shifts")
      .select("*")
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  open: async (registerId: string, opening: number): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("open_cash_shift", {
      p_register_id: registerId,
      p_opening_amount: opening,
    });
    if (error) throw error;
    return data as string;
  },

  close: async (
    shiftId: string,
    closing: number,
    notes?: string,
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("close_cash_shift", {
      p_shift_id: shiftId,
      p_closing_amount: closing,
      p_notes: notes,
    });
    if (error) throw error;
    return data as number;
  },

  createSale: async (
    items: SaleItemInput[],
    payments: SalePaymentInput[],
    discountTotal: number,
  ): Promise<CreateSaleResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_sale", {
      p_items: items as unknown as Json,
      p_payments: payments as unknown as Json,
      p_discount_total: discountTotal,
    });
    if (error) throw error;
    return data as unknown as CreateSaleResult;
  },
};
