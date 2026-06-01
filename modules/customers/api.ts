import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/types/database";
import type { CustomerOutput } from "./schemas";
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
  // Saldo a favor (vale) del cliente = suma de movimientos de store credit.
  storeCreditBalance: async (customerId: string): Promise<number> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("store_credit_movements")
      .select("delta")
      .eq("customer_id", customerId);
    return (data ?? []).reduce((acc, r) => acc + Number(r.delta || 0), 0);
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
