"use client";

// Delivery y take away (F13 · H49). HERMANO de modules/dining para pedidos SIN
// mesa: canal, cliente/teléfono, dirección/referencia, horario prometido, cadete
// y costo de envío. Las acciones van por RPCs tenant-scoped (SECURITY DEFINER +
// guard de miembro activo `_dining_assert_member`), idéntico a las de mesa.
//
// types/database.ts NO se regenera: las tablas delivery_* no están tipadas.
// Tipamos explícito acá y casteamos el nombre de la RPC / payload (mismo enfoque
// que modules/dining/api.ts). La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";
import type { SaleLineModifierGroup } from "@/modules/products/modifiers";

// ── Tipos ─────────────────────────────────────────────────────────────────────

// Canal de entrada del pedido (lista fija; marketplace = follow-up).
export const DELIVERY_CHANNELS = [
  "mostrador",
  "telefono",
  "whatsapp",
  "qr",
  "delivery_propio",
] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_CHANNEL_LABELS: Record<DeliveryChannel, string> = {
  mostrador: "Mostrador",
  telefono: "Teléfono",
  whatsapp: "WhatsApp",
  qr: "QR",
  delivery_propio: "Delivery propio",
};

export type DeliveryOrderType = "delivery" | "takeaway";

export const DELIVERY_TYPE_LABELS: Record<DeliveryOrderType, string> = {
  delivery: "Delivery",
  takeaway: "Take away",
};

// Estados posibles (el schema admite el unión de ambos tipos). Para delivery:
// recibido → preparando → en_camino → entregado (+ cancelado). Para takeaway:
// recibido → preparando → listo → entregado (+ cancelado).
export type DeliveryStatus =
  | "recibido"
  | "preparando"
  | "en_camino"
  | "listo"
  | "entregado"
  | "cancelado";

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  recibido: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  listo: "Listo",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

// Columnas de tablero (kanban) por tipo. El board agrupa por estos estados.
export const DELIVERY_BOARD_COLUMNS: DeliveryStatus[] = [
  "recibido",
  "preparando",
  "en_camino",
  "entregado",
];
export const TAKEAWAY_BOARD_COLUMNS: DeliveryStatus[] = [
  "recibido",
  "preparando",
  "listo",
  "entregado",
];

// Próximo estado "natural" según tipo (botón "avanzar" en la tarjeta). No incluye
// 'entregado' como avance manual (la entrega se confirma al cobrar).
export function nextDeliveryStatus(
  type: DeliveryOrderType,
  status: DeliveryStatus,
): DeliveryStatus | null {
  if (type === "takeaway") {
    if (status === "recibido") return "preparando";
    if (status === "preparando") return "listo";
    return null;
  }
  if (status === "recibido") return "preparando";
  if (status === "preparando") return "en_camino";
  return null;
}

export interface DeliveryOrder {
  id: string;
  channel: DeliveryChannel;
  order_type: DeliveryOrderType;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  address: string | null;
  address_reference: string | null;
  promised_at: string | null;
  courier_name: string | null;
  delivery_fee: number;
  status: DeliveryStatus;
  sale_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface DeliveryOrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  unit_price: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  course: number;
  fired_at: string | null;
}

// Input para crear un pedido (alta desde el board).
export interface CreateDeliveryInput {
  channel: DeliveryChannel;
  order_type: DeliveryOrderType;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  address?: string | null;
  address_reference?: string | null;
  promised_at?: string | null;
  courier_name?: string | null;
  delivery_fee?: number;
  notes?: string | null;
}

// Ítem a agregar al pedido (desde el picker).
export interface AddDeliveryItemInput {
  order_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  unit_price: number;
  modifiers?: SaleLineModifierGroup[];
  notes?: string | null;
  course?: number;
  hold?: boolean;
}

// ── API ─────────────────────────────────────────────────────────────────────

export const deliveryApi = {
  // Pedidos activos del tenant (no entregados/cancelados → el board los muestra).
  // Trae también los recién entregados de hoy para la columna "Entregado".
  list: async (): Promise<DeliveryOrder[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_orders" as never)
      .select(
        "id, channel, order_type, customer_id, customer_name, customer_phone, address, address_reference, promised_at, courier_name, delivery_fee, status, sale_id, notes, created_at",
      )
      .is("deleted_at", null)
      .neq("status", "cancelado")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as DeliveryOrder[];
  },

  getById: async (orderId: string): Promise<DeliveryOrder | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_orders" as never)
      .select(
        "id, channel, order_type, customer_id, customer_name, customer_phone, address, address_reference, promised_at, courier_name, delivery_fee, status, sale_id, notes, created_at",
      )
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as unknown as DeliveryOrder | null;
  },

  itemsByOrder: async (orderId: string): Promise<DeliveryOrderItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_order_items" as never)
      .select(
        "id, order_id, product_id, name, qty, unit_price, modifiers, notes, course, fired_at",
      )
      .eq("order_id", orderId)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as DeliveryOrderItem[];
  },

  // Totales acumulados (ítems) por pedido NO cobrado, para mostrar en las
  // tarjetas del board sin traer todas las líneas. Mapa order_id → total ítems
  // (NO incluye el delivery_fee; el board lo suma aparte por pedido).
  openItemTotals: async (): Promise<Record<string, number>> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_order_items" as never)
      .select("order_id, qty, unit_price, delivery_orders!inner(status, sale_id, deleted_at)")
      .is("delivery_orders.sale_id", null)
      .is("delivery_orders.deleted_at", null);
    if (error) throw error;
    const rows = (data ?? []) as unknown as {
      order_id: string;
      qty: number;
      unit_price: number;
    }[];
    const totals: Record<string, number> = {};
    for (const r of rows) {
      totals[r.order_id] =
        (totals[r.order_id] ?? 0) + Number(r.qty) * Number(r.unit_price);
    }
    return totals;
  },

  create: async (input: CreateDeliveryInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_delivery_order" as never, {
      p_channel: input.channel,
      p_order_type: input.order_type,
      p_customer_id: input.customer_id ?? null,
      p_customer_name: input.customer_name ?? null,
      p_customer_phone: input.customer_phone ?? null,
      p_address: input.address ?? null,
      p_address_ref: input.address_reference ?? null,
      p_promised_at: input.promised_at ?? null,
      p_courier_name: input.courier_name ?? null,
      p_delivery_fee: input.delivery_fee ?? 0,
      p_notes: input.notes ?? null,
    } as never);
    if (error) throw error;
    return (data as { order_id: string }).order_id;
  },

  addItem: async (input: AddDeliveryItemInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("add_delivery_order_item" as never, {
      p_order_id: input.order_id,
      p_product_id: input.product_id,
      p_name: input.name,
      p_qty: input.qty,
      p_unit_price: input.unit_price,
      p_modifiers: (input.modifiers ?? []) as unknown,
      p_notes: input.notes ?? null,
      p_course: input.course ?? 1,
      p_hold: input.hold ?? false,
    } as never);
    if (error) throw error;
    return data as unknown as string;
  },

  setItemQty: async (itemId: string, qty: number): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_delivery_order_item_qty" as never, {
      p_item_id: itemId,
      p_qty: qty,
    } as never);
    if (error) throw error;
  },

  removeItem: async (itemId: string): Promise<void> => {
    return deliveryApi.setItemQty(itemId, 0);
  },

  setStatus: async (orderId: string, status: DeliveryStatus): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_delivery_status" as never, {
      p_id: orderId,
      p_status: status,
    } as never);
    if (error) throw error;
  },

  assignCourier: async (orderId: string, courierName: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("assign_courier" as never, {
      p_id: orderId,
      p_courier_name: courierName,
    } as never);
    if (error) throw error;
  },

  cancel: async (orderId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("cancel_delivery_order" as never, {
      p_order_id: orderId,
    } as never);
    if (error) throw error;
  },
};
