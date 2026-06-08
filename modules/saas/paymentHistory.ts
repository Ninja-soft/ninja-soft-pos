"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { PaymentRecord } from "@/components/saas/PaymentHistory";

// Historial COMPLETO de pagos del dueño (panel de suscripción). billing_records
// tiene RLS solo-staff, así que el dueño no puede leer la tabla directo: lo
// resuelve el RPC owner-gated my_payment_history() (owner|manager activo), que
// devuelve hasta 100 filas ordenadas por fecha desc. Si falla (no autorizado,
// sin sesión) devolvemos [] y el caller decide el fallback.

// Forma cruda de cada fila del jsonb que devuelve el RPC.
interface RawPaymentRow {
  id?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  medium?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  receipt_ref?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

function mapRow(r: RawPaymentRow): PaymentRecord {
  return {
    id: r.id ?? undefined,
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? null,
    medium: String(r.medium ?? ""),
    period_start: r.period_start ?? null,
    period_end: r.period_end ?? null,
    receipt_ref: r.receipt_ref ?? null,
    notes: r.notes ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

export function useMyPaymentHistory(enabled = true) {
  return useQuery({
    queryKey: ["my-payment-history"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PaymentRecord[]> => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: unknown }>;
      const { data, error } = await rpc("my_payment_history");
      if (error || !Array.isArray(data)) return [];
      return (data as RawPaymentRow[]).map(mapRow);
    },
  });
}
