"use client";

// Cockpit de comercio unificado (F16 · H76, ADR-091). Una sola RPC de
// lectura (commerce_cockpit); no está en los tipos generados: se castea.

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { CommerceCockpit } from "@/lib/commerce/cockpit";

export type CockpitPeriod = "hoy" | "7d" | "30d";

/** Desde cuándo mira el período (el servidor usa el día de Argentina para "hoy"). */
export function periodFrom(period: CockpitPeriod, now: Date = new Date()): string | null {
  if (period === "hoy") return null;
  const days = period === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function useCommerceCockpit(storeId: string | null, period: CockpitPeriod, enabled: boolean) {
  return useQuery({
    queryKey: ["commerce-cockpit", storeId, period],
    enabled,
    refetchInterval: 60_000,
    queryFn: async (): Promise<CommerceCockpit> => {
      const { data, error } = await createClient().rpc("commerce_cockpit" as never, {
        p_store_id: storeId,
        p_from: periodFrom(period),
        p_to: null,
      } as never);
      if (error) throw error;
      return data as unknown as CommerceCockpit;
    },
  });
}
