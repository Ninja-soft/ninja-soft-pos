"use client";

// Lista de espera del salón (F13 · H51). Tabla dining_waitlist (migración
// 20261105200300_lista_espera): alta directa por RLS (miembro activo, estado
// 'esperando'); los cambios de estado y el "sentar" van por RPC.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { WaitlistStatus } from "@/lib/gastro/waitlist";

export interface WaitlistEntry {
  id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  priority: number;
  quoted_minutes: number | null;
  area_id: string | null;
  status: WaitlistStatus;
  notified_at: string | null;
  seated_at: string | null;
  table_order_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface WaitlistInput {
  customer_name: string;
  customer_phone?: string | null;
  party_size: number;
  priority?: number;
  quoted_minutes?: number | null;
  area_id?: string | null;
  notes?: string | null;
}

export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
  esperando: "Esperando",
  avisado: "Avisado",
  sentado: "Sentado",
  cancelado: "Cancelado",
  se_fue: "Se fue",
};

const COLS =
  "id, customer_id, customer_name, customer_phone, party_size, priority, quoted_minutes, area_id, status, notified_at, seated_at, table_order_id, notes, created_at";

// Aviso a la lista de espera (ADR-097): pendiente cuando se libera una mesa y
// entra el grupo; enviado cuando el mozo lo manda por WhatsApp.
export interface WaitlistNotice {
  id: string;
  entry_id: string;
  table_id: string | null;
  table_label: string | null;
  origin: "mesa_libre" | "manual";
  phone: string | null;
  message: string;
  status: "pendiente" | "enviado" | "descartado";
  created_at: string;
  dining_waitlist: { customer_name: string; party_size: number } | null;
}

export const waitlistApi = {
  // Activos + lo cerrado hoy (para ver quién se sentó / se fue en el turno).
  list: async (sinceISO: string): Promise<WaitlistEntry[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_waitlist" as never)
      .select(COLS)
      .is("deleted_at", null)
      .or(`status.in.(esperando,avisado),created_at.gte."${sinceISO}"`)
      .order("created_at");
    if (error) throw error;
    return (data ?? []) as unknown as WaitlistEntry[];
  },

  create: async (input: WaitlistInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("dining_waitlist" as never).insert({
      customer_name: input.customer_name.trim(),
      customer_phone: input.customer_phone?.trim() || null,
      party_size: input.party_size,
      priority: input.priority ?? 0,
      quoted_minutes: input.quoted_minutes ?? null,
      area_id: input.area_id ?? null,
      notes: input.notes?.trim() || null,
      status: "esperando",
    } as never);
    if (error) throw error;
  },

  setStatus: async (id: string, status: Exclude<WaitlistStatus, "sentado">): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("set_waitlist_status" as never, {
      p_entry_id: id,
      p_status: status,
    } as never);
    if (error) throw error;
  },

  // Avisos pendientes (mesa libre → primer grupo que entra), más nuevos primero.
  pendingNotices: async (): Promise<WaitlistNotice[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("dining_waitlist_notices" as never)
      .select(
        "id, entry_id, table_id, table_label, origin, phone, message, status, created_at, dining_waitlist(customer_name, party_size)",
      )
      .eq("status", "pendiente")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return (data ?? []) as unknown as WaitlistNotice[];
  },

  markNoticeSent: async (noticeId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("mark_waitlist_notice_sent" as never, {
      p_notice_id: noticeId,
    } as never);
    if (error) throw error;
  },

  dismissNotice: async (noticeId: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.rpc("dismiss_waitlist_notice" as never, {
      p_notice_id: noticeId,
    } as never);
    if (error) throw error;
  },

  // Aviso manual desde la fila: queda registrado (y marca el grupo avisado).
  notify: async (entryId: string, tableId: string | null): Promise<{ phone: string | null; message: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("notify_waitlist_entry" as never, {
      p_entry_id: entryId,
      p_table_id: tableId,
    } as never);
    if (error) throw error;
    return data as unknown as { phone: string | null; message: string };
  },

  seat: async (id: string, tableId: string): Promise<{ order_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("seat_waitlist_entry" as never, {
      p_entry_id: id,
      p_table_id: tableId,
    } as never);
    if (error) throw error;
    return data as unknown as { order_id: string };
  },
};

export function useWaitlist(sinceISO: string, enabled = true) {
  return useQuery({
    queryKey: ["dining", "waitlist", sinceISO],
    enabled,
    queryFn: () => waitlistApi.list(sinceISO),
    refetchInterval: 20_000,
  });
}

export function useWaitlistNotices(enabled = true) {
  return useQuery({
    queryKey: ["dining", "waitlist-notices"],
    enabled,
    queryFn: () => waitlistApi.pendingNotices(),
    refetchInterval: 15_000,
  });
}

export function useWaitlistMutations() {
  const qc = useQueryClient();
  const inv = () => {
    qc.invalidateQueries({ queryKey: ["dining", "waitlist"] });
    qc.invalidateQueries({ queryKey: ["dining", "waitlist-notices"] });
    qc.invalidateQueries({ queryKey: ["dining", "tables"] });
  };
  return {
    create: useMutation({ mutationFn: (i: WaitlistInput) => waitlistApi.create(i), onSuccess: inv }),
    setStatus: useMutation({
      mutationFn: (v: { id: string; status: Exclude<WaitlistStatus, "sentado"> }) =>
        waitlistApi.setStatus(v.id, v.status),
      onSuccess: inv,
    }),
    seat: useMutation({
      mutationFn: (v: { id: string; tableId: string }) => waitlistApi.seat(v.id, v.tableId),
      onSuccess: inv,
    }),
    markNoticeSent: useMutation({
      mutationFn: (noticeId: string) => waitlistApi.markNoticeSent(noticeId),
      onSuccess: inv,
    }),
    dismissNotice: useMutation({
      mutationFn: (noticeId: string) => waitlistApi.dismissNotice(noticeId),
      onSuccess: inv,
    }),
    notify: useMutation({
      mutationFn: (v: { entryId: string; tableId: string | null }) => waitlistApi.notify(v.entryId, v.tableId),
      onSuccess: inv,
    }),
  };
}
