import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";

export type CashShift = Tables<"cash_shifts">;
export type CashRegister = Tables<"cash_registers">;

export interface SalePaymentInput {
  method: "cash" | "debit" | "credit" | "transfer" | "qr" | "other" | "store_credit";
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

export type PaymentPlan = Tables<"payment_plans">;
export interface PaymentPlanInput {
  label: string;
  base: string;
  brand: string | null;
  installments: number;
  surcharge_pct: number;
  sort?: number;
  code?: string | null;
}

// Planes típicos de Argentina para el seeder "Cargar planes AR".
export const TYPICAL_AR_PLANS: (PaymentPlanInput & { code: string })[] = [
  { code: "debito_visa", label: "Débito Visa", base: "debito", brand: "visa", installments: 1, surcharge_pct: 0, sort: 10 },
  { code: "debito_master", label: "Débito Mastercard", base: "debito", brand: "master", installments: 1, surcharge_pct: 0, sort: 11 },
  { code: "debito_maestro", label: "Débito Maestro", base: "debito", brand: "maestro", installments: 1, surcharge_pct: 0, sort: 12 },
  { code: "debito_cabal", label: "Débito Cabal", base: "debito", brand: "cabal", installments: 1, surcharge_pct: 0, sort: 13 },
  { code: "credito_1_pago", label: "Crédito 1 pago", base: "credito", brand: null, installments: 1, surcharge_pct: 0, sort: 20 },
  { code: "cuota_simple_3", label: "Cuota Simple 3", base: "credito", brand: null, installments: 3, surcharge_pct: 0, sort: 21 },
  { code: "cuota_simple_6", label: "Cuota Simple 6", base: "credito", brand: null, installments: 6, surcharge_pct: 0, sort: 22 },
  { code: "cuota_simple_12", label: "Cuota Simple 12", base: "credito", brand: null, installments: 12, surcharge_pct: 0, sort: 23 },
  { code: "credito_3", label: "Crédito 3 cuotas", base: "credito", brand: null, installments: 3, surcharge_pct: 0, sort: 30 },
  { code: "credito_6", label: "Crédito 6 cuotas", base: "credito", brand: null, installments: 6, surcharge_pct: 0, sort: 31 },
  { code: "credito_12", label: "Crédito 12 cuotas", base: "credito", brand: null, installments: 12, surcharge_pct: 0, sort: 32 },
];

export const paymentPlansApi = {
  list: async (activeOnly = true): Promise<PaymentPlan[]> => {
    const supabase = createClient();
    let q = supabase.from("payment_plans").select("*").order("sort").order("label");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as PaymentPlan[];
  },
  create: async (v: PaymentPlanInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").insert({
      label: v.label,
      base: v.base,
      brand: v.brand,
      installments: v.installments,
      surcharge_pct: v.surcharge_pct,
      sort: v.sort ?? 0,
      code: v.code ?? null,
    });
    if (error) throw error;
  },
  // Inserta los planes AR que falten (ignora los que ya existen por code).
  seedTypical: async (
    rows: (PaymentPlanInput & { code: string })[],
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("payment_plans")
      .upsert(
        rows.map((r) => ({
          label: r.label,
          base: r.base,
          brand: r.brand,
          installments: r.installments,
          surcharge_pct: r.surcharge_pct,
          sort: r.sort ?? 0,
          code: r.code,
        })),
        { onConflict: "tenant_id,code", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    return (data ?? []).length;
  },
  update: async (id: string, v: Partial<PaymentPlanInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update(v).eq("id", id);
    if (error) throw error;
  },
  setActive: async (id: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update({ is_active }).eq("id", id);
    if (error) throw error;
  },
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").delete().eq("id", id);
    if (error) throw error;
  },
};

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

  // Settings operativos del POS (H30): descuento máximo por rol y redondeo.
  posSettings: async (): Promise<{
    maxDiscount: Record<string, number>;
    rounding: number;
    requireCustomer: boolean;
  } | null> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("pos_settings")
      .select("max_discount, rounding_multiple, require_customer")
      .maybeSingle();
    if (!data) return null;
    return {
      maxDiscount: (data.max_discount as Record<string, number>) ?? {},
      rounding: Number(data.rounding_multiple) || 0,
      requireCustomer: Boolean(data.require_customer),
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
    customerId?: string | null,
  ): Promise<CreateSaleResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_sale", {
      p_items: items as unknown as Json,
      p_payments: payments as unknown as Json,
      p_discount_total: discountTotal,
      p_customer_id: customerId ?? undefined,
    });
    if (error) throw error;
    return data as unknown as CreateSaleResult;
  },
};
