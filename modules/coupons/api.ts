"use client";

// Cupones (F9 · H54). CRUD por tabla directa con RLS (escritura sólo owner/manager,
// enforced server-side) + validación read-only para el POS. La tabla no está en
// los tipos generados (no se regeneran): se castea el nombre de tabla / payload.

import { createClient } from "@/lib/supabase/client";

export interface Coupon {
  id: string;
  code: string;
  discount_type: "percent" | "amount";
  discount_value: number;
  min_amount: number;
  valid_from: string | null;
  valid_to: string | null;
  max_uses: number | null;
  used_count: number;
  max_per_customer: number | null;
  is_active: boolean;
}

export interface CouponInput {
  code: string;
  discount_type: "percent" | "amount";
  discount_value: number;
  min_amount?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  max_uses?: number | null;
  max_per_customer?: number | null;
  is_active?: boolean;
}

// Resultado de validar un código contra el subtotal (preview; NO consume el cupón).
export interface CouponValidation {
  ok: boolean;
  coupon_id?: string;
  code?: string;
  discount_type?: "percent" | "amount";
  discount_value?: number;
  min_amount?: number;
  discount?: number;
  reason?: string;
}

const COLS =
  "id, code, discount_type, discount_value, min_amount, valid_from, valid_to, max_uses, used_count, max_per_customer, is_active";

function toRow(input: CouponInput): Record<string, unknown> {
  return {
    code: input.code.trim(),
    discount_type: input.discount_type,
    discount_value: Math.max(0, Number(input.discount_value) || 0),
    min_amount: Math.max(0, Number(input.min_amount) || 0),
    valid_from: input.valid_from || null,
    valid_to: input.valid_to || null,
    max_uses: input.max_uses && input.max_uses > 0 ? Math.trunc(input.max_uses) : null,
    max_per_customer:
      input.max_per_customer && input.max_per_customer > 0
        ? Math.trunc(input.max_per_customer)
        : null,
    is_active: input.is_active ?? true,
  };
}

export const couponsApi = {
  list: async (): Promise<Coupon[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("coupons" as never)
      .select(COLS)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as Coupon[];
  },

  create: async (input: CouponInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("coupons" as never)
      .insert(toRow(input) as never)
      .select("id")
      .single();
    if (error) throw error;
    return (data as unknown as { id: string }).id;
  },

  update: async (id: string, input: CouponInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("coupons" as never)
      .update(toRow(input) as never)
      .eq("id", id);
    if (error) throw error;
  },

  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("coupons" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Valida un código contra el subtotal actual (preview para el POS). NO consume.
  validate: async (
    code: string,
    subtotal: number,
    customerId?: string | null,
  ): Promise<CouponValidation> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("validate_coupon" as never, {
      p_code: code,
      p_subtotal: subtotal,
      p_customer_id: customerId ?? undefined,
    } as never);
    if (error) throw error;
    return (data ?? { ok: false, reason: "error" }) as unknown as CouponValidation;
  },
};
