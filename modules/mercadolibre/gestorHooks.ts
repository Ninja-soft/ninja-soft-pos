"use client";

// Gestor de Mercado Libre, parte B (H141 · ADR-132): métricas, posventa,
// embudos, plantillas y configuración del gestor. Lectura por tabla con RLS;
// escrituras por RPC (ml_gestor_assert) o por la Edge ml_gestor (el servidor
// exige plan, rol y que la acción siga disponible en Mercado Libre).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { ReputationSnap, Thresholds } from "@/supabase/functions/_shared/mercadolibre/reputation";
import type { AutoKey, Board, ClaimKind, StageRow } from "@/lib/mercadolibre/postsale";

const from = (t: string) => createClient().from(t as never);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

/** Llama a la Edge ml_gestor; un error HTTP se lanza con su código. */
export async function mlGestorEdge<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke("ml_gestor", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let detail: { error?: string; message?: string } | null = null;
    try {
      detail = ctx && typeof ctx.json === "function" ? await ctx.json() : null;
    } catch {
      detail = null;
    }
    throw new Error([detail?.error, detail?.message].filter(Boolean).join(": ") || error.message);
  }
  const res = data as (T & { error?: string; message?: string }) | null;
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error([res.error, res.message].filter(Boolean).join(": "));
  return data as T;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export interface MlGestorSettings {
  account_id: string;
  thresholds: Thresholds;
  exclusion_reasons: string[];
  notify: { claims: boolean; due_hours: number; reputation: boolean };
}

export interface MlSnapshotRow {
  snap_date: string;
  level_id: string | null;
  power_seller_status: string | null;
  sales_completed: number;
  claims_rate: number;
  cancellations_rate: number;
  delayed_rate: number;
  data: ReputationSnap;
  taken_at: string;
}

export interface MlClaimRow {
  id: string;
  account_id: string;
  claim_id: number;
  resource_id: number | null;
  pack_key: string | null;
  kind: ClaimKind;
  type: string | null;
  stage: string | null;
  status: string;
  reason_id: string | null;
  due_at: string | null;
  action_responsible: string | null;
  my_actions: Array<{ action: string; mandatory: boolean; due_date: string | null }>;
  detail_title: string | null;
  return_status: string | null;
  affects_reputation: boolean | null;
  resolution_result: string | null;
  exclusion_status: string | null;
  exclusion_note: string | null;
  assigned_to: string | null;
  date_created: string | null;
  ml_last_updated: string | null;
}

export interface MlTemplate {
  id: string;
  scope: "question" | "claim" | "message";
  name: string;
  body: string;
  sort: number;
}

export interface MlBoardCard {
  ref_key: string;
  stage_id: string | null;
  assigned_to: string | null;
  note: string | null;
  moved_at: string | null;
}

export interface MlClaimDetail {
  claim: Record<string, unknown> | null;
  detail: { title?: string | null; description?: string | null; problem?: string | null; due_date?: string | null; action_responsible?: string | null } | null;
  messages: Array<{ from: string; to: string; text: string; date: string | null; attachments: string[] }>;
  return: { id?: number; status?: string | null; subtype?: string | null; status_money?: string | null } | null;
  offers: Array<{ percentage: number; amount: number }>;
  currency: string | null;
  can: { message_complainant: boolean; message_mediator: boolean; open_dispute: boolean; allow_return: boolean; partial_refund: boolean } | null;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
export function useMlGestorSettings(accountId: string | null) {
  return useQuery({
    queryKey: ["ml", "gestor-settings", accountId],
    enabled: Boolean(accountId),
    queryFn: async (): Promise<MlGestorSettings | null> => {
      const { data, error } = await from("ml_gestor_settings")
        .select("account_id, thresholds, exclusion_reasons, notify")
        .eq("account_id", accountId!)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as MlGestorSettings) ?? null;
    },
  });
}

export function useMlSnapshots(accountId: string | null, days: number) {
  return useQuery({
    queryKey: ["ml", "snapshots", accountId, days],
    enabled: Boolean(accountId),
    queryFn: async (): Promise<MlSnapshotRow[]> => {
      const since = new Date(Date.now() - (days + 1) * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await from("ml_reputation_snapshots")
        .select("snap_date, level_id, power_seller_status, sales_completed, claims_rate, cancellations_rate, delayed_rate, data, taken_at")
        .eq("account_id", accountId!)
        .gte("snap_date", since)
        .order("snap_date");
      if (error) throw error;
      return ((data ?? []) as unknown as MlSnapshotRow[]).map((r) => ({
        ...r,
        claims_rate: Number(r.claims_rate),
        cancellations_rate: Number(r.cancellations_rate),
        delayed_rate: Number(r.delayed_rate),
      }));
    },
  });
}

const CLAIM_COLS =
  "id, account_id, claim_id, resource_id, pack_key, kind, type, stage, status, reason_id, due_at, action_responsible, my_actions, " +
  "detail_title, return_status, affects_reputation, resolution_result, exclusion_status, exclusion_note, assigned_to, date_created, ml_last_updated";

/** Reclamos: abiertos todos y cerrados de los últimos `closedDays`. */
export function useMlClaims(accountId: string | null, closedDays = 60) {
  return useQuery({
    queryKey: ["ml", "claims", accountId, closedDays],
    enabled: Boolean(accountId),
    queryFn: async (): Promise<MlClaimRow[]> => {
      const since = new Date(Date.now() - closedDays * 86400_000).toISOString();
      const { data, error } = await from("ml_claims")
        .select(CLAIM_COLS)
        .eq("account_id", accountId!)
        .or(`status.eq.opened,date_created.gte.${since}`)
        .order("date_created", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as MlClaimRow[];
    },
  });
}

export function useMlTemplates(scope: MlTemplate["scope"] | null) {
  return useQuery({
    queryKey: ["ml", "templates", scope],
    queryFn: async (): Promise<MlTemplate[]> => {
      let q = from("ml_reply_templates").select("id, scope, name, body, sort").is("deleted_at", null).order("sort").order("name");
      if (scope) q = q.eq("scope", scope);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as MlTemplate[];
    },
  });
}

export function useMlBoard(board: Board, accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["ml", "board", board, accountId],
    enabled: Boolean(accountId) && enabled,
    queryFn: async (): Promise<{ stages: StageRow[]; cards: MlBoardCard[] }> => {
      const stages = await rpc<Array<StageRow & { auto_key: AutoKey | null }>>("ml_board_stages_ensure", { p_board: board });
      const { data, error } = await from("ml_board_cards")
        .select("ref_key, stage_id, assigned_to, note, moved_at")
        .eq("account_id", accountId!)
        .eq("board", board);
      if (error) throw error;
      return { stages: stages ?? [], cards: (data ?? []) as unknown as MlBoardCard[] };
    },
  });
}

export function useMlClaimDetail(claimRowId: string | null) {
  return useQuery({
    queryKey: ["ml", "claim-detail", claimRowId],
    enabled: Boolean(claimRowId),
    staleTime: 30_000,
    queryFn: () => mlGestorEdge<MlClaimDetail>({ action: "claim_detail", claim_row_id: claimRowId }),
  });
}

export function useMlPackMessages(accountId: string | null, packKey: string | null) {
  return useQuery({
    queryKey: ["ml", "pack-messages", accountId, packKey],
    enabled: Boolean(accountId && packKey),
    queryFn: () =>
      mlGestorEdge<{ messages: Array<{ mine: boolean; text: string; date: string | null }> }>({
        action: "pack_messages",
        account_id: accountId,
        pack_key: packKey,
      }),
  });
}

// ---------------------------------------------------------------------------
// Mutaciones
// ---------------------------------------------------------------------------
export function useMlGestorMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: ["ml"] });
  return {
    refreshReputation: useMutation({
      mutationFn: (accountId: string) => mlGestorEdge<{ ok: boolean; alerts: number }>({ action: "reputation_refresh", account_id: accountId }),
      onSuccess: inv,
    }),
    syncClaims: useMutation({
      mutationFn: (accountId: string) => mlGestorEdge<{ ok: boolean; seen: number; refreshed: number }>({ action: "claims_sync", account_id: accountId }),
      onSuccess: inv,
    }),
    sendClaimMessage: useMutation({
      mutationFn: (v: { claimRowId: string; receiver: "complainant" | "mediator"; message: string; attachments: Array<{ name: string; type: string; base64: string }> }) =>
        mlGestorEdge<{ ok: boolean }>({
          action: "claim_message",
          claim_row_id: v.claimRowId,
          receiver: v.receiver,
          message: v.message,
          attachments: v.attachments,
        }),
      onSuccess: inv,
    }),
    openDispute: useMutation({
      mutationFn: (claimRowId: string) => mlGestorEdge<{ ok: boolean }>({ action: "claim_open_dispute", claim_row_id: claimRowId }),
      onSuccess: inv,
    }),
    allowReturn: useMutation({
      mutationFn: (claimRowId: string) => mlGestorEdge<{ ok: boolean }>({ action: "claim_allow_return", claim_row_id: claimRowId }),
      onSuccess: inv,
    }),
    partialRefund: useMutation({
      mutationFn: (v: { claimRowId: string; percentage: number; expectedAmount: number }) =>
        mlGestorEdge<{ ok: boolean }>({
          action: "claim_partial_refund",
          claim_row_id: v.claimRowId,
          percentage: v.percentage,
          expected_amount: v.expectedAmount,
        }),
      onSuccess: inv,
    }),
    sendPackMessage: useMutation({
      mutationFn: (v: { accountId: string; packKey: string; text: string }) =>
        mlGestorEdge<{ ok: boolean }>({ action: "pack_message_send", account_id: v.accountId, pack_key: v.packKey, text: v.text }),
      onSuccess: inv,
    }),
    setExclusion: useMutation({
      mutationFn: (v: { claimRowId: string; status: string | null; note?: string }) =>
        rpc("ml_claim_exclusion_set", { p_claim: v.claimRowId, p_status: v.status, p_note: v.note ?? null }),
      onSuccess: inv,
    }),
    saveSettings: useMutation({
      mutationFn: (v: { accountId: string; p: Partial<Omit<MlGestorSettings, "account_id">> }) => rpc("ml_gestor_settings_save", { p_account: v.accountId, p: v.p }),
      onSuccess: inv,
    }),
    saveTemplate: useMutation({
      mutationFn: (v: { id: string | null; p: Omit<MlTemplate, "id"> }) => rpc<string>("ml_reply_template_save", { p_id: v.id, p: v.p }),
      onSuccess: inv,
    }),
    deleteTemplate: useMutation({
      mutationFn: (id: string) => rpc("ml_reply_template_delete", { p_id: id }),
      onSuccess: inv,
    }),
    saveStages: useMutation({
      mutationFn: (v: { board: Board; stages: Array<{ id?: string; name: string; auto_key: AutoKey | null; is_final: boolean }> }) =>
        rpc("ml_board_stages_save", { p_board: v.board, p: v.stages }),
      onSuccess: inv,
    }),
    setCard: useMutation({
      mutationFn: (v: { board: Board; accountId: string; refKey: string; p: { stage_id?: string | null; assigned_to?: string | null; note?: string | null } }) =>
        rpc("ml_board_card_set", { p_board: v.board, p_account: v.accountId, p_ref_key: v.refKey, p: v.p }),
      onMutate: async (v) => {
        // Movimiento optimista: la tarjeta cambia de columna al instante.
        const key = ["ml", "board", v.board, v.accountId];
        await qc.cancelQueries({ queryKey: key });
        const prev = qc.getQueryData<{ stages: StageRow[]; cards: MlBoardCard[] }>(key);
        if (prev) {
          const existing = prev.cards.find((c) => c.ref_key === v.refKey);
          const next: MlBoardCard = {
            ref_key: v.refKey,
            stage_id: "stage_id" in v.p ? (v.p.stage_id ?? null) : (existing?.stage_id ?? null),
            assigned_to: "assigned_to" in v.p ? (v.p.assigned_to ?? null) : (existing?.assigned_to ?? null),
            note: "note" in v.p ? (v.p.note ?? null) : (existing?.note ?? null),
            moved_at: "stage_id" in v.p ? new Date().toISOString() : (existing?.moved_at ?? null),
          };
          qc.setQueryData(key, { ...prev, cards: [...prev.cards.filter((c) => c.ref_key !== v.refKey), next] });
        }
        return { prev, key };
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      },
      onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: ["ml", "board", v.board, v.accountId] }),
    }),
  };
}
