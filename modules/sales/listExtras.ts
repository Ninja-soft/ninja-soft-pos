"use client";

// Datos de presentación del listado de ventas (rediseño de /ventas): por cada
// venta de la página trae, en lote y sólo lectura, ítems con foto, cobros con
// su proveedor, estado fiscal, canal (delivery, mesa, envío / Mercado Libre),
// caja y cajero. Una consulta por tabla con `.in(...)` sobre los ids de la
// página: la RLS de cada tabla decide qué se ve. Si una tabla no responde
// (rol sin acceso o migración ausente) esa parte queda vacía, nunca rompe.
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isIntentRef } from "@/lib/sales/paymentDetail";
import { saleChannel, variantLabel, type SaleChannel } from "@/lib/sales/salesList";

export interface ListItem {
  id: string;
  sale_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  returned_qty: number;
  image_url: string | null;
}

export interface ListPayment {
  id: string;
  sale_id: string;
  method: string;
  amount: number;
  reference: string | null;
  card_voucher: Record<string, unknown> | null;
}

export interface ListFiscal {
  sale_id: string;
  origin: string;
  status: string;
  cae: string | null;
}

export interface SaleExtras {
  items: ListItem[];
  payments: ListPayment[];
  fiscal: ListFiscal[];
  channel: SaleChannel;
  registerName: string | null;
  cashierName: string | null;
}

export interface SalesExtrasMap {
  bySale: Map<string, SaleExtras>;
  /** id del intent → provider_key (logo del cobro). */
  intentProvider: Map<string, string>;
}

type SaleRef = {
  id: string;
  cash_shift_id?: string | null;
  created_by?: string | null;
  offline_client_id?: string | null;
};

// Cliente sin el tipado estricto: varias tablas/columnas no están en los tipos
// generados (no se regeneran). La base valida.
type Loose = {
  from: (t: string) => {
    select: (c: string) => {
      in: (col: string, vals: string[]) => Promise<{ data: unknown; error: unknown }>;
    };
  };
};
const loose = () => createClient() as unknown as Loose;

async function rowsIn<T>(table: string, cols: string, col: string, ids: string[]): Promise<T[]> {
  if (ids.length === 0) return [];
  try {
    const { data, error } = await loose().from(table).select(cols).in(col, ids);
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

export async function fetchSalesExtras(sales: SaleRef[]): Promise<SalesExtrasMap> {
  const ids = sales.map((s) => s.id);
  const shiftIds = uniq(sales.map((s) => s.cash_shift_id));
  const userIds = uniq(sales.map((s) => s.created_by));

  const [items, payments, fiscal, deliveries, tables, shipments, shifts, users] = await Promise.all([
    rowsIn<{
      id: string;
      sale_id: string;
      product_id: string | null;
      product_name: string;
      quantity: number;
      returned_qty: number | null;
      products: { image_url: string | null } | null;
    }>("sale_items", "id, sale_id, product_id, product_name, quantity, returned_qty, products(image_url)", "sale_id", ids),
    rowsIn<ListPayment>("payments", "id, sale_id, method, amount, reference, card_voucher", "sale_id", ids),
    rowsIn<ListFiscal>("fiscal_documents", "sale_id, origin, status, cae", "sale_id", ids),
    rowsIn<{ sale_id: string; order_type: string | null }>("delivery_orders", "sale_id, order_type", "sale_id", ids),
    rowsIn<{ sale_id: string }>("table_orders", "sale_id", "sale_id", ids),
    rowsIn<{ sale_id: string; source: string | null }>("shipments", "sale_id, source", "sale_id", ids),
    rowsIn<{ id: string; cash_registers: { name: string } | null }>("cash_shifts", "id, cash_registers(name)", "id", shiftIds),
    rowsIn<{ id: string; full_name: string | null; email: string | null }>("users", "id, full_name, email", "id", userIds),
  ]);

  const intentIds = uniq(payments.map((p) => p.reference).filter(isIntentRef));
  const intents = await rowsIn<{ id: string; provider_key: string }>("mp_payment_intents", "id, provider_key", "id", intentIds);
  const intentProvider = new Map(intents.map((i) => [i.id, i.provider_key]));

  const group = <T extends { sale_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.sale_id, [...(m.get(r.sale_id) ?? []), r]);
    return m;
  };
  const itemsBy = group(items);
  const paysBy = group(payments);
  const fiscalBy = group(fiscal);
  const deliveryBy = new Map(deliveries.map((d) => [d.sale_id, d]));
  const tableSet = new Set(tables.map((t) => t.sale_id));
  const shipBy = new Map(shipments.map((s) => [s.sale_id, s.source]));
  const registerBy = new Map(shifts.map((s) => [s.id, s.cash_registers?.name ?? null]));
  const userBy = new Map(users.map((u) => [u.id, (u.full_name ?? "").trim() || (u.email ?? "").split("@")[0] || null]));

  const bySale = new Map<string, SaleExtras>();
  for (const s of sales) {
    bySale.set(s.id, {
      items: (itemsBy.get(s.id) ?? []).map((it) => ({
        id: it.id,
        sale_id: it.sale_id,
        product_id: it.product_id,
        product_name: it.product_name,
        quantity: Number(it.quantity) || 0,
        returned_qty: Number(it.returned_qty) || 0,
        image_url: it.products?.image_url ?? null,
      })),
      payments: (paysBy.get(s.id) ?? []).map((p) => ({ ...p, amount: Number(p.amount) || 0 })),
      fiscal: fiscalBy.get(s.id) ?? [],
      channel: saleChannel({
        delivery: deliveryBy.get(s.id) ?? null,
        table: tableSet.has(s.id),
        shipmentSource: shipBy.get(s.id) ?? null,
        offline: Boolean(s.offline_client_id),
      }),
      registerName: s.cash_shift_id ? (registerBy.get(s.cash_shift_id) ?? null) : null,
      cashierName: s.created_by ? (userBy.get(s.created_by) ?? null) : null,
    });
  }
  return { bySale, intentProvider };
}

/** Extras de las ventas de la página (o de una sola, en el detalle). */
export function useSalesExtras(sales: SaleRef[], enabled = true) {
  const key = sales.map((s) => s.id).join(",");
  return useQuery({
    queryKey: ["sales", "list-extras", key],
    enabled: enabled && sales.length > 0,
    staleTime: 30_000,
    queryFn: () => fetchSalesExtras(sales),
  });
}

export interface DetailExtras {
  variants: Record<string, string | null>;
  items: { id: string; image_url: string | null }[];
  returns: { id: string; number: number; total: number; created_at: string; refund_method: string | null }[];
}

/** Detalle: variantes de los ítems, fotos y devoluciones de la venta. */
export function useSaleDetailExtras(saleId: string | null, variantIds: string[], enabled: boolean) {
  const vkey = [...variantIds].sort().join(",");
  return useQuery({
    queryKey: ["sales", "detail-extras", saleId, vkey],
    enabled: enabled && Boolean(saleId),
    staleTime: 30_000,
    queryFn: async (): Promise<DetailExtras> => {
      const [variants, items, returns] = await Promise.all([
        rowsIn<{ id: string; option1: string | null; option2: string | null }>(
          "product_variants",
          "id, option1, option2",
          "id",
          variantIds,
        ),
        rowsIn<{ id: string; products: { image_url: string | null } | null }>(
          "sale_items",
          "id, products(image_url)",
          "sale_id",
          [saleId!],
        ),
        rowsIn<{ id: string; number: number; total: number; created_at: string; refund_method: string | null }>(
          "sale_returns",
          "id, number, total, created_at, refund_method",
          "sale_id",
          [saleId!],
        ),
      ]);
      const vmap: Record<string, string | null> = {};
      for (const v of variants) vmap[v.id] = variantLabel(v);
      return {
        variants: vmap,
        items: items.map((i) => ({ id: i.id, image_url: i.products?.image_url ?? null })),
        returns: returns.map((r) => ({ ...r, total: Number(r.total) || 0 })),
      };
    },
  });
}
