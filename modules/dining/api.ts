"use client";

// Mesas, salones y pedidos de mesa (F13 · H44) + modo gastronómico (H43).
//
// - Salones = dining_areas (sector visual).
// - Mesas   = dining_tables (etiqueta, capacidad, estado, mozo, pedido vivo).
// - Pedido  = table_orders (cuenta) + table_order_items (líneas).
//
// Las acciones de mesa (abrir, agregar/quitar ítem, cancelar, cobrar) van por
// RPCs tenant-scoped (SECURITY DEFINER + guard de miembro activo). El CRUD de
// salones/mesas va por la tabla directa con RLS (lo usa el dueño en Config).
//
// types/database.ts NO se regenera en este PR: las tablas dining_* no están
// tipadas. Tipamos explícito acá y casteamos nombre de tabla / payload (mismo
// enfoque que modules/agenda/api.ts). La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";
import type { SaleLineModifierGroup } from "@/modules/products/modifiers";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type TableStatus =
  | "libre"
  | "ocupada"
  | "cuenta_pedida"
  | "bloqueada"
  // 'reservada' (F13 · H51): una reserva con mesa asignada la bloquea hasta que
  // el cliente llegue y se siente (→ ocupada) o se cancele / no_show (→ libre).
  | "reservada";

export interface DiningArea {
  id: string;
  name: string;
  sort: number;
}

export interface DiningTable {
  id: string;
  area_id: string | null;
  label: string;
  capacity: number;
  sort: number;
  status: TableStatus;
  current_order_id: string | null;
  waiter_user_id: string | null;
}

export interface TableOrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  unit_price: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  // Cursos / despacho por tiempos (F13 · H47): `course` = tiempo al que pertenece
  // el ítem (1=entrada, 2=principal, 3=postre…). `fired_at` = cuándo se disparó a
  // cocina; null = "en espera" (no fue al KDS/comanda todavía).
  course: number;
  fired_at: string | null;
}

// ── Estaciones de preparación (F13 · H45 ruteo + H46 KDS) ──────────────────────
// A qué estación va un producto. Lista fija razonable; null = "sin estación" (no
// va a ninguna pantalla de preparación). Se elige en la ficha del producto y se
// snapshotea en table_order_items.station al cargar el ítem (ruteo fijo).
export const KDS_STATIONS = [
  "cocina",
  "barra",
  "cafeteria",
  "parrilla",
  "postres",
  "despacho",
] as const;
export type KdsStation = (typeof KDS_STATIONS)[number];

export const KDS_STATION_LABELS: Record<KdsStation, string> = {
  cocina: "Cocina",
  barra: "Barra",
  cafeteria: "Cafetería",
  parrilla: "Parrilla",
  postres: "Postres",
  despacho: "Despacho",
};

// Estado de preparación de una línea en el KDS.
export type KdsStatus = "pendiente" | "preparando" | "listo" | "entregado";

export const KDS_STATUS_LABELS: Record<KdsStatus, string> = {
  pendiente: "Pendiente",
  preparando: "Preparando",
  listo: "Listo",
  entregado: "Entregado",
};

// Una línea activa en el KDS (lo que devuelve kds_tickets): la línea + mesa/salón
// + hora de carga para la tarjeta y el timer.
export interface KdsTicketItem {
  item_id: string;
  order_id: string;
  table_id: string;
  table_label: string;
  area_name: string | null;
  product_id: string | null;
  name: string;
  qty: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  station: string | null;
  kds_status: KdsStatus;
  // Tiempo (course) del ítem para que la cocina vea la secuencia (F13 · H47).
  course: number;
  created_at: string;
  ready_at: string | null;
  // Origen del ítem (F13 · H49): 'mesa' o 'delivery'. `source_label` es la
  // etiqueta de cabecera de la tarjeta/columna del KDS: "Mesa 5" para mesa,
  // "DELIVERY #1234" / "TAKEAWAY #1234" para delivery/takeaway. Para mesa,
  // table_id/area_name vienen poblados; para delivery van null.
  source: "mesa" | "delivery";
  source_label: string;
}

export interface TableOrder {
  id: string;
  table_id: string;
  status: "abierta" | "cobrada" | "cancelada";
  opened_by: string | null;
  opened_at: string;
  sale_id: string | null;
  notes: string | null;
}

// ── Comanda impresa por estación (F13 · H45) ───────────────────────────────────
// Una línea del pedido + el contexto de cabecera (mesa / salón / mozo / hora de
// apertura) que devuelve comanda_items para armar la(s) comanda(s) de cocina. La
// comanda NO lleva precios: es un ticket de preparación, no un comprobante.
export interface ComandaItem {
  item_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  modifiers: SaleLineModifierGroup[];
  notes: string | null;
  station: string | null;
  // Tiempo (course) del ítem para etiquetar/agrupar la comanda por tiempo.
  course: number;
  printed_at: string | null;
  table_label: string;
  area_name: string | null;
  waiter_name: string | null;
  opened_at: string;
}

export interface AreaInput {
  name: string;
  sort?: number;
}
export interface TableInput {
  area_id: string | null;
  label: string;
  capacity: number;
  sort?: number;
}

// Ítem a agregar al pedido de la mesa (desde el picker del POS/Salón).
export interface AddItemInput {
  order_id: string;
  product_id: string | null;
  name: string;
  qty: number;
  unit_price: number;
  modifiers?: SaleLineModifierGroup[];
  notes?: string | null;
  // Cursos / despacho por tiempos (F13 · H47). course default 1; hold=true deja
  // el ítem "en espera" (no va a cocina hasta dispararlo). Omitidos = flujo
  // rápido actual (Tiempo 1, se manda a cocina al toque).
  course?: number;
  hold?: boolean;
}

// Tiempos (cursos) que ofrece la UI. Lista corta y razonable (entrada → café);
// el schema admite cualquier smallint, pero el selector usa 1..MAX_COURSE.
export const MAX_COURSE = 6;
export const COURSE_LABELS: Record<number, string> = {
  1: "Entrada",
  2: "Principal",
  3: "Postre",
  4: "Bebida",
  5: "Café",
  6: "Extra",
};

// Etiqueta "Tiempo N · Nombre" para encabezados; sólo "Tiempo N" si no hay nombre.
export function courseLabel(course: number): string {
  const name = COURSE_LABELS[course];
  return name ? `Tiempo ${course} · ${name}` : `Tiempo ${course}`;
}

// Etiqueta corta para chips/tarjetas ("T1", "T2"…) en KDS/comanda.
export function courseShort(course: number): string {
  return `T${course}`;
}

// ── Salones ───────────────────────────────────────────────────────────────────

export const areasApi = {
  list: async (): Promise<DiningArea[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_areas" as never)
      .select("id, name, sort")
      .is("deleted_at", null)
      .order("sort")
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as DiningArea[];
  },

  create: async (input: AreaInput): Promise<DiningArea> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_areas" as never)
      .insert({ name: input.name, sort: input.sort ?? 0 } as never)
      .select("id, name, sort")
      .single();
    if (error) throw error;
    return data as unknown as DiningArea;
  },

  update: async (id: string, input: Partial<AreaInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("dining_areas" as never)
      .update(input as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica: las mesas del salón conservan su area_id (FK set null en físico).
  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("dining_areas" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },
};

// ── Mesas ─────────────────────────────────────────────────────────────────────

export const tablesApi = {
  list: async (): Promise<DiningTable[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_tables" as never)
      .select("id, area_id, label, capacity, sort, status, current_order_id, waiter_user_id")
      .is("deleted_at", null)
      .order("sort")
      .order("label");
    if (error) throw error;
    return (data ?? []) as unknown as DiningTable[];
  },

  create: async (input: TableInput): Promise<DiningTable> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_tables" as never)
      .insert({
        area_id: input.area_id,
        label: input.label,
        capacity: input.capacity,
        sort: input.sort ?? 0,
      } as never)
      .select("id, area_id, label, capacity, sort, status, current_order_id, waiter_user_id")
      .single();
    if (error) throw error;
    return data as unknown as DiningTable;
  },

  update: async (id: string, input: Partial<TableInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("dining_tables" as never)
      .update(input as never)
      .eq("id", id);
    if (error) throw error;
  },

  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("dining_tables" as never)
      .update({ deleted_at: new Date().toISOString() } as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Cambio simple de estado de la mesa (cuenta pedida / bloquear / liberar). RPC
  // tenant-scoped: valida transiciones (no liberar con pedido abierto, etc.).
  setStatus: async (tableId: string, status: TableStatus): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_table_status" as never, {
      p_table_id: tableId,
      p_status: status,
    } as never);
    if (error) throw error;
  },
};

// ── Pedidos de mesa ────────────────────────────────────────────────────────────

export const tableOrdersApi = {
  // Ítems del pedido abierto de una mesa (para la cuenta del Salón / cobro POS).
  itemsByOrder: async (orderId: string): Promise<TableOrderItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("table_order_items" as never)
      .select(
        "id, order_id, product_id, name, qty, unit_price, modifiers, notes, course, fired_at",
      )
      .eq("order_id", orderId)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as TableOrderItem[];
  },

  // Un pedido por id (para el cobro desde el POS: /pos?table=<order_id>).
  getById: async (orderId: string): Promise<TableOrder | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("table_orders" as never)
      .select("id, table_id, status, opened_by, opened_at, sale_id, notes")
      .eq("id", orderId)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as unknown as TableOrder | null;
  },

  // Líneas del pedido + contexto (mesa / salón / mozo / hora) para la comanda
  // impresa (H45). onlyNew=true trae sólo las no enviadas a cocina (las nuevas);
  // false trae todas (reimprimir). RPC tenant-scoped (comanda_items).
  comandaItems: async (
    orderId: string,
    onlyNew: boolean,
  ): Promise<ComandaItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("comanda_items" as never, {
      p_order_id: orderId,
      p_only_new: onlyNew,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as ComandaItem[];
  },

  // Sella printed_at de las líneas impresas (las que aún eran null). Reimprimir
  // no repisa la marca original. RPC tenant-scoped (mark_comanda_printed).
  markPrinted: async (orderId: string, itemIds: string[]): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("mark_comanda_printed" as never, {
      p_order_id: orderId,
      p_item_ids: itemIds,
    } as never);
    if (error) throw error;
    return ((data as { marked?: number } | null)?.marked ?? 0) as number;
  },

  // Totales acumulados por pedido abierto del tenant (para mostrar en el grid de
  // Salón sin traer todas las líneas). Devuelve un mapa order_id → total.
  openTotals: async (): Promise<Record<string, number>> => {
    const supabase = createClient();
    // Trae las líneas de los pedidos abiertos (RLS por tenant) y agrega en cliente.
    const { data, error } = await supabase
      .from("table_order_items" as never)
      .select("order_id, qty, unit_price, table_orders!inner(status)")
      .eq("table_orders.status", "abierta");
    if (error) throw error;
    const rows = (data ?? []) as unknown as {
      order_id: string;
      qty: number;
      unit_price: number;
    }[];
    const totals: Record<string, number> = {};
    for (const r of rows) {
      totals[r.order_id] = (totals[r.order_id] ?? 0) + Number(r.qty) * Number(r.unit_price);
    }
    return totals;
  },

  // Abre la mesa (crea el pedido si no existe; mesa → ocupada). Devuelve order_id.
  open: async (tableId: string, waiterUserId?: string | null): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("open_dining_table" as never, {
      p_table_id: tableId,
      p_waiter_user_id: waiterUserId ?? null,
    } as never);
    if (error) throw error;
    return (data as { order_id: string }).order_id;
  },

  addItem: async (input: AddItemInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("add_table_order_item" as never, {
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

  // Cambia el tiempo (course) de una línea. Tenant-scoped; sólo con pedido abierto.
  setItemCourse: async (itemId: string, course: number): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_table_order_item_course" as never, {
      p_item_id: itemId,
      p_course: course,
    } as never);
    if (error) throw error;
  },

  // Dispara un tiempo a cocina (fire course): sella fired_at en los ítems en
  // espera del curso indicado (o de TODOS los pendientes si course=null). Devuelve
  // cuántos disparó. RPC tenant-scoped (fire_table_order_course).
  fireCourse: async (
    orderId: string,
    course: number | null,
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("fire_table_order_course" as never, {
      p_order_id: orderId,
      p_course: course,
    } as never);
    if (error) throw error;
    return ((data as { fired?: number } | null)?.fired ?? 0) as number;
  },

  // Cambia la cantidad de una línea. qty <= 0 borra la línea.
  setItemQty: async (itemId: string, qty: number): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_table_order_item_qty" as never, {
      p_item_id: itemId,
      p_qty: qty,
    } as never);
    if (error) throw error;
  },

  removeItem: async (itemId: string): Promise<void> => {
    return tableOrdersApi.setItemQty(itemId, 0);
  },

  cancel: async (orderId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("cancel_table_order" as never, {
      p_order_id: orderId,
    } as never);
    if (error) throw error;
  },

  // Enlaza la venta cobrada al pedido y libera la mesa (→ libre). Lo llama el POS
  // al confirmar el cobro de una mesa (espeja appointmentsApi.linkSale · H38).
  close: async (orderId: string, saleId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("close_dining_table" as never, {
      p_order_id: orderId,
      p_sale_id: saleId,
    } as never);
    if (error) throw error;
  },
};

// ── KDS / pantalla de cocina (F13 · H46) ───────────────────────────────────────
// Lee los ítems activos por estación (pedidos abiertos, no entregados) y avanza
// su estado. Va por RPCs SECURITY DEFINER tenant-scoped (kds_tickets /
// set_item_kds_status). Las columnas KDS no están en los tipos generados: cast.

export const kdsApi = {
  // Ítems activos de una estación (null/'' = todas), orden FIFO. La RPC ya filtra
  // por tenant (RLS + guard) y excluye 'entregado'.
  tickets: async (station: string | null): Promise<KdsTicketItem[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("kds_tickets" as never, {
      p_station: station ?? null,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as KdsTicketItem[];
  },

  // Avanza/retrocede el estado de preparación de una línea. 'listo' sella ready_at;
  // 'entregado' la saca del KDS.
  setStatus: async (itemId: string, status: KdsStatus): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_item_kds_status" as never, {
      p_item_id: itemId,
      p_status: status,
    } as never);
    if (error) throw error;
  },
};

// Próximo estado al avanzar la tarjeta (pendiente → preparando → listo →
// entregado). 'entregado' no avanza más (queda fuera de la vista).
export const KDS_NEXT_STATUS: Record<KdsStatus, KdsStatus | null> = {
  pendiente: "preparando",
  preparando: "listo",
  listo: "entregado",
  entregado: null,
};

// ── Helpers de estado (UI) ─────────────────────────────────────────────────────

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  libre: "Libre",
  ocupada: "Ocupada",
  cuenta_pedida: "Cuenta pedida",
  bloqueada: "Bloqueada",
  reservada: "Reservada",
};

// Estilo del tile de mesa por estado (tonos del tema ninja). Libre = ninja-flame
// (invita a abrir); ocupada = ámbar; cuenta pedida = sky; bloqueada = apagado.
export const TABLE_STATUS_TILE: Record<TableStatus, string> = {
  libre: "border-ninja-flame/40 bg-ninja-flame/[0.07] hover:border-ninja-flame",
  ocupada: "border-amber-400/40 bg-amber-400/[0.08] hover:border-amber-400",
  cuenta_pedida: "border-sky-400/40 bg-sky-400/[0.08] hover:border-sky-400",
  bloqueada: "border-border bg-muted/40 opacity-70",
  // Reservada (H51): violeta apagado, distinto de libre (no invita a abrir).
  reservada: "border-purple-400/40 bg-purple-400/[0.08] hover:border-purple-400",
};

export const TABLE_STATUS_DOT: Record<TableStatus, string> = {
  libre: "bg-ninja-flame",
  ocupada: "bg-amber-400",
  cuenta_pedida: "bg-sky-400",
  bloqueada: "bg-muted-foreground",
  reservada: "bg-purple-400",
};
