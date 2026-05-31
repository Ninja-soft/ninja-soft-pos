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
  };
}

export const customersApi = {
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
