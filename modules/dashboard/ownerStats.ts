"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

// Datos operativos del Panel del dueño (F17 · H118, owner_dashboard_stats):
// ventas de hoy y ayer por sucursal y por hora, cajas abiertas y personal.

export interface OwnerStats {
  today: string;
  by_store: {
    store_id: string;
    name: string;
    short_name: string | null;
    color: string | null;
    today_total: number;
    today_count: number;
    yesterday_total: number;
    yesterday_count: number;
  }[];
  by_hour: { hour: number; today: number; yesterday: number }[];
  open_shifts: number;
  staff: { active: number; suspended: number; on_leave: number; terminated: number };
}

type LooseRpc = {
  rpc: <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }>;
};

export async function fetchOwnerStats(storeId: string | null): Promise<OwnerStats> {
  const sb = createClient() as unknown as LooseRpc;
  const { data, error } = await sb.rpc<OwnerStats>("owner_dashboard_stats", { p_store_id: storeId });
  if (error || !data) throw new Error(error?.message ?? "owner_stats");
  return {
    ...data,
    by_store: data.by_store.map((s) => ({
      ...s,
      today_total: Number(s.today_total),
      today_count: Number(s.today_count),
      yesterday_total: Number(s.yesterday_total),
      yesterday_count: Number(s.yesterday_count),
    })),
    by_hour: data.by_hour.map((h) => ({ hour: Number(h.hour), today: Number(h.today), yesterday: Number(h.yesterday) })),
    open_shifts: Number(data.open_shifts),
  };
}

export function useOwnerStats(storeId: string | null) {
  return useQuery({
    queryKey: ["owner-stats", storeId],
    queryFn: () => fetchOwnerStats(storeId),
    refetchInterval: 60_000,
    retry: false,
  });
}

/** Totales y variación contra ayer (null si ayer fue 0). */
export function summarizeOwnerStats(s: OwnerStats | undefined) {
  const today = (s?.by_store ?? []).reduce((a, x) => a + x.today_total, 0);
  const yesterday = (s?.by_store ?? []).reduce((a, x) => a + x.yesterday_total, 0);
  const tickets = (s?.by_store ?? []).reduce((a, x) => a + x.today_count, 0);
  const ticketsY = (s?.by_store ?? []).reduce((a, x) => a + x.yesterday_count, 0);
  return {
    today,
    yesterday,
    delta: yesterday > 0 ? ((today - yesterday) / yesterday) * 100 : null,
    tickets,
    avgTicket: tickets > 0 ? today / tickets : 0,
    avgTicketY: ticketsY > 0 ? yesterday / ticketsY : 0,
  };
}

/** Rango de horas a graficar: desde la primera con ventas (o 8) hasta la última (o 21). */
export function hourWindow(rows: OwnerStats["by_hour"]): OwnerStats["by_hour"] {
  const withSales = rows.filter((r) => r.today > 0 || r.yesterday > 0).map((r) => r.hour);
  const from = Math.min(8, ...withSales);
  const to = Math.max(21, ...withSales);
  return rows.filter((r) => r.hour >= from && r.hour <= to);
}
