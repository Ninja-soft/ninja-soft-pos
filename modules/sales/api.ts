import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";
import type { Paged } from "@/lib/utils/pagination";

export interface ReturnItemInput {
  sale_item_id: string;
  quantity: number;
  restock: "stock" | "review" | "discard";
}

export type Sale = Tables<"sales">;
export type SaleRow = Sale & { customers: { name: string } | null };
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

export type SaleWithCustomer = Sale & {
  customers: { name: string; email: string | null } | null;
};

export interface SaleDetail {
  sale: SaleWithCustomer;
  items: SaleItem[];
  payments: Payment[];
}

export interface SalesPageParams {
  page: number; // 1-based
  pageSize: number;
  search?: string;
  status?: string; // 'completed' | 'voided' | ''
  range?: { from?: Date; to?: Date };
}

// Solo dígitos del N°: evita romper filtros / inyección.
function searchToNumber(search: string): number | null {
  const digits = search.replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export const salesApi = {
  // Listado paginado server-side (.range + count exact). Búsqueda server-side:
  // si el texto tiene dígitos se interpreta como N° de comprobante (match exacto
  // sobre sales.number, tolerante a prefijo/ceros); si es texto se busca por
  // nombre de cliente (ilike con inner join). Nunca tira error si está vacío.
  listPaged: async (params: SalesPageParams): Promise<Paged<SaleRow>> => {
    const supabase = createClient();
    const { page, pageSize, search, status, range } = params;
    const start = Math.max(0, (page - 1) * pageSize);
    const end = start + pageSize - 1;
    const q = (search ?? "").trim();
    const asNumber = q ? searchToNumber(q) : null;
    // Búsqueda por nombre solo si el texto tiene letras (no es un N°).
    const byName = q.length > 0 && asNumber === null;

    let query = supabase
      .from("sales")
      .select(byName ? "*, customers!inner(name)" : "*, customers(name)", {
        count: "exact",
      })
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);
    if (range?.from) query = query.gte("created_at", range.from.toISOString());
    if (range?.to) {
      const rangeEnd = new Date(range.to);
      rangeEnd.setHours(23, 59, 59, 999);
      query = query.lte("created_at", rangeEnd.toISOString());
    }
    if (asNumber !== null) query = query.eq("number", asNumber);
    if (byName) query = query.ilike("customers.name", `%${q}%`);

    const { data, error, count } = await query.range(start, end);
    if (error) throw error;
    return { rows: (data ?? []) as unknown as SaleRow[], total: count ?? 0 };
  },

  // Filas para exportar respetando los filtros activos (sin paginar). Tope alto
  // para no traer cantidades extremas de una sola vez.
  exportRows: async (
    params: Omit<SalesPageParams, "page" | "pageSize"> & { limit?: number },
  ): Promise<SaleRow[]> => {
    const { rows } = await salesApi.listPaged({
      ...params,
      page: 1,
      pageSize: params.limit ?? 5000,
    });
    return rows;
  },

  list: async (range?: { from?: Date; to?: Date }): Promise<SaleRow[]> => {
    const supabase = createClient();
    let q = supabase
      .from("sales")
      .select("*, customers(name)")
      .order("created_at", { ascending: false })
      // Sin rango: últimas 100. Con rango: tope alto para cubrir el período.
      .limit(range?.from || range?.to ? 1000 : 100);
    if (range?.from) q = q.gte("created_at", range.from.toISOString());
    if (range?.to) {
      const end = new Date(range.to);
      end.setHours(23, 59, 59, 999);
      q = q.lte("created_at", end.toISOString());
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as SaleRow[];
  },

  get: async (id: string): Promise<SaleDetail> => {
    const supabase = createClient();
    const [saleRes, itemsRes, paymentsRes] = await Promise.all([
      supabase.from("sales").select("*, customers(name, email)").eq("id", id).single(),
      supabase.from("sale_items").select("*").eq("sale_id", id),
      supabase.from("payments").select("*").eq("sale_id", id),
    ]);
    if (saleRes.error) throw saleRes.error;
    return {
      sale: saleRes.data as unknown as SaleWithCustomer,
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

  // Búsqueda server-side de ventas completadas por N° de comprobante (exacto).
  byNumber: async (n: number): Promise<Sale[]> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("sales")
      .select("*")
      .eq("number", n)
      .eq("status", "completed")
      .limit(10);
    return (data ?? []) as Sale[];
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
