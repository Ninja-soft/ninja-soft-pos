"use client";

// Conciliación de tarjetas (ADR-043): lectura de los cobros con tarjeta y
// marcado de conciliados.
//
// - Lectura: SELECT sobre payments + sales con RLS (aislamiento por tenant).
//   Se excluyen las ventas anuladas (el cobro se revierte en el adquirente).
// - Escritura: SÓLO por la RPC set_payments_reconciled (SECURITY DEFINER:
//   rol owner/manager, plan con conciliacion_tarjetas, pagos del tenant y
//   audit_logs). Las columnas reconciled_* no se pueden tocar con UPDATE directo.
//
// Las columnas nuevas no están en types/database.ts (no se regenera en esta
// rama): se castea igual que en modules/agenda/api.ts.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { RawCardPayment } from "@/lib/reports/cardReconciliation";

const PAGE = 1000;
const MAX_ROWS = 20_000;

const COLUMNS =
  "id, method, amount, reference, created_at, reconciled_at, card_voucher, metadata, sales!inner(number, status)";

async function listCardPayments(fromISO: string, toISO: string): Promise<RawCardPayment[]> {
  const supabase = createClient();
  const out: RawCardPayment[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await supabase
      .from("payments")
      .select(COLUMNS as never)
      .in("method", ["debit", "credit"])
      .gte("created_at", fromISO)
      .lt("created_at", toISO)
      .neq("sales.status" as never, "voided" as never)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as RawCardPayment[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface ReconcileResult {
  updated: number;
  amount: number;
  reconciled_at: string | null;
}

async function setReconciled(ids: string[], reconciled: boolean): Promise<ReconcileResult> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_payments_reconciled" as never, {
    p_payment_ids: ids,
    p_reconciled: reconciled,
  } as never);
  if (error) throw error;
  return data as unknown as ReconcileResult;
}

const KEY = ["reports", "card-reconciliation"] as const;

export function useCardPayments(fromISO: string, toISO: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, fromISO, toISO],
    queryFn: () => listCardPayments(fromISO, toISO),
    enabled,
    staleTime: 30_000,
  });
}

export function useSetReconciled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, reconciled }: { ids: string[]; reconciled: boolean }) => setReconciled(ids, reconciled),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

const ERRORS: Array<[string, string]> = [
  ["feature_not_in_plan", "La conciliación de tarjetas no está incluida en tu plan."],
  ["forbidden", "Sólo el dueño o un encargado pueden conciliar cobros."],
  ["payment_not_found", "Alguno de los cobros ya no existe o no es de tarjeta. Actualizá la lista."],
  ["too_many_payments", "Son demasiados cobros juntos. Marcalos por día o por lote."],
  ["no_tenant", "Tu sesión no tiene un negocio activo. Volvé a ingresar."],
];

export function reconcileErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [code, text] of ERRORS) if (msg.includes(code)) return text;
  return "No se pudo guardar la conciliación. Probá de nuevo.";
}
