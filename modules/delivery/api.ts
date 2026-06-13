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

// Zona de envío del tenant (F13 · H49 follow-up). El dueño define zonas con su
// tarifa; al tomar un pedido de delivery se elige la zona → autocompleta el fee.
export interface DeliveryZone {
  id: string;
  name: string;
  fee: number;
  eta_minutes: number | null;
  is_active: boolean;
  sort_order: number;
}

export interface DeliveryZoneInput {
  name: string;
  fee: number;
  eta_minutes?: number | null;
  is_active?: boolean;
  sort_order?: number;
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
  // Zona de envío elegida (snapshot del fee queda en delivery_fee). null = sin zona.
  zone_id: string | null;
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
  // Alergia/intolerancia del ítem (F13 · H47): destacada en KDS y comanda.
  allergens: string | null;
  course: number;
  fired_at: string | null;
}

// ── Comanda impresa por estación (F13 · H49, espeja H45) ───────────────────────
// Una línea disparada del pedido + el contexto de cabecera del delivery/takeaway
// que devuelve delivery_comanda_items para armar la(s) comanda(s) de cocina. NO
// lleva precios (es un ticket de preparación). HERMANO de ComandaItem (mesa),
// pero el encabezado es el del pedido SIN mesa: `source_label` = "DELIVERY #1234"
// / "TAKEAWAY #1234" + canal / cliente / dirección / cadete (el teléfono y el
// horario prometido no viajan en la RPC; la UI los toma del DeliveryOrder).
export interface DeliveryComandaItem {
  item_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  // Alergia/intolerancia destacada en la comanda impresa (F13 · H47).
  allergens: string | null;
  station: string | null;
  course: number;
  printed_at: string | null;
  source_label: string;
  channel: DeliveryChannel;
  order_type: DeliveryOrderType;
  courier_name: string | null;
  customer_name: string | null;
  address: string | null;
  opened_at: string;
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
  // Zona de envío elegida (sólo delivery). El backend la guarda y, si no viene
  // fee explícito, copia su tarifa. La UI igual autocompleta el fee al elegirla.
  zone_id?: string | null;
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
  // Alergia/intolerancia del ítem (F13 · H47): se resalta en KDS y comanda.
  allergens?: string | null;
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
        "id, channel, order_type, customer_id, customer_name, customer_phone, address, address_reference, promised_at, courier_name, delivery_fee, zone_id, status, sale_id, notes, created_at",
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
        "id, channel, order_type, customer_id, customer_name, customer_phone, address, address_reference, promised_at, courier_name, delivery_fee, zone_id, status, sale_id, notes, created_at",
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
        "id, order_id, product_id, name, qty, unit_price, modifiers, notes, allergens, course, fired_at",
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
      p_zone_id: input.zone_id ?? null,
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
      p_allergens: input.allergens ?? null,
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

  // Líneas disparadas del pedido + contexto para la comanda impresa (H49, espeja
  // comanda_items de mesa). onlyNew=true trae sólo las no enviadas a cocina;
  // false trae todas (reimprimir). RPC tenant-scoped (delivery_comanda_items).
  comandaItems: async (
    orderId: string,
    onlyNew: boolean,
  ): Promise<DeliveryComandaItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("delivery_comanda_items" as never, {
      p_order_id: orderId,
      p_only_new: onlyNew,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as DeliveryComandaItem[];
  },

  // Sella printed_at de las líneas impresas (las que aún eran null). Reimprimir no
  // repisa la marca original (idempotente). RPC tenant-scoped.
  markComandaPrinted: async (orderId: string, itemIds: string[]): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc(
      "mark_delivery_comanda_printed" as never,
      { p_order_id: orderId, p_item_ids: itemIds } as never,
    );
    if (error) throw error;
    return ((data as { marked?: number } | null)?.marked ?? 0) as number;
  },
};

// ── Zonas de envío (F13 · H49 follow-up) ───────────────────────────────────────
// CRUD por tabla directa con RLS: lectura por miembros del tenant, ESCRITURA sólo
// owner/manager (la DB lo enforcea; espeja tenant_branding). Baja lógica
// (deleted_at). Lo usa el manager de zonas (Configuración → Zonas de envío) y el
// selector de zona en el alta de pedido. Tabla no tipada → cast (como dining).
export const deliveryZonesApi = {
  // Lista las zonas del tenant. includeInactive=false (default) sólo activas
  // (para el selector del alta); true trae todas (para la gestión).
  list: async (includeInactive = false): Promise<DeliveryZone[]> => {
    const supabase = createClient();
    let query = supabase
      .from("delivery_zones" as never)
      .select("id, name, fee, eta_minutes, is_active, sort_order")
      .is("deleted_at", null);
    if (!includeInactive) query = query.eq("is_active", true);
    const { data, error } = await query.order("sort_order").order("name");
    if (error) throw error;
    return (data ?? []) as unknown as DeliveryZone[];
  },

  create: async (input: DeliveryZoneInput): Promise<DeliveryZone> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("delivery_zones" as never)
      .insert({
        name: input.name,
        fee: input.fee,
        eta_minutes: input.eta_minutes ?? null,
        is_active: input.is_active ?? true,
        sort_order: input.sort_order ?? 0,
      } as never)
      .select("id, name, fee, eta_minutes, is_active, sort_order")
      .single();
    if (error) throw error;
    return data as unknown as DeliveryZone;
  },

  update: async (id: string, input: Partial<DeliveryZoneInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("delivery_zones" as never)
      .update(input as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica: los pedidos viejos conservan su zone_id (FK set null en físico,
  // pero acá no borramos físico). Su delivery_fee ya está snapshotteado.
  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("delivery_zones" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },
};
