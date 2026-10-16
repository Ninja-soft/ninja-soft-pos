import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { Tables } from "@/types/database";
import { withSupervisor } from "@/modules/security/supervisor";
import type { BranchOverview } from "@/lib/branches/monitorAlerts";

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

// Turno abierto visto por el monitor de cajas (cash_monitor, ADR-051 · H115).
export interface MonitorShift {
  shift_id: string;
  store_id: string;
  store_name: string;
  store_short: string | null;
  store_color: string | null;
  register_id: string;
  register_name: string;
  register_code: string | null;
  opened_by: string;
  opened_by_name: string;
  opened_by_avatar: string | null;
  opened_by_role: string | null;
  opened_at: string;
  opening_amount: number;
  is_mine: boolean;
  sales_total: number;
  sales_count: number;
  voids_count: number;
  cash_in: number;
  cash_out: number;
  cash_expected: number;
  last_activity_at: string;
}

type LooseRpc = { rpc: <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }> };

export const cashApi = {
  // Cajas abiertas (dueño y encargado: su alcance; el resto: la propia).
  monitor: async (storeId?: string | null): Promise<MonitorShift[]> => {
    const sb = createClient() as unknown as LooseRpc;
    const { data, error } = await sb.rpc<MonitorShift[]>("cash_monitor", { p_store_id: storeId ?? null });
    if (error) {
      // Base sin la migración de ADR-051 (deploy: front primero): sin datos.
      if (/Could not find the function|PGRST202|does not exist/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    return (data ?? []).map((r) => ({
      ...r,
      opening_amount: Number(r.opening_amount),
      sales_total: Number(r.sales_total),
      sales_count: Number(r.sales_count),
      voids_count: Number(r.voids_count),
      cash_in: Number(r.cash_in),
      cash_out: Number(r.cash_out),
      cash_expected: Number(r.cash_expected),
    }));
  },

  // Vista general por sucursal (branch_monitor_overview, ADR-057): dueño y
  // encargado. Sin la migración o sin permiso: lista vacía (la grilla se oculta).
  branchOverview: async (): Promise<BranchOverview[]> => {
    const sb = createClient() as unknown as LooseRpc;
    const { data, error } = await sb.rpc<BranchOverview[]>("branch_monitor_overview");
    if (error) {
      if (/Could not find the function|PGRST202|does not exist|forbidden|42501/i.test(error.message)) return [];
      throw new Error(error.message);
    }
    return (data ?? []).map((r) => ({
      ...r,
      registers_total: Number(r.registers_total) || 0,
      registers_open: Number(r.registers_open) || 0,
      open_shifts: r.open_shifts ?? [],
      sales_today_total: Number(r.sales_today_total) || 0,
      sales_today_count: Number(r.sales_today_count) || 0,
      staff_on_shift: Number(r.staff_on_shift) || 0,
      staff_assigned: Number(r.staff_assigned) || 0,
      low_stock_count: Number(r.low_stock_count) || 0,
      pending_waiting: Number(r.pending_waiting) || 0,
      pending_waiting_amount: Number(r.pending_waiting_amount) || 0,
      pending_paid_unsold: Number(r.pending_paid_unsold) || 0,
      terminals: r.terminals ?? [],
      last_z: r.last_z ? { ...r.last_z, difference: Number(r.last_z.difference) || 0 } : null,
      close_tolerance: Number(r.close_tolerance) || 0,
    }));
  },

  // Cierre forzado de un turno ajeno (supervisor por rol o con PIN; motivo).
  forceClose: async (shiftId: string, closing: number, reason: string): Promise<{ difference: number }> => {
    const sb = createClient() as unknown as LooseRpc;
    const run = async () => {
      const { data, error } = await sb.rpc<{ difference: number }>("cash_force_close", {
        p_shift_id: shiftId,
        p_closing_amount: closing,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return { difference: Number(data?.difference ?? 0) };
    };
    return withSupervisor(run, { shift_force_close: null });
  },

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
    treasuryAccountId: string | null = null,
  ): Promise<void> => {
    const supabase = createClient();
    // ADR-051 (H114 + H116): sólo en el turno propio; el retiro o ingreso sobre
    // el umbral pide PIN de supervisor y se reintenta con el token.
    // ADR-162 (H151): el retiro puede ir a una caja fuerte o un banco de
    // Tesorería (y el ingreso salir de ahí); el servidor valida la cuenta.
    const run = async () => {
      const { error } = await supabase.from("cash_movements").insert({
        cash_shift_id: shiftId,
        type,
        amount,
        reason,
        ...(treasuryAccountId ? { treasury_account_id: treasuryAccountId } : {}),
      } as never);
      if (error) throw error;
    };
    await withSupervisor(run, { cash_out: amount, cash_in: amount });
  },

  // Conciliación del Z (H156, ADR-158): el encargado revisa una diferencia y
  // deja el tipo y el motivo. Auditado en el servidor.
  reviewZ: async (id: string, kind: string, reason: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("cash_z_review" as never, { p_id: id, p_kind: kind, p_reason: reason } as never);
    if (error) throw error;
  },

  // Historial inmutable de cierres Z (más reciente primero).
  // storeId (F17 · H90): sucursal del filtro global; null = todas las visibles.
  // registerId (F17 · H97): sólo los Z de esa caja.
  zClosures: async (
    range?: { from?: Date; to?: Date },
    storeId?: string | null,
    registerId?: string | null,
  ): Promise<ZClosure[]> => {
    const supabase = createClient();
    const tenantId = await getCurrentTenantId();
    let query = supabase
      .from("cash_z_closures")
      .select("*")
      .order("z_number", { ascending: false })
      .order("closed_at", { ascending: false });
    if (tenantId) query = query.eq("tenant_id", tenantId);
    if (storeId) query = query.eq("store_id", storeId);
    if (registerId) query = query.eq("cash_register_id", registerId);
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
