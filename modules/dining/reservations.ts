"use client";

// Reservas gastronómicas (F13 · H51). Parte de la SUITE de mesas (H44): una
// reserva agenda una mesa/sector para una fecha/hora con cliente, comensales,
// duración y seña opcional. Cuando el cliente llega se SIENTA: la reserva se
// convierte en mesa ocupada (reusa open_dining_table) conservando cliente/seña.
//
// Va detrás de pos_settings.dining_enabled (toggle del dueño, NO feature de
// plan), igual que el resto de la suite gastro.
//
// Las acciones van por RPCs SECURITY DEFINER tenant-scoped (guard de miembro
// activo `_dining_assert_member`), idéntico a mesas/delivery. La lectura de la
// agenda va por la tabla directa con RLS (acotada por fecha; bajo consumo).
//
// types/database.ts NO se regenera: dining_reservations no está tipada. Tipamos
// explícito acá y casteamos nombre de tabla / RPC / payload (mismo enfoque que
// modules/dining/api.ts y modules/delivery/api.ts). La DB + RLS validan.

import { createClient } from "@/lib/supabase/client";

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type ReservationStatus =
  | "pendiente"
  | "confirmada"
  | "sentada"
  | "cancelada"
  | "no_show";

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  pendiente: "Pendiente",
  confirmada: "Confirmada",
  sentada: "Sentada",
  cancelada: "Cancelada",
  no_show: "No vino",
};

// Estilo del chip por estado (tonos del tema ninja). Pendiente = ámbar (a la
// espera); confirmada = ninja-flame (lista); sentada = sky (ya en mesa);
// cancelada/no_show = apagado.
export const RESERVATION_STATUS_CHIP: Record<ReservationStatus, string> = {
  pendiente: "border-amber-400/40 bg-amber-400/[0.10] text-amber-300",
  confirmada: "border-ninja-flame/40 bg-ninja-flame/[0.10] text-ninja-flameSoft",
  sentada: "border-sky-400/40 bg-sky-400/[0.10] text-sky-300",
  cancelada: "border-border bg-muted/40 text-muted-foreground",
  no_show: "border-border bg-muted/40 text-muted-foreground",
};

export interface Reservation {
  id: string;
  area_id: string | null;
  table_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
  status: ReservationStatus;
  deposit_amount: number;
  table_order_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface CreateReservationInput {
  customer_id?: string | null;
  customer_name: string;
  customer_phone?: string | null;
  party_size: number;
  reserved_at: string; // ISO
  duration_minutes?: number;
  area_id?: string | null;
  table_id?: string | null;
  deposit_amount?: number;
  notes?: string | null;
}

// ── API ────────────────────────────────────────────────────────────────────────

export const reservationsApi = {
  // Agenda acotada por rango [from, to) sobre reserved_at (bajo consumo: la vista
  // pide el día / próximas, no el histórico). Trae las NO terminales primero por
  // hora. cancelada/no_show quedan fuera salvo includeClosed.
  list: async (params: {
    from: string; // ISO inclusive
    to: string; // ISO exclusive
    includeClosed?: boolean;
  }): Promise<Reservation[]> => {
    const supabase = createClient();
    let query = supabase
      .from("dining_reservations" as never)
      .select(
        "id, area_id, table_id, customer_id, customer_name, customer_phone, party_size, reserved_at, duration_minutes, status, deposit_amount, table_order_id, notes, created_at",
      )
      .is("deleted_at", null)
      .gte("reserved_at", params.from)
      .lt("reserved_at", params.to);
    if (!params.includeClosed) {
      query = query.not("status", "in", "(cancelada,no_show)");
    }
    const { data, error } = await query.order("reserved_at").limit(200);
    if (error) throw error;
    return (data ?? []) as unknown as Reservation[];
  },

  create: async (input: CreateReservationInput): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_reservation" as never, {
      p_customer_id: input.customer_id ?? null,
      p_customer_name: input.customer_name,
      p_customer_phone: input.customer_phone ?? null,
      p_party_size: input.party_size,
      p_reserved_at: input.reserved_at,
      p_duration_minutes: input.duration_minutes ?? 90,
      p_area_id: input.area_id ?? null,
      p_table_id: input.table_id ?? null,
      p_deposit_amount: input.deposit_amount ?? 0,
      p_notes: input.notes ?? null,
    } as never);
    if (error) throw error;
    return data as unknown as string;
  },

  setStatus: async (id: string, status: ReservationStatus): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_reservation_status" as never, {
      p_id: id,
      p_status: status,
    } as never);
    if (error) throw error;
  },

  cancel: async (id: string, reason?: string | null): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("cancel_reservation" as never, {
      p_id: id,
      p_reason: reason ?? null,
    } as never);
    if (error) throw error;
  },

  // Sienta la reserva: abre la mesa (open_dining_table), enlaza table_order_id y
  // marca 'sentada'. Devuelve la mesa y el pedido para navegar a la cuenta/cobro.
  seat: async (
    id: string,
    tableId: string | null,
  ): Promise<{ table_id: string; table_order_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("seat_reservation" as never, {
      p_id: id,
      p_table_id: tableId ?? null,
    } as never);
    if (error) throw error;
    const r = data as { table_id: string; table_order_id: string };
    return { table_id: r.table_id, table_order_id: r.table_order_id };
  },
};
