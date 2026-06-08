import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";
import type { Paged } from "@/lib/utils/pagination";

// types/database.ts no se regenera en este PR: las RPC nuevas (return_sale_v2,
// lookup/redeem voucher) y la tabla store_credit_vouchers aún no están tipadas.
// looseClient expone rpc()/from() sin el tipado estricto del schema para esas
// llamadas puntuales (mismo enfoque que modules/internal/api.ts). La DB valida.
interface LooseClient {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (cols: string) => {
      order: (
        col: string,
        opts?: { ascending?: boolean },
      ) => { limit: (n: number) => Promise<{ data: unknown; error: unknown }> };
    };
  };
}
function looseClient(): LooseClient {
  return createClient() as unknown as LooseClient;
}

export interface ReturnItemInput {
  sale_item_id: string;
  quantity: number;
  // restock: legacy (return_sale H29). En return_sale_v2 el destino lo fija el motivo.
  restock?: "stock" | "review" | "discard";
}

export type Sale = Tables<"sales">;
export type SaleRow = Sale & { customers: { name: string } | null };

// Destino de stock de un motivo de devolución (devoluciones PRO).
//   resale    → reingresa a stock vendible.
//   warehouse → a depósito (no reingresa a venta).
//   loss      → pérdida / merma (no reingresa).
//   review    → a revisión (no reingresa).
export type StockDestination = "resale" | "warehouse" | "loss" | "review";

// return_reasons aún no está en los tipos generados con los campos nuevos
// (code/stock_destination/deleted_at). Tipamos explícito; la DB valida.
export interface ReturnReason {
  id: string;
  tenant_id: string;
  label: string;
  code: string | null;
  stock_destination: StockDestination;
  sort: number;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
}

export interface ReturnReasonInput {
  label: string;
  code: string | null;
  stock_destination: StockDestination;
  sort: number;
  is_active: boolean;
}

export const STOCK_DESTINATIONS: { value: StockDestination; label: string; hint: string }[] = [
  { value: "resale", label: "Vuelve a la venta", hint: "Reingresa a stock vendible" },
  { value: "warehouse", label: "A depósito", hint: "Sale del stock vendible" },
  { value: "loss", label: "Pérdida / merma", hint: "No reingresa" },
  { value: "review", label: "A revisión", hint: "No reingresa hasta revisar" },
];

// Normaliza el payload de un motivo: code en slug (minúsculas), null si vacío.
function reasonPayload(input: Partial<ReturnReasonInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.label !== undefined) out.label = input.label.trim();
  if (input.code !== undefined) {
    const c = (input.code ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    out.code = c || null;
  }
  if (input.stock_destination !== undefined) out.stock_destination = input.stock_destination;
  if (input.sort !== undefined) out.sort = input.sort;
  if (input.is_active !== undefined) out.is_active = input.is_active;
  return out;
}

export const returnReasonsApi = {
  list: async (activeOnly = true): Promise<ReturnReason[]> => {
    const supabase = createClient();
    let q = supabase
      .from("return_reasons")
      .select("*")
      .is("deleted_at", null)
      .order("sort")
      .order("label");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as unknown as ReturnReason[];
  },
  create: async (input: ReturnReasonInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("return_reasons")
      .insert(reasonPayload(input) as never);
    if (error) throw error;
  },
  update: async (id: string, input: Partial<ReturnReasonInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("return_reasons")
      .update(reasonPayload(input) as never)
      .eq("id", id);
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
  // Baja lógica (deleted_at): los motivos pueden estar referenciados por
  // devoluciones históricas; nunca se borran físicamente.
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("return_reasons")
      .update({ deleted_at: new Date().toISOString(), is_active: false } as never)
      .eq("id", id);
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

  // Devolución PRO (return_sale_v2): el motivo fija el destino de stock, la
  // política del tenant puede forzar el reintegro, y si es vale se emite un
  // comprobante con código único (+ scoping de sucursales) — todo auditado.
  returnV2: async (input: {
    saleId: string;
    items: { sale_item_id: string; quantity: number }[];
    reasonId: string | null;
    refund: "cash" | "store_credit";
    customerId?: string | null;
    allowedBranchIds?: string[] | null;
  }): Promise<ReturnV2Result> => {
    const { data, error } = await looseClient().rpc("return_sale_v2", {
      p_sale_id: input.saleId,
      p_items: input.items as unknown as Json,
      p_reason_id: input.reasonId ?? undefined,
      p_refund: input.refund,
      p_customer_id: input.customerId ?? undefined,
      p_allowed_branch_ids: input.allowedBranchIds ?? undefined,
    });
    if (error) throw error;
    return data as unknown as ReturnV2Result;
  },

  // CAMBIO con diferencia (exchange_sale): orquesta devolución + venta nueva en
  // una transacción atómica y auditada. El valor devuelto se aplica como crédito
  // a la compra nueva; la diferencia (>0) se cobra por differencePayments y el
  // sobrante (<0) va a efectivo o vale según surplusTo / la política del tenant.
  // exchange_sale aún no está en los tipos generados (no se regeneran): looseClient.
  exchange: async (input: {
    saleId: string;
    returnItems: { sale_item_id: string; quantity: number }[];
    newItems: ExchangeNewItem[];
    differencePayments?: { method: string; amount: number; reference?: string }[];
    reasonId?: string | null;
    newDiscount?: number;
    customerId?: string | null;
    allowedBranchIds?: string[] | null;
    surplusTo?: "cash" | "store_credit" | null;
    notes?: string | null;
  }): Promise<ExchangeResult> => {
    const { data, error } = await looseClient().rpc("exchange_sale", {
      p_sale_id: input.saleId,
      p_return_items: input.returnItems as unknown as Json,
      p_new_items: input.newItems as unknown as Json,
      p_difference_payments: (input.differencePayments ?? []) as unknown as Json,
      p_reason_id: input.reasonId ?? undefined,
      p_new_discount: input.newDiscount ?? 0,
      p_customer_id: input.customerId ?? undefined,
      p_allowed_branch_ids: input.allowedBranchIds ?? undefined,
      p_surplus_to: input.surplusTo ?? undefined,
      p_notes: input.notes ?? undefined,
    });
    if (error) throw error;
    return data as unknown as ExchangeResult;
  },
};

// Ítem nuevo del cambio (mismo formato que SaleItemInput de create_sale).
export interface ExchangeNewItem {
  product_id: string | null;
  name?: string;
  serial?: string;
  variant_id?: string | null;
  quantity: number;
  unit_price: number;
  discount: number;
}

export interface ExchangeResult {
  return_id: string;
  return_number: number;
  voucher_code: string | null;
  sale_id: string;
  sale_number: number;
  returned: number;
  new_total: number;
  credit_applied: number;
  difference: number; // >0 cobrada, <0 sobrante, =0 par
  surplus: number;
  surplus_to: "cash" | "store_credit" | null;
}

export interface ReturnV2Result {
  return_id: string;
  number: number;
  total: number;
  refund: "cash" | "store_credit";
  stock_destination: StockDestination;
  voucher_code: string | null;
  voucher_expires_at: string | null;
}

// Política de devolución + validez de vale (pos_settings, sección Devoluciones).
export type ReturnPolicy = "cashier_choice" | "always_credit" | "always_cash";

export interface ReturnSettings {
  return_policy: ReturnPolicy;
  voucher_validity_months: number | null;
}

export const returnSettingsApi = {
  get: async (): Promise<ReturnSettings> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("pos_settings")
      .select("return_policy, voucher_validity_months")
      .maybeSingle();
    const d = data as { return_policy?: string; voucher_validity_months?: number | null } | null;
    return {
      return_policy: (d?.return_policy as ReturnPolicy) ?? "cashier_choice",
      voucher_validity_months: d?.voucher_validity_months ?? null,
    };
  },
  save: async (tenantId: string, input: ReturnSettings): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("pos_settings").upsert(
      {
        tenant_id: tenantId,
        return_policy: input.return_policy,
        voucher_validity_months: input.voucher_validity_months,
      } as never,
      { onConflict: "tenant_id" },
    );
    if (error) throw error;
  },
};

// Sucursales del tenant (para el scoping del vale en multi-sucursal).
export interface Branch {
  id: string;
  name: string;
  is_default: boolean;
}

export const branchesApi = {
  list: async (): Promise<Branch[]> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("stores")
      .select("id, name, is_default")
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .order("created_at");
    return (data ?? []) as Branch[];
  },
};

// Vales (store_credit_vouchers): emisión la hace return_sale_v2; acá listamos y
// canjeamos por código en el POS.
export interface VoucherLookup {
  id: string;
  code: string;
  amount: number;
  customer_id: string | null;
  allowed_branch_ids: string[] | null;
  expires_at: string | null;
  status: "active" | "redeemed" | "void" | "expired";
}

export const vouchersApi = {
  // Previsualiza un vale por código (estado efectivo: contempla vencimiento).
  lookup: async (code: string): Promise<VoucherLookup | null> => {
    const { data, error } = await looseClient().rpc("lookup_store_credit_voucher", {
      p_code: code,
    });
    if (error) throw error;
    return (data as unknown as VoucherLookup | null) ?? null;
  },
  // Canjea un vale por código: acredita el saldo a favor del cliente y lo marca
  // como canjeado (valida vencimiento, estado y sucursal en la DB).
  redeem: async (input: {
    code: string;
    customerId?: string | null;
    storeId?: string | null;
  }): Promise<{ voucher_id: string; amount: number; customer_id: string }> => {
    const { data, error } = await looseClient().rpc("redeem_store_credit_voucher", {
      p_code: input.code,
      p_customer_id: input.customerId ?? undefined,
      p_store_id: input.storeId ?? undefined,
    });
    if (error) throw error;
    return data as unknown as { voucher_id: string; amount: number; customer_id: string };
  },
  // Vales emitidos recientemente (para la sección de devoluciones).
  listRecent: async (): Promise<
    {
      id: string;
      code: string;
      amount: number;
      status: string;
      expires_at: string | null;
      created_at: string;
      customer_id: string | null;
    }[]
  > => {
    const { data } = await looseClient()
      .from("store_credit_vouchers")
      .select("id, code, amount, status, expires_at, created_at, customer_id")
      .order("created_at", { ascending: false })
      .limit(30);
    return (data ?? []) as never;
  },
};
