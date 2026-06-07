import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";

export type CashMovement = Tables<"cash_movements">;
export type ZClosure = Tables<"cash_z_closures">;

export interface ShiftSummary {
  opening: number;
  income: number;
  expense: number;
  salesTotal: number; // ventas netas (sale − sale_void)
  cashExpected: number; // efectivo esperado en caja
  byMethod: Record<string, number>; // ventas netas por medio de pago
}

export const cashApi = {
  movements: async (shiftId: string): Promise<CashMovement[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("cash_movements")
      .select("*")
      .eq("cash_shift_id", shiftId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CashMovement[];
  },

  addMovement: async (
    shiftId: string,
    type: "income" | "expense",
    amount: number,
    reason: string,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("cash_movements").insert({
      cash_shift_id: shiftId,
      type,
      amount,
      reason,
    });
    if (error) throw error;
  },

  // Historial inmutable de cierres Z (más reciente primero).
  zClosures: async (range?: { from?: Date; to?: Date }): Promise<ZClosure[]> => {
    const supabase = createClient();
    let query = supabase
      .from("cash_z_closures")
      .select("*")
      .order("z_number", { ascending: false })
      .order("closed_at", { ascending: false });
    if (range?.from) {
      const from = new Date(range.from);
      from.setHours(0, 0, 0, 0);
      query = query.gte("closed_at", from.toISOString());
    }
    if (range?.to) {
      const to = new Date(range.to);
      to.setHours(23, 59, 59, 999);
      query = query.lte("closed_at", to.toISOString());
    }
    const { data, error } = await query.limit(100);
    if (error) throw error;
    return (data ?? []) as ZClosure[];
  },
};

export function summarize(
  opening: number,
  movements: CashMovement[],
): ShiftSummary {
  let income = 0;
  let expense = 0;
  let salesTotal = 0;
  const byMethod: Record<string, number> = {};
  let cashFromSales = 0;

  for (const m of movements) {
    if (m.type === "income") income += m.amount;
    else if (m.type === "expense") expense += m.amount;
    else if (m.type === "sale") {
      salesTotal += m.amount;
      const k = m.payment_method ?? "other";
      byMethod[k] = (byMethod[k] ?? 0) + m.amount;
      if (m.payment_method === "cash") cashFromSales += m.amount;
    } else if (m.type === "sale_void") {
      salesTotal -= m.amount;
      const k = m.payment_method ?? "other";
      byMethod[k] = (byMethod[k] ?? 0) - m.amount;
      if (m.payment_method === "cash") cashFromSales -= m.amount;
    }
  }

  const cashExpected = opening + income - expense + cashFromSales;
  return { opening, income, expense, salesTotal, cashExpected, byMethod };
}
