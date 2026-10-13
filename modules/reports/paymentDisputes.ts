"use client";

// Contracargos, reclamos y devoluciones (ADR-064): lectura de payment_disputes
// (RLS: dueño o encargado del negocio actual; filtro explícito por tenant,
// ADR-052) y la RPC payment_dispute_ack. La tabla no está en
// types/database.ts: se castea. Sin la migración, todo devuelve vacío (las
// marcas son un agregado, nunca rompen la pantalla).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { PaymentDisputeRow } from "@/lib/reports/paymentDisputes";

export const DISPUTE_COLS =
  "id, provider_key, kind, provider_payment_id, provider_case_id, payment_id, sale_id, settlement_line_id, amount, currency, status, provider_status, provider_status_detail, reason, refund_source, origin, documentation_status, documentation_deadline, coverage_applied, coverage_eligible, occurred_at, first_seen_at, resolved_at, acknowledged_at";

const toRow = (r: PaymentDisputeRow): PaymentDisputeRow => ({ ...r, amount: Number(r.amount) });

async function selectIn(column: "provider_payment_id" | "sale_id", values: string[]): Promise<PaymentDisputeRow[]> {
  const uniq = [...new Set(values.filter(Boolean))];
  if (uniq.length === 0) return [];
  const supabase = createClient();
  const tenantId = await getCurrentTenantId();
  const out: PaymentDisputeRow[] = [];
  for (let i = 0; i < uniq.length; i += 200) {
    let q = supabase
      .from("payment_disputes" as never)
      .select(DISPUTE_COLS)
      .in(column, uniq.slice(i, i + 200))
      .is("deleted_at", null);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q;
    if (error) return out; // sin la migración o sin permiso: sin marcas
    out.push(...((data ?? []) as unknown as PaymentDisputeRow[]).map(toRow));
  }
  return out;
}

/** Disputas de los pagos del procesador (conciliación). */
export function useDisputesForPayments(providerPaymentIds: string[], enabled: boolean) {
  const key = [...new Set(providerPaymentIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["disputes", "by-payment", key],
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
    queryFn: () => selectIn("provider_payment_id", key),
  });
}

/** Disputas de un conjunto de ventas (lista de ventas y detalle). */
export function useSaleDisputes(saleIds: string[], enabled: boolean) {
  const key = [...new Set(saleIds.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["disputes", "by-sale", key],
    enabled: enabled && key.length > 0,
    staleTime: 60_000,
    queryFn: () => selectIn("sale_id", key),
  });
}

/** Contracargos y reclamos abiertos, y avisos sin ver (todos los períodos). */
export function useOpenDisputes(enabled: boolean) {
  return useQuery({
    queryKey: ["disputes", "open"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<PaymentDisputeRow[]> => {
      const tenantId = await getCurrentTenantId();
      let q = createClient()
        .from("payment_disputes" as never)
        .select(DISPUTE_COLS)
        .is("deleted_at", null)
        .or("resolved_at.is.null,acknowledged_at.is.null");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q.order("first_seen_at", { ascending: false }).limit(200);
      if (error) return [];
      return ((data ?? []) as unknown as PaymentDisputeRow[]).map(toRow);
    },
  });
}

export function useAckDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await createClient().rpc("payment_dispute_ack" as never, { p_id: id } as never);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["disputes"] }),
  });
}
