"use client";

// Conciliación de procesadores (ADR-061): lectura de liquidaciones y cruce.
//
// - Lectura: settlement_lines / settlement_sync_state con RLS (dueño o
//   encargado del negocio actual; filtrado explícito por tenant, ADR-052).
// - Escritura: RPC settlement_import_lines (archivo), settlement_line_resolve
//   (revisar, vincular, desvincular), settlement_set_auto_sync, y la Edge
//   `settlements` (sync por API de Mercado Pago y cruce).
// - Tablas y RPC nuevas no están en types/database.ts: se castea.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { SettlementLineRow, UnmatchedPayment } from "@/lib/reports/processorReconciliation";

export const LINE_COLS =
  "id, provider_key, scope_store_id, external_id, order_id, external_reference, kind, status, operation_at, release_date, released, gross, fee, taxes, net, refunded, payment_method, payment_type, card_brand, last4, installments, lote, cupon, autorizacion, comercio, terminal, description, payer, fee_detail, payment_id, intent_id, sale_id, match_status, match_method, diff_amount, review_note, reviewed_at";

const PAGE = 1000;
const MAX_ROWS = 20_000;

export const toNum = (r: SettlementLineRow): SettlementLineRow => ({
  ...r,
  gross: Number(r.gross),
  fee: Number(r.fee),
  taxes: Number(r.taxes),
  net: Number(r.net),
  refunded: Number(r.refunded),
  diff_amount: Number(r.diff_amount),
  fee_detail: Array.isArray(r.fee_detail) ? r.fee_detail : [],
});

async function listLines(provider: string, fromISO: string, toISO: string): Promise<SettlementLineRow[]> {
  const supabase = createClient();
  const tenantId = await getCurrentTenantId();
  const out: SettlementLineRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    let q = supabase
      .from("settlement_lines" as never)
      .select(LINE_COLS)
      .eq("provider_key", provider)
      .gte("operation_at", fromISO)
      .lt("operation_at", toISO);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data, error } = await q
      .order("operation_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as SettlementLineRow[]).map(toNum);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function useSettlementLines(provider: string, fromISO: string, toISO: string, enabled: boolean) {
  return useQuery({
    queryKey: ["settlements", "lines", provider, fromISO, toISO],
    queryFn: () => listLines(provider, fromISO, toISO),
    enabled,
    staleTime: 30_000,
  });
}

export interface SyncStateRow {
  scope_store_id: string | null;
  auto_sync: boolean;
  last_sync_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_count: number;
}

export function useSettlementSyncState(provider: string, enabled: boolean) {
  return useQuery({
    queryKey: ["settlements", "sync-state", provider],
    enabled,
    queryFn: async (): Promise<SyncStateRow[]> => {
      const tenantId = await getCurrentTenantId();
      let q = createClient()
        .from("settlement_sync_state" as never)
        .select("scope_store_id, auto_sync, last_sync_at, last_status, last_error, last_count")
        .eq("provider_key", provider);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as SyncStateRow[];
    },
  });
}

/** Números de venta de las líneas cruzadas (para mostrar el ticket). */
export function useSaleNumbers(saleIds: string[]) {
  const key = [...new Set(saleIds)].sort();
  return useQuery({
    queryKey: ["settlements", "sale-numbers", key],
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, { number: number; status: string }>> => {
      const out: Record<string, { number: number; status: string }> = {};
      const supabase = createClient();
      for (let i = 0; i < key.length; i += 200) {
        const { data, error } = await supabase
          .from("sales")
          .select("id, number, status")
          .in("id", key.slice(i, i + 200));
        if (error) throw error;
        for (const s of (data ?? []) as { id: string; number: number; status: string }[]) {
          out[s.id] = { number: s.number, status: s.status };
        }
      }
      return out;
    },
  });
}

// ── Edge settlements ─────────────────────────────────────────────────────────

async function edgeError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context;
  try {
    const body = ctx ? ((await ctx.json()) as { error?: string; detail?: string }) : null;
    if (body?.error) return new Error(body.detail ? `${body.error}: ${body.detail}` : body.error);
  } catch {
    // body no JSON
  }
  return error instanceof Error ? error : new Error("edge_error");
}

export interface MatchResponse {
  lines: number;
  candidates: number;
  updated: number;
  reconciled: number;
  unreconciled: number;
  unmatched_payments: UnmatchedPayment[];
  scopes?: { scope: string | null; fetched: number; saved: number; truncated: boolean; error?: string }[];
}

async function invoke(body: Record<string, unknown>): Promise<MatchResponse> {
  const { data, error } = await createClient().functions.invoke("settlements", { body });
  if (error) throw await edgeError(error);
  return data as MatchResponse;
}

/**
 * Cruce del período (idempotente): actualiza las líneas y devuelve los cobros
 * del POS sin línea ("Venta sin cobro"). Se corre al abrir la vista y al
 * cambiar el período.
 */
export function useSettlementMatch(provider: string, fromISO: string, toISO: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["settlements", "match", provider, fromISO, toISO],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const res = await invoke({ action: "match", provider, from: fromISO, to: toISO });
      if (res.updated > 0) await qc.invalidateQueries({ queryKey: ["settlements", "lines", provider] });
      return res;
    },
  });
}

export function useSettlementSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { provider: string; fromISO: string; toISO: string }) =>
      invoke({ action: "sync", provider: v.provider, from: v.fromISO, to: v.toISO }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["reports", "card-payments"] });
      // La sincronización también trae contracargos y devoluciones (ADR-064).
      qc.invalidateQueries({ queryKey: ["disputes"] });
      void v;
    },
  });
}

export function useImportSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { provider: string; fileName: string; lines: Record<string, unknown>[]; fromISO: string; toISO: string }) => {
      const { data, error } = await createClient().rpc("settlement_import_lines" as never, {
        p_provider: v.provider,
        p_file_name: v.fileName,
        p_lines: v.lines,
      } as never);
      if (error) throw error;
      const res = data as unknown as { import_id: string; inserted: number; updated: number; skipped: number; from: string | null; to: string | null };
      // Cruce del período del archivo (o el elegido si viene vacío).
      const from = res.from ? new Date(new Date(res.from).getTime() - 86_400_000).toISOString() : v.fromISO;
      const to = res.to ? new Date(new Date(res.to).getTime() + 86_400_000).toISOString() : v.toISO;
      const match = await invoke({ action: "match", provider: v.provider, from, to }).catch(() => null);
      return { ...res, match };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settlements"] }),
  });
}

/** accept_diff (ADR-162): concilia una línea con diferencia de monto, con motivo. */
export type ResolveAction = "ignore" | "unignore" | "link" | "unlink" | "accept_diff";

export function useResolveLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { lineId: string; action: ResolveAction; paymentId?: string | null; note?: string | null }) => {
      const { error } = await createClient().rpc("settlement_line_resolve" as never, {
        p_line_id: v.lineId,
        p_action: v.action,
        p_payment_id: v.paymentId ?? null,
        p_note: v.note ?? null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settlements"] });
      qc.invalidateQueries({ queryKey: ["reports", "card-payments"] });
      qc.invalidateQueries({ queryKey: ["treasury"] });
    },
  });
}

export function useSetAutoSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { provider: string; auto: boolean }) => {
      const { error } = await createClient().rpc("settlement_set_auto_sync" as never, {
        p_provider: v.provider,
        p_auto: v.auto,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settlements", "sync-state"] }),
  });
}

/** Cobros del POS de un día para vincular a mano (mismo monto primero). */
export function usePaymentsForLink(dayISO: string | null, amount: number | null) {
  return useQuery({
    queryKey: ["settlements", "link-candidates", dayISO, amount],
    enabled: Boolean(dayISO),
    queryFn: async () => {
      const d = new Date(dayISO!);
      const from = new Date(d.getTime() - 2 * 86_400_000).toISOString();
      const to = new Date(d.getTime() + 2 * 86_400_000).toISOString();
      const tenantId = await getCurrentTenantId();
      let q = createClient()
        .from("payments")
        .select("id, method, amount, reference, created_at, sale_id, sales!inner(number, status)" as never)
        .gte("created_at", from)
        .lt("created_at", to)
        .not("method", "in", "(cash,account,store_credit)");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(300);
      if (error) throw error;
      const rows = (data ?? []) as unknown as {
        id: string;
        method: string;
        amount: number;
        reference: string | null;
        created_at: string;
        sale_id: string;
        sales: { number: number; status: string };
      }[];
      const target = amount ?? 0;
      return rows
        .map((r) => ({ ...r, amount: Number(r.amount) }))
        .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target));
    },
  });
}

const ERRORS: [string, string][] = [
  ["feature_not_in_plan", "Tu plan no incluye la conciliación de procesadores."],
  ["forbidden", "Sólo el dueño o el encargado pueden conciliar."],
  ["not_connected", "Mercado Pago no está conectado. Conectalo para traer tus cobros."],
  ["payment_already_linked", "Ese cobro ya está vinculado a otra línea."],
  ["line_not_amount_diff", "Sólo se acepta la diferencia de una línea vinculada con diferencia de monto."],
  ["reason_required", "Escribí el motivo (al menos 3 letras)."],
  ["payment_not_found", "No encontramos ese cobro."],
  ["too_many_lines", "El archivo tiene más de 5.000 filas: dividilo por período."],
  ["invalid_range", "Elegí un período de hasta 93 días."],
  ["mp_search_401", "Mercado Pago rechazó la credencial. Volvé a conectar la cuenta."],
  ["mp_search_403", "La cuenta de Mercado Pago no tiene permiso para leer los cobros."],
  ["no_open_shift", "Abrí tu caja para registrar la venta."],
  ["shift_required", "Abrí tu caja para registrar la venta."],
];

export function settlementErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [code, text] of ERRORS) if (msg.includes(code)) return text;
  return "No se pudo completar. Probá de nuevo.";
}
