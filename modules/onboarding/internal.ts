"use client";

// Panel interno de recorridos, sugerencias y activación (F15 · H70, H71, H74 ·
// ADR-089). Todo bajo internal_scope() (el cliente de /internal manda el
// header). Las RPC nuevas no están en types/database.ts todavía: cast.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Audience, ConfigStatus, NudgeDraft, OnboardingEvent, TourDraft, TourStep } from "@/lib/onboarding/schema";
import { parseActivationRows, type ActivationHealth, type ActivationRow } from "@/lib/onboarding/activationScore";

type LooseResult = { data: unknown; error: { message: string } | null };
interface LooseQuery extends PromiseLike<LooseResult> {
  select: (cols: string) => LooseQuery;
  order: (col: string, opts?: { ascending?: boolean }) => LooseQuery;
  eq: (col: string, v: unknown) => LooseQuery;
  is: (col: string, v: null) => LooseQuery;
  limit: (n: number) => LooseQuery;
  maybeSingle: () => PromiseLike<LooseResult>;
}
type Loose = {
  from: (t: string) => LooseQuery;
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<LooseResult>;
};
const loose = () => createClient() as unknown as Loose;

async function call<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await loose().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface TourRow {
  id: string;
  key: string;
  title: string;
  description: string | null;
  status: ConfigStatus;
  trigger_event: OnboardingEvent;
  audience: Audience;
  priority: number;
  steps: TourStep[];
  published_version: number | null;
  published_at: string | null;
  draft_updated_at: string;
  updated_at: string;
}

export interface NudgeRow {
  id: string;
  key: string;
  title: string;
  body: string | null;
  event: OnboardingEvent;
  audience: Audience;
  priority: number;
  cooldown_hours: number;
  max_impressions: number;
  starts_at: string | null;
  expires_at: string | null;
  cta_label: string | null;
  cta_href: string | null;
  support_fallback: boolean;
  status: ConfigStatus;
  version: number;
  published_at: string | null;
  created_at: string;
}

export interface TourMetrics {
  versions: { version: number; starts: number; completed: number; dismissed: number; completion_rate: number | null }[];
  steps: { version: number; step_index: number; step_id: string | null; views: number; abandoned: number }[];
  tenants_reached: number;
  tenants_first_sale_after: number;
}

export interface NudgeMetrics {
  nudge_id: string;
  shown: number;
  clicked: number;
  dismissed: number;
  users_reached: number;
  tenants_reached: number;
  tenants_first_sale_after: number;
}

export interface AssignmentRow {
  id: string;
  tenant_id: string;
  kind: "tour" | "nudge";
  tour_id: string | null;
  nudge_id: string | null;
  target_role: string | null;
  reason: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  cancelled_at: string | null;
}

/** Ya no cambió nada desde la última publicación. */
export function tourHasDraftChanges(t: Pick<TourRow, "published_at" | "draft_updated_at" | "published_version">): boolean {
  if (!t.published_version || !t.published_at) return true;
  return new Date(t.draft_updated_at).getTime() > new Date(t.published_at).getTime();
}

export function onboardingErrorMessage(message: string): string {
  if (/forbidden/.test(message)) return "Tu nivel de staff no puede hacer esto.";
  if (/invalid_steps/.test(message)) return "Revisá los pasos: cada uno necesita id, título y ancla si no es una ventana.";
  if (/invalid_audience/.test(message)) return "La audiencia tiene un criterio inválido.";
  if (/nothing_to_publish/.test(message)) return "No hay cambios desde la última publicación.";
  if (/key_locked/.test(message)) return "La clave no se cambia después de publicar.";
  if (/never_published/.test(message)) return "Publicalo primero.";
  if (/not_published/.test(message)) return "Sólo se pueden disparar recorridos o sugerencias publicados.";
  if (/invalid_reason/.test(message)) return "Escribí un motivo (5 a 500 caracteres).";
  if (/invalid_limits/.test(message)) return "El límite por sesión no puede superar al diario.";
  if (/duplicate key|unique/.test(message)) return "Ya existe uno con esa clave.";
  if (/archived/.test(message)) return "Está archivado.";
  return "No se pudo guardar. Probá de nuevo.";
}

// ── Lecturas ────────────────────────────────────────────────────────────────

export function useInternalTours() {
  return useQuery({
    queryKey: ["internal", "onboarding", "tours"],
    queryFn: async (): Promise<TourRow[]> => {
      const { data, error } = await loose().from("onboarding_tours").select("*").order("priority", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as TourRow[];
    },
  });
}

export function useInternalNudges() {
  return useQuery({
    queryKey: ["internal", "onboarding", "nudges"],
    queryFn: async (): Promise<NudgeRow[]> => {
      const { data, error } = await loose().from("onboarding_nudges").select("*").order("priority", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as NudgeRow[];
    },
  });
}

export function useNudgeSettings() {
  return useQuery({
    queryKey: ["internal", "onboarding", "nudge-settings"],
    queryFn: async (): Promise<{ per_session: number; per_day: number }> => {
      const { data, error } = await loose().from("onboarding_nudge_settings").select("per_session, per_day").maybeSingle();
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as { per_session?: number; per_day?: number };
      return { per_session: r.per_session ?? 1, per_day: r.per_day ?? 3 };
    },
  });
}

export function useTourMetrics(tourId: string | null) {
  return useQuery({
    queryKey: ["internal", "onboarding", "tour-metrics", tourId],
    enabled: Boolean(tourId),
    queryFn: () => call<TourMetrics>("internal_tour_metrics", { p_id: tourId }),
  });
}

export function useNudgeMetrics() {
  return useQuery({
    queryKey: ["internal", "onboarding", "nudge-metrics"],
    queryFn: async (): Promise<Map<string, NudgeMetrics>> => {
      const rows = (await call<NudgeMetrics[]>("internal_nudge_metrics")) ?? [];
      return new Map(rows.map((r) => [r.nudge_id, r]));
    },
  });
}

export function useActivationOverview() {
  return useQuery({
    queryKey: ["internal", "onboarding", "activation"],
    queryFn: async (): Promise<{ rows: ActivationRow[]; health: Map<string, ActivationHealth> }> => {
      // Login, ventas y usuarios activos: internal_tenant_health (ADR-084), sin repetirlos.
      const [rows, health] = await Promise.all([
        call<unknown>("internal_activation_overview"),
        call<unknown>("internal_tenant_health"),
      ]);
      const healthRows = (Array.isArray(health) ? health : []) as (ActivationHealth & { tenant_id: string })[];
      return {
        rows: parseActivationRows(rows),
        health: new Map(healthRows.map((h) => [h.tenant_id, h])),
      };
    },
  });
}

export function useOpenAssignments() {
  return useQuery({
    queryKey: ["internal", "onboarding", "assignments"],
    queryFn: async (): Promise<AssignmentRow[]> => {
      const { data, error } = await loose()
        .from("onboarding_assignments")
        .select("*")
        .is("consumed_at", null)
        .is("cancelled_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as AssignmentRow[];
    },
  });
}

// ── Escrituras (auditadas en el servidor) ──────────────────────────────────

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["internal", "onboarding"] });
    qc.invalidateQueries({ queryKey: ["internal", "audit"] });
  };
}

export function useSaveTour() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string | null; draft: TourDraft }) =>
      call<string>("internal_tour_save", {
        p_id: v.id,
        p_key: v.draft.key,
        p_title: v.draft.title,
        p_description: v.draft.description ?? null,
        p_trigger: v.draft.trigger_event,
        p_audience: v.draft.audience,
        p_priority: v.draft.priority,
        p_steps: v.draft.steps,
      }),
    onSuccess: inv,
  });
}

export function usePublishTour() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => call<number>("internal_tour_publish", { p_id: id }), onSuccess: inv });
}

export function useSetTourStatus() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; status: "published" | "paused" | "archived"; reason?: string }) =>
      call("internal_tour_set_status", { p_id: v.id, p_status: v.status, p_reason: v.reason ?? null }),
    onSuccess: inv,
  });
}

export function useSaveNudge() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string | null; draft: NudgeDraft }) =>
      call<string>("internal_nudge_save", {
        p_id: v.id,
        p_key: v.draft.key,
        p_title: v.draft.title,
        p_body: v.draft.body ?? null,
        p_event: v.draft.event,
        p_audience: v.draft.audience,
        p_priority: v.draft.priority,
        p_cooldown_hours: v.draft.cooldown_hours,
        p_max_impressions: v.draft.max_impressions,
        p_starts_at: v.draft.starts_at || null,
        p_expires_at: v.draft.expires_at || null,
        p_cta_label: v.draft.cta_label || null,
        p_cta_href: v.draft.cta_href || null,
        p_support_fallback: v.draft.support_fallback,
      }),
    onSuccess: inv,
  });
}

export function useSetNudgeStatus() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; status: "published" | "paused" | "archived"; reason?: string }) =>
      call("internal_nudge_set_status", { p_id: v.id, p_status: v.status, p_reason: v.reason ?? null }),
    onSuccess: inv,
  });
}

export function useSaveNudgeSettings() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { per_session: number; per_day: number }) =>
      call("internal_nudge_settings_save", { p_per_session: v.per_session, p_per_day: v.per_day }),
    onSuccess: inv,
  });
}

export function useAssignCorrective() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { tenantId: string; kind: "tour" | "nudge"; refId: string; reason: string; role: string | null; days: number }) =>
      call<string>("internal_onboarding_assign", {
        p_tenant: v.tenantId,
        p_kind: v.kind,
        p_ref: v.refId,
        p_reason: v.reason,
        p_role: v.role,
        p_days: v.days,
      }),
    onSuccess: inv,
  });
}

export function useCancelAssignment() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      call("internal_onboarding_assignment_cancel", { p_id: v.id, p_reason: v.reason }),
    onSuccess: inv,
  });
}
