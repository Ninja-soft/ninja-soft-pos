import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { CustomerOutput, CustomerRequired } from "./schemas";
import type { ParsedCustomer } from "./import";

export type Customer = Tables<"customers">;

function payload(input: CustomerOutput) {
  return {
    name: input.name,
    document_type: input.document_type ?? null,
    document_number: input.document_number,
    iva_condition: input.iva_condition ?? null,
    email: input.email,
    phone: input.phone,
    address: input.address,
    birth_date: input.birth_date,
    notes: input.notes,
    is_active: input.is_active,
    credit_limit: input.credit_limit ?? 0,
    group_id: input.group_id ?? null,
  };
}

export type CustomerGroup = Tables<"customer_groups">;

export const customerGroupsApi = {
  list: async (activeOnly = true): Promise<CustomerGroup[]> => {
    const supabase = createClient();
    let q = supabase.from("customer_groups").select("*").order("sort").order("name");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as CustomerGroup[];
  },
  create: async (name: string): Promise<CustomerGroup> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("customer_groups")
      .insert({ name })
      .select("*")
      .single();
    if (error) throw error;
    return data as CustomerGroup;
  },
};

export const customersApi = {
  // Config del tenant: qué campos del cliente son obligatorios (H31).
  requiredFields: async (): Promise<CustomerRequired> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("pos_settings")
      .select("customer_required")
      .maybeSingle();
    return ((data?.customer_required as CustomerRequired) ?? {}) as CustomerRequired;
  },

  // Saldo a favor (vale) del cliente = suma de movimientos de store credit.
  storeCreditBalance: async (customerId: string): Promise<number> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("store_credit_movements")
      .select("delta")
      .eq("customer_id", customerId);
    return (data ?? []).reduce((acc, r) => acc + Number(r.delta || 0), 0);
  },

  // Cuentas por cobrar: deuda por cliente con buckets de antigüedad (FIFO).
  // Los pagos cancelan los cargos más viejos primero; lo que queda se ubica en
  // el tramo según su antigüedad (0-30 / 31-60 / 61-90 / +90 días).
  accountsReceivable: async (): Promise<{
    rows: {
      customer_id: string;
      name: string;
      total: number;
      b0_30: number;
      b31_60: number;
      b61_90: number;
      b90plus: number;
    }[];
    totals: { total: number; b0_30: number; b31_60: number; b61_90: number; b90plus: number };
  }> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("customer_account_movements")
      .select("customer_id, delta, created_at, customers(name)")
      .order("created_at", { ascending: true });
    if (error) throw error;

    type Row = {
      customer_id: string;
      delta: number;
      created_at: string;
      customers: { name: string } | null;
    };
    const byCustomer = new Map<
      string,
      { name: string; charges: { amount: number; date: number }[] }
    >();

    for (const m of (data ?? []) as unknown as Row[]) {
      if (!m.customer_id) continue;
      const entry =
        byCustomer.get(m.customer_id) ??
        { name: m.customers?.name ?? "—", charges: [] };
      if (!byCustomer.has(m.customer_id)) byCustomer.set(m.customer_id, entry);
      const delta = Number(m.delta) || 0;
      if (delta > 0) {
        entry.charges.push({ amount: delta, date: new Date(m.created_at).getTime() });
      } else if (delta < 0) {
        // pago: cancela cargos más viejos primero
        let pay = -delta;
        while (pay > 0 && entry.charges.length > 0) {
          const head = entry.charges[0]!;
          if (head.amount <= pay) {
            pay -= head.amount;
            entry.charges.shift();
          } else {
            head.amount -= pay;
            pay = 0;
          }
        }
      }
    }

    const now = Date.now();
    const DAY = 86_400_000;
    const totals = { total: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
    const rows = [...byCustomer.entries()]
      .map(([customer_id, e]) => {
        const r = { customer_id, name: e.name, total: 0, b0_30: 0, b31_60: 0, b61_90: 0, b90plus: 0 };
        for (const c of e.charges) {
          const days = (now - c.date) / DAY;
          r.total += c.amount;
          if (days <= 30) r.b0_30 += c.amount;
          else if (days <= 60) r.b31_60 += c.amount;
          else if (days <= 90) r.b61_90 += c.amount;
          else r.b90plus += c.amount;
        }
        return r;
      })
      .filter((r) => r.total > 0.009)
      .sort((a, b) => b.total - a.total);

    for (const r of rows) {
      totals.total += r.total;
      totals.b0_30 += r.b0_30;
      totals.b31_60 += r.b31_60;
      totals.b61_90 += r.b61_90;
      totals.b90plus += r.b90plus;
    }
    return { rows, totals };
  },

  // Registra un pago de deuda de cuenta corriente (reduce la deuda).
  payDebt: async (customerId: string, amount: number): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("customer_account_movements")
      .insert({ customer_id: customerId, delta: -Math.abs(amount), reason: "Pago de deuda" });
    if (error) throw error;
  },

  // Historial del cliente: saldo a favor + ventas + devoluciones.
  history: async (
    customerId: string,
  ): Promise<{
    creditBalance: number;
    accountDebt: number;
    sales: { id: string; number: number; total: number; status: string; created_at: string }[];
    returns: { id: string; number: number; total: number; refund_method: string; created_at: string }[];
  }> => {
    const supabase = createClient();
    const [creditRes, debtRes, salesRes, returnsRes] = await Promise.all([
      supabase.from("store_credit_movements").select("delta").eq("customer_id", customerId),
      supabase.from("customer_account_movements").select("delta").eq("customer_id", customerId),
      supabase
        .from("sales")
        .select("id, number, total, status, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("sale_returns")
        .select("id, number, total, refund_method, created_at")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    return {
      creditBalance: (creditRes.data ?? []).reduce((a, r) => a + Number(r.delta || 0), 0),
      accountDebt: (debtRes.data ?? []).reduce((a, r) => a + Number(r.delta || 0), 0),
      sales: (salesRes.data ?? []) as never,
      returns: (returnsRes.data ?? []) as never,
    };
  },

  list: async (search?: string): Promise<Customer[]> => {
    const supabase = createClient();
    let q = supabase
      .from("customers")
      .select("*")
      .is("deleted_at", null)
      .order("name")
      .limit(200);
    if (search && search.trim()) {
      const s = search.trim();
      q = q.or(`name.ilike.%${s}%,document_number.ilike.%${s}%`);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Customer[];
  },

  create: async (input: CustomerOutput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("customers").insert(payload(input));
    if (error) throw error;
  },

  update: async (id: string, input: CustomerOutput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("customers")
      .update(payload(input))
      .eq("id", id);
    if (error) throw error;
  },

  bulkImport: async (rows: ParsedCustomer[]): Promise<number> => {
    if (rows.length === 0) return 0;
    const supabase = createClient();
    const { error } = await supabase
      .from("customers")
      .insert(rows.map((r) => ({ ...r, is_active: true })));
    if (error) throw error;
    return rows.length;
  },

  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("customers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
};
