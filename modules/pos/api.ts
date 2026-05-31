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
  serial?: string; // N° de serie (producto serializado)
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

  // ¿El tenant tiene Mercado Pago habilitado y conectado?
  mpMethod: async (): Promise<{ enabled: boolean; connected: boolean }> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("tenant_payment_methods")
      .select("enabled, config")
      .eq("provider_key", "mercadopago")
      .maybeSingle();
    return {
      enabled: Boolean(data?.enabled),
      connected: Boolean((data?.config as { connected?: boolean } | null)?.connected),
    };
  },

  // Crea la preferencia/QR de cobro y devuelve el init_point.
  createMpQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_create_qr", {
      body: { amount, title },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  // Estado en vivo del intent (el POS consulta mientras espera el pago).
  mpIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("mp_payment_intents")
      .select("status, mp_payment_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return {
      status: data?.status ?? "pending",
      mp_payment_id: data?.mp_payment_id ?? null,
    };
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
