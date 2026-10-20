"use client";

// Alertas programadas (F24 · H162, ADR-176). RPC con gating y permisos en el
// servidor (alert_assert): configurar = dueño o config.edit; historial =
// reports.view.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { AlertFrequency, AlertKind, AlertRole } from "@/lib/alerts/catalog";

export interface AlertItem {
  key: string;
  title: string;
  detail?: string;
  amount?: number | null;
  url?: string;
  /** Sólo en el historial: si era un caso nuevo en esa corrida. */
  new?: boolean;
}

export interface AlertLastEvent {
  id: string;
  ran_at: string;
  hits: number;
  new_hits: number;
  error: string | null;
  email_status: AlertEmailStatus;
}

export type AlertEmailStatus = "none" | "pending" | "sent" | "failed" | "skipped";

export interface AlertRule {
  id: string;
  kind: AlertKind;
  enabled: boolean;
  params: Record<string, number>;
  frequency: AlertFrequency;
  hour: number;
  weekdays: number[];
  store_id: string | null;
  channels: { bell?: boolean; email?: boolean };
  audience_roles: AlertRole[];
  audience_user_ids: string[];
  only_new: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_hits: number | null;
  last_error: string | null;
  last_event?: AlertLastEvent | null;
}

export interface AlertsOverview {
  can_edit: boolean;
  rules: AlertRule[];
  stores: { id: string; name: string }[];
  members: { user_id: string; name: string; role: AlertRole }[];
}

export interface AlertRuleInput {
  id?: string | null;
  kind: AlertKind;
  enabled: boolean;
  params: Record<string, number>;
  frequency: AlertFrequency;
  hour: number;
  weekdays: number[];
  store_id: string | null;
  channels: { bell: boolean; email: boolean };
  audience_roles: AlertRole[];
  audience_user_ids: string[];
  only_new: boolean;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  kind: AlertKind;
  ran_at: string;
  hits: number;
  new_hits: number;
  items: AlertItem[];
  notified: boolean;
  email_status: AlertEmailStatus;
  email_error: string | null;
  error: string | null;
  store_name: string | null;
  only_new: boolean;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw error;
  return data as T;
}

export const alertsApi = {
  overview: async (): Promise<AlertsOverview> => {
    const d = await rpc<AlertsOverview & { catalog?: unknown }>("alert_rules_list");
    return {
      can_edit: Boolean(d?.can_edit),
      rules: (d?.rules ?? []).map((r) => ({
        ...r,
        weekdays: r.weekdays ?? [],
        audience_roles: r.audience_roles ?? [],
        audience_user_ids: r.audience_user_ids ?? [],
        channels: r.channels ?? {},
      })),
      stores: d?.stores ?? [],
      members: d?.members ?? [],
    };
  },
  save: (input: AlertRuleInput) => rpc<AlertRule>("alert_rule_save", { p: input }),
  remove: (id: string) => rpc<void>("alert_rule_delete", { p_id: id }),
  test: (kind: AlertKind, params: Record<string, number>, storeId: string | null) =>
    rpc<{ hits: number; items: AlertItem[] }>("alert_rule_test", { p_kind: kind, p_params: params, p_store: storeId }),
  events: (opts: { ruleId?: string | null; eventId?: string | null; before?: string | null; limit?: number }) =>
    rpc<AlertEvent[]>("alert_events_list", {
      p_rule: opts.ruleId ?? null,
      p_limit: opts.limit ?? 30,
      p_before: opts.before ?? null,
      p_event: opts.eventId ?? null,
    }),
};

const KEY = ["alerts"] as const;

export function useAlertsOverview(enabled = true) {
  return useQuery({ queryKey: [...KEY, "overview"], queryFn: alertsApi.overview, enabled, staleTime: 15_000, retry: 1 });
}

export function useAlertEvents(
  opts: { ruleId?: string | null; eventId?: string | null; before?: string | null },
  enabled = true,
) {
  return useQuery({
    queryKey: [...KEY, "events", opts.ruleId ?? null, opts.eventId ?? null, opts.before ?? null],
    queryFn: () => alertsApi.events(opts),
    enabled,
    retry: 1,
  });
}

export function useAlertMutations() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    save: useMutation({ mutationFn: alertsApi.save, onSuccess: inv }),
    remove: useMutation({ mutationFn: alertsApi.remove, onSuccess: inv }),
    test: useMutation({
      mutationFn: (v: { kind: AlertKind; params: Record<string, number>; storeId: string | null }) =>
        alertsApi.test(v.kind, v.params, v.storeId),
    }),
  };
}
