"use client";

// Reintegro por Mercado Pago (H21h · ADR-067): opciones del wizard
// (mp_refund_options), Edge mp_refund, respaldo (mp_refund_fallback), filas de
// una venta y ajuste del dueño (mp_refund_settings_save). Las RPC y la tabla
// no están en types/database.ts: se castean. Sin la migración, las opciones
// vuelven vacías y el wizard sigue como antes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getActiveShiftId } from "@/modules/branches/store";
import type { MpRefundOptions, MpRefundRow, MpRefundStatus } from "@/lib/payments/mpRefund";

type Loose = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};
const loose = () => createClient() as unknown as Loose;

export interface MpRefundRunResult {
  status: MpRefundStatus | "error";
  refund_id: string;
  mp_refund_id?: string | null;
  error?: string | null;
  detail?: string | null;
}

export async function fetchMpRefundOptions(saleId: string): Promise<MpRefundOptions | null> {
  const { data, error } = await loose().rpc("mp_refund_options", { p_sale_id: saleId });
  if (error || !data) return null;
  const o = data as MpRefundOptions;
  return {
    ...o,
    payments: (o.payments ?? []).map((p) => ({
      ...p,
      paid: Number(p.paid),
      refunded: Number(p.refunded),
      refundable: Number(p.refundable),
    })),
  };
}

/** Llama a la Edge mp_refund. Nunca tira: devuelve el estado o el error. */
export async function runMpRefund(refundId: string): Promise<MpRefundRunResult> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("mp_refund", { body: { refund_id: refundId } });
  let res = data as (MpRefundRunResult & { error?: string }) | null;
  if (error) {
    const ctx = (error as { context?: Response }).context;
    try {
      res = ctx ? await ctx.json() : null;
    } catch {
      res = null;
    }
    if (!res) return { status: "error", refund_id: refundId, error: "provider_unavailable" };
  }
  if (res && "status" in res && res.status) return res;
  return { status: "error", refund_id: refundId, error: res?.error ?? "provider_error" };
}

export async function mpRefundFallback(input: {
  refundId: string;
  method: "cash" | "store_credit";
  customerId?: string | null;
}): Promise<{ method: string; amount: number; voucher_code: string | null; voucher_expires_at: string | null }> {
  const shift = getActiveShiftId();
  const { data, error } = await loose().rpc("mp_refund_fallback", {
    p_refund_id: input.refundId,
    p_method: input.method,
    ...(shift ? { p_cash_shift_id: shift } : {}),
    ...(input.customerId ? { p_customer_id: input.customerId } : {}),
  });
  if (error) throw new Error(error.message);
  return data as { method: string; amount: number; voucher_code: string | null; voucher_expires_at: string | null };
}

export function useMpRefundOptions(saleId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "mp-refund-options", saleId],
    enabled: enabled && Boolean(saleId),
    staleTime: 15_000,
    queryFn: () => fetchMpRefundOptions(saleId!),
  });
}

/** Reintegros por MP de una venta (detalle de la venta y ficha del cliente). */
export function useSaleMpRefunds(saleId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sales", "mp-refunds", saleId],
    enabled: enabled && Boolean(saleId),
    staleTime: 15_000,
    queryFn: async (): Promise<MpRefundRow[]> => {
      const { data, error } = await createClient()
        .from("mp_refunds" as never)
        .select(
          "id, sale_id, sale_return_id, payment_id, amount, status, mp_refund_id, mp_status, error_code, error_detail, fallback_method, created_at, completed_at",
        )
        .eq("sale_id", saleId!)
        .order("created_at", { ascending: true });
      if (error) return [];
      return ((data ?? []) as unknown as MpRefundRow[]).map((r) => ({ ...r, amount: Number(r.amount) }));
    },
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["sales"] });
  qc.invalidateQueries({ queryKey: ["customers"] });
  qc.invalidateQueries({ queryKey: ["vouchers"] });
  qc.invalidateQueries({ queryKey: ["disputes"] });
}

export function useRunMpRefund() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refundId: string) => runMpRefund(refundId),
    onSettled: () => invalidateAll(qc),
  });
}

export function useMpRefundFallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: mpRefundFallback,
    onSettled: () => invalidateAll(qc),
  });
}

/** Ajuste del dueño: permitir devolver por Mercado Pago. */
export function useSaveMpRefundSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await loose().rpc("mp_refund_settings_save", { p_enabled: enabled });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payment-methods"] });
      qc.invalidateQueries({ queryKey: ["tenant-payment-methods"] });
    },
  });
}
