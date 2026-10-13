"use client";

// Reservas de stock y retiro en tienda (F16 · H77, ADR-091). Lectura por
// tabla con RLS; toda escritura por RPC SECURITY DEFINER (el servidor valida
// plan, rol, sucursal, disponible e identidad). Las tablas y RPC nuevas no
// están en los tipos generados: se castean.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { ReservationChannel, StockReservation } from "@/lib/stock/reservations";

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

const SELECT =
  "id, number, store_id, origin_store_id, channel, customer_id, customer_name, customer_phone, customer_doc, " +
  "failed_attempts, status, expires_at, notes, total_units, total_value, sale_id, cancel_reason, created_at, " +
  "prepared_at, delivered_at, items:stock_reservation_items(id, product_id, variant_id, product_name, " +
  "variant_label, sku, unit, qty, unit_price, sort)";

export const reservationsApi = {
  list: async (storeId: string | null, open: boolean): Promise<StockReservation[]> => {
    let q = createClient()
      .from("stock_reservations" as never)
      .select(SELECT)
      .order("created_at", { ascending: false })
      .limit(open ? 200 : 100);
    if (storeId) q = q.eq("store_id", storeId);
    q = open ? q.in("status", ["reservada", "preparada"]) : q.in("status", ["entregada", "cancelada", "vencida"]);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as unknown as StockReservation[]).map((r) => ({
      ...r,
      items: [...(r.items ?? [])].sort((a, b) => a.sort - b.sort),
    }));
  },

  availability: async (
    storeId: string,
    productIds: string[],
  ): Promise<{ product_id: string; variant_id: string | null; on_hand: number; reserved: number; available: number }[]> =>
    rpc("stock_reservation_availability", { p_store_id: storeId, p_product_ids: productIds }),
};

export interface CreateReservationInput {
  storeId: string;
  originStoreId: string | null;
  items: { product_id: string; variant_id: string | null; qty: number }[];
  customerName: string;
  customerId: string | null;
  customerPhone: string;
  customerDoc: string;
  channel: ReservationChannel;
  hours: number;
  notes: string;
}

export interface DeliverResult {
  ok: boolean;
  error?: string;
  attempts_left?: number;
  sale_id?: string;
}

export function useStockReservations(storeId: string | null, open: boolean, enabled = true) {
  return useQuery({
    queryKey: ["stock-reservations", storeId, open],
    enabled,
    queryFn: () => reservationsApi.list(storeId, open),
    staleTime: 15_000,
  });
}

export function useReservationAvailability(storeId: string | null, productIds: string[]) {
  const key = [...productIds].sort().join(",");
  return useQuery({
    queryKey: ["stock-reservation-availability", storeId, key],
    enabled: Boolean(storeId) && productIds.length > 0,
    queryFn: () => reservationsApi.availability(storeId!, productIds),
  });
}

export function useReservationMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["stock-reservations"] });
    qc.invalidateQueries({ queryKey: ["stock-reservation-availability"] });
    qc.invalidateQueries({ queryKey: ["commerce-cockpit"] });
  };

  const create = useMutation({
    mutationFn: (i: CreateReservationInput) =>
      rpc<{ id: string; number: number; pickup_code: string; expires_at: string }>("stock_reservation_create", {
        p_store_id: i.storeId,
        p_items: i.items,
        p_customer_name: i.customerName.trim(),
        p_customer_id: i.customerId,
        p_customer_phone: i.customerPhone.trim() || null,
        p_customer_doc: i.customerDoc.trim() || null,
        p_channel: i.channel,
        p_expires_at: new Date(Date.now() + i.hours * 3_600_000).toISOString(),
        p_notes: i.notes.trim() || null,
        p_origin_store_id: i.originStoreId,
      }),
    onSuccess: invalidate,
  });

  const prepare = useMutation({
    mutationFn: (id: string) => rpc<void>("stock_reservation_prepare", { p_id: id }),
    onSuccess: invalidate,
  });

  const deliver = useMutation({
    mutationFn: (i: { id: string; saleNumber: number; code: string; doc: string; overrideReason: string }) =>
      rpc<DeliverResult>("stock_reservation_deliver", {
        p_id: i.id,
        p_sale_number: i.saleNumber,
        p_code: i.code.trim() || null,
        p_customer_doc: i.doc.trim() || null,
        p_override_reason: i.overrideReason.trim() || null,
      }),
    onSettled: invalidate,
  });

  const cancel = useMutation({
    mutationFn: (i: { id: string; reason: string }) =>
      rpc<void>("stock_reservation_cancel", { p_id: i.id, p_reason: i.reason }),
    onSuccess: invalidate,
  });

  return { create, prepare, deliver, cancel };
}
