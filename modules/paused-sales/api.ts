// =============================================================================
// Pausar venta (ADR-106): acceso a datos. Lectura directa con RLS (negocio,
// sucursal permitida y dueño de la venta o del turno, o dueño / encargado);
// toda escritura por RPC SECURITY DEFINER. Los tipos generados no se
// regeneran: las tablas y RPC nuevas viajan con cast.
// =============================================================================
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { CheckoutSnapshot } from "@/components/pos/checkout/types";
import { readPausedCart, type PausedCart, type PausedPayment, type PausedSale } from "./logic";

const COLS =
  "id, tenant_id, store_id, register_id, cash_shift_id, created_by, resumed_by, customer_id, customer_name, label, cart, checkout, total, paid_amount, item_count, status, carry_over, needs_review, source, paused_at, resumed_at, version, paused_sale_payments(id, kind, method, amount, reference, card_voucher, intent_id, provider_key, channel, line, status, credited, position)";

type Row = Record<string, unknown> & { paused_sale_payments?: Record<string, unknown>[] };

function normPayment(p: Record<string, unknown>): PausedPayment {
  return {
    id: p.id as string,
    kind: p.kind as PausedPayment["kind"],
    method: String(p.method),
    amount: Number(p.amount) || 0,
    reference: (p.reference as string | null) ?? null,
    card_voucher: (p.card_voucher as Record<string, unknown> | null) ?? null,
    intent_id: (p.intent_id as string | null) ?? null,
    provider_key: (p.provider_key as string | null) ?? null,
    channel: (p.channel as "qr" | "link" | null) ?? null,
    line: (p.line as Record<string, unknown>) ?? {},
    status: p.status as PausedPayment["status"],
    credited: Boolean(p.credited),
  };
}

export function normalizePaused(r: Row, payments?: Record<string, unknown>[]): PausedSale {
  const pays = (payments ?? r.paused_sale_payments ?? [])
    .slice()
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map(normPayment);
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    store_id: r.store_id as string,
    register_id: (r.register_id as string | null) ?? null,
    cash_shift_id: (r.cash_shift_id as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null,
    resumed_by: (r.resumed_by as string | null) ?? null,
    customer_id: (r.customer_id as string | null) ?? null,
    customer_name: (r.customer_name as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    cart: (readPausedCart(r.cart) ?? { v: 1, lines: [], discountTotal: 0, couponCode: null, customer: null, offeredWarrantyId: "", pricing: { listId: null, termId: null }, notes: null }) as PausedCart,
    checkout: (r.checkout && typeof r.checkout === "object" && Array.isArray((r.checkout as CheckoutSnapshot).lines)
      ? (r.checkout as CheckoutSnapshot)
      : null),
    total: Number(r.total) || 0,
    paid_amount: Number(r.paid_amount) || 0,
    item_count: Number(r.item_count) || 0,
    status: r.status as PausedSale["status"],
    carry_over: Boolean(r.carry_over),
    needs_review: Boolean(r.needs_review),
    source: (r.source as "online" | "offline") ?? "online",
    paused_at: String(r.paused_at ?? new Date().toISOString()),
    resumed_at: (r.resumed_at as string | null) ?? null,
    version: Number(r.version) || 1,
    payments: pays,
  };
}

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw new Error(error.message);
  return data as T;
};

export interface PauseArgs {
  id: string;
  storeId: string;
  registerId: string | null;
  cashShiftId: string | null;
  customerId: string | null;
  customerName: string | null;
  label: string | null;
  cart: PausedCart;
  checkout: CheckoutSnapshot | null;
  saleArgs: Record<string, unknown>;
  total: number;
  itemCount: number;
  payments: PausedPayment[];
  source: "online" | "offline";
  version?: number | null;
}

export interface ResumeResult {
  status: "resumed" | "completed";
  id: string;
  version?: number;
  sale_id?: string;
  sale?: Row;
  payments?: Record<string, unknown>[];
  check?: { ok: true; total: number; tip: number | null } | { ok: false; error: string } | null;
  cancelled_intents?: { intent_id: string; provider_key: string | null; channel: "qr" | "link" | null }[];
}

export const pausedSalesApi = {
  /** Abiertas (pausadas o retomadas) de la sucursal, siempre del negocio activo. */
  listOpen: async (storeId: string | null): Promise<PausedSale[]> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId || !storeId) return [];
    const { data, error } = await createClient()
      .from("paused_sales" as never)
      .select(COLS)
      .eq("tenant_id", tenantId)
      .eq("store_id", storeId)
      .in("status", ["paused", "resumed"])
      .order("paused_at", { ascending: false })
      .limit(60);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Row[]).map((r) => normalizePaused(r));
  },

  pause: (a: PauseArgs) =>
    rpc<{ id: string; version: number; status: string; paid_amount: number; label: string | null }>("pause_sale", {
      p_id: a.id,
      p_store_id: a.storeId,
      p_register_id: a.registerId,
      p_cash_shift_id: a.cashShiftId,
      p_customer_id: a.customerId,
      p_customer_name: a.customerName,
      p_label: a.label,
      p_cart: a.cart,
      p_checkout: a.checkout ?? {},
      p_sale_args: a.saleArgs,
      p_total: a.total,
      p_item_count: a.itemCount,
      p_payments: a.payments.map((p) => ({
        kind: p.kind,
        method: p.method,
        amount: p.amount,
        reference: p.reference ?? null,
        card_voucher: p.card_voucher ?? null,
        intent_id: p.intent_id ?? null,
        provider_key: p.provider_key ?? null,
        channel: p.channel ?? null,
        line: p.line ?? {},
      })),
      p_source: a.source,
      p_version: a.version ?? null,
    }),

  resume: (id: string, cashShiftId: string | null, cancelPending: boolean) =>
    rpc<ResumeResult>("resume_paused_sale", {
      p_id: id,
      p_cash_shift_id: cashShiftId,
      p_cancel_pending: cancelPending,
      p_version: null,
    }),

  complete: (id: string, saleId: string | null) =>
    rpc<{ id: string; status: string }>("complete_paused_sale", { p_id: id, p_sale_id: saleId }),

  discard: (id: string, reason: string | null, refundConfirmed: boolean) =>
    rpc<{ id: string; status: string; cancelled_intents: ResumeResult["cancelled_intents"] }>("discard_paused_sale", {
      p_id: id,
      p_reason: reason,
      p_refund_confirmed: refundConfirmed,
      p_version: null,
    }),

  rename: (id: string, label: string) =>
    rpc<{ id: string; label: string | null }>("rename_paused_sale", { p_id: id, p_label: label }),

  logCleared: (a: {
    storeId: string;
    cashShiftId: string | null;
    total: number;
    itemCount: number;
    payments: Pick<PausedPayment, "kind" | "method" | "amount" | "status">[];
  }) =>
    rpc<null>("log_pos_cleared_sale", {
      p_store_id: a.storeId,
      p_cash_shift_id: a.cashShiftId,
      p_total: a.total,
      p_item_count: a.itemCount,
      p_payments: a.payments,
    }),
};

/** ¿Es un corte de red (y no un error del servidor)? */
export function isNetworkFailure(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}
