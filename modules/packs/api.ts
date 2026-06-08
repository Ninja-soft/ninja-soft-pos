"use client";

// Paquetes / packs de sesiones (F12 · H41).
//
// - Definición del pack = tabla service_packs (nombre, servicio cubierto, nº de
//   sesiones, precio, vigencia). La gestiona el dueño en Configuración → Paquetes.
// - Saldo del cliente = tabla customer_pack_credits (sesiones otorgadas/usadas +
//   vencimiento). Se acredita al vender el pack (create_sale, extra kind='pack')
//   y se descuenta al consumir una sesión (extra kind='pack_session').
//
// types/database.ts NO se regenera en este PR: las tablas service_packs /
// customer_pack_credits y la RPC customer_pack_credits() aún no están tipadas.
// Tipamos explícito acá y casteamos el nombre de tabla / payload (mismo enfoque
// que modules/agenda/api.ts y modules/sales/api.ts). La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ServicePack {
  id: string;
  name: string;
  // Servicio/producto que el pack cubre. null = pack genérico (cualquier línea).
  product_id: string | null;
  sessions: number;
  price: number;
  // Vigencia en días desde la compra. null = sin vencimiento.
  validity_days: number | null;
  is_active: boolean;
  sort: number;
  notes: string | null;
}

export interface ServicePackInput {
  name: string;
  product_id: string | null;
  sessions: number;
  price: number;
  validity_days: number | null;
  is_active: boolean;
  notes: string | null;
}

// Saldo de pack de un cliente (lo devuelve la RPC customer_pack_credits).
export interface CustomerPackCredit {
  id: string;
  pack_id: string | null;
  pack_name: string;
  product_id: string | null;
  sessions_total: number;
  sessions_used: number;
  sessions_left: number;
  expires_at: string | null; // ISO
  expired: boolean;
  sale_id: string | null;
  created_at: string;
}

// ── Definición de packs ───────────────────────────────────────────────────────

export const servicePacksApi = {
  list: async (activeOnly = false): Promise<ServicePack[]> => {
    const supabase = createClient();
    let q = supabase
      .from("service_packs" as never)
      .select("id, name, product_id, sessions, price, validity_days, is_active, sort, notes")
      .is("deleted_at", null)
      .order("sort")
      .order("name");
    if (activeOnly) q = (q as unknown as { eq: (c: string, v: unknown) => typeof q }).eq("is_active", true);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as unknown as ServicePack[];
  },

  create: async (input: ServicePackInput): Promise<ServicePack> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("service_packs" as never)
      .insert({
        name: input.name,
        product_id: input.product_id,
        sessions: input.sessions,
        price: input.price,
        validity_days: input.validity_days,
        is_active: input.is_active,
        notes: input.notes,
      } as never)
      .select("id, name, product_id, sessions, price, validity_days, is_active, sort, notes")
      .single();
    if (error) throw error;
    return data as unknown as ServicePack;
  },

  update: async (id: string, input: Partial<ServicePackInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("service_packs" as never)
      .update(input as never)
      .eq("id", id);
    if (error) throw error;
  },

  // Baja lógica (deleted_at). Los saldos ya acreditados sobreviven (snapshot).
  softDelete: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("service_packs" as never)
      .update({ deleted_at: new Date().toISOString(), is_active: false } as never)
      .eq("id", id);
    if (error) throw error;
  },
};

// ── Saldo de sesiones del cliente ──────────────────────────────────────────────

export const customerPackCreditsApi = {
  // Saldos de packs de un cliente. onlyAvailable=true → sólo con saldo y no
  // vencidos (para ofrecer "usar sesión" en el POS). false → todos (historial).
  list: async (
    customerId: string,
    onlyAvailable = false,
  ): Promise<CustomerPackCredit[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("customer_pack_credits" as never, {
      p_customer_id: customerId,
      p_only_available: onlyAvailable,
    } as never);
    if (error) throw error;
    return (data ?? []) as unknown as CustomerPackCredit[];
  },
};
