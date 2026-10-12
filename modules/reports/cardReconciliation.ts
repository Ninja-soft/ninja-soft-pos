"use client";

// Conciliación de tarjetas (ADR-044): lectura de los cobros con tarjeta y
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
import type { RawVoucherEdit, VoucherPatch } from "@/lib/reports/voucherEdit";

const PAGE = 1000;
const MAX_ROWS = 20_000;

const COLUMNS =
  "id, method, amount, reference, created_at, reconciled_at, card_voucher, metadata, sales!inner(number, status, cash_shift:cash_shifts!cash_shift_id(opened_by))";

// storeId (F17 · H97): sucursal del chip del panel (null = todas las que el
// usuario puede ver: la RLS por sucursal de sales ya recorta el !inner).
async function listCardPayments(
  fromISO: string,
  toISO: string,
  storeId: string | null,
): Promise<RawCardPayment[]> {
  const supabase = createClient();
  const out: RawCardPayment[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let q = supabase
      .from("payments")
      .select(COLUMNS as never)
      .in("method", ["debit", "credit"])
      .gte("created_at", fromISO)
      .lt("created_at", toISO)
      .neq("sales.status" as never, "voided" as never);
    if (storeId) q = q.eq("sales.store_id" as never, storeId as never);
    const { data, error } = await q
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

// Historial de ediciones del cupón (payment_voucher_edits, migración
// 20261018200000). Se trae aparte de los cobros para que la pantalla siga
// funcionando aunque la migración todavía no esté aplicada: si la tabla no
// existe, no hay historial y listo.
async function listVoucherEdits(fromISO: string, toISO: string): Promise<RawVoucherEdit[]> {
  const supabase = createClient();
  const out: RawVoucherEdit[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await supabase
      .from("payment_voucher_edits" as never)
      .select(
        "id, payment_id, edited_at, edited_by_name, changed_keys, before_data, after_data, was_reconciled, reason, payments!inner(created_at)" as never,
      )
      .gte("payments.created_at" as never, fromISO as never)
      .lt("payments.created_at" as never, toISO as never)
      .order("edited_at" as never, { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) return out;
    const rows = (data ?? []) as unknown as RawVoucherEdit[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function useVoucherEdits(fromISO: string, toISO: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "edits", fromISO, toISO],
    queryFn: () => listVoucherEdits(fromISO, toISO),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export interface VoucherUpdateResult {
  changed: boolean;
  card_voucher: Record<string, unknown>;
  edited_at: string | null;
  was_reconciled: boolean;
}

async function updateVoucher(paymentId: string, patch: VoucherPatch, reason: string | null): Promise<VoucherUpdateResult> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_payment_voucher" as never, {
    p_payment_id: paymentId,
    p_patch: patch,
    p_reason: reason,
  } as never);
  if (error) throw error;
  return data as unknown as VoucherUpdateResult;
}

/** Corrige la numeración del cupón (RPC con permisos, validación y auditoría). */
export function useUpdateVoucher() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, patch, reason }: { paymentId: string; patch: VoucherPatch; reason: string | null }) =>
      updateVoucher(paymentId, patch, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCardPayments(
  fromISO: string,
  toISO: string,
  enabled: boolean,
  storeId: string | null = null,
) {
  return useQuery({
    queryKey: [...KEY, fromISO, toISO, storeId],
    queryFn: () => listCardPayments(fromISO, toISO, storeId),
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
