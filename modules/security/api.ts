import { createClient } from "@/lib/supabase/client";
import { normalizeSettings, type PinAction, type SecuritySettings } from "@/lib/security/pinPolicy";

// Seguridad, PIN de supervisor y auditoría (F17 · H116 + H117, ADR-051).
// Las RPC son nuevas y types/database.ts no se regenera: cliente "suelto"
// (mismo enfoque que modules/branches/api.ts). La base valida todo.
type RpcRes<T> = Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
interface Loose {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => RpcRes<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface PinStatus {
  can_have_pin: boolean;
  has_pin: boolean;
  set_at: string | null;
  expires_at: string | null;
  expired: boolean;
  locked_until: string | null;
}

export interface SupervisorRow {
  user_id: string;
  name: string;
  avatar: string | null;
  role: string;
  has_pin: boolean;
  pin_set_at: string | null;
  expired: boolean;
  locked: boolean;
}

export type AuthorizeResult =
  | { ok: true; token: string; expires_at: string }
  | { ok: false; error: string; attempts_left?: number; locked_until?: string };

export interface AuditRow {
  id: string;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  store_id: string | null;
  reason: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

export interface AuditFilters {
  from?: string | null;
  to?: string | null;
  actor?: string | null;
  store?: string | null;
  action?: string | null;
  entity?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}

export const securityApi = {
  settings: async (): Promise<SecuritySettings> => {
    const r = await loose().rpc<SecuritySettings>("security_settings_get");
    // Base sin la migración todavía: defaults (nada pide PIN).
    if (r.error) return normalizeSettings(null);
    return normalizeSettings(r.data);
  },
  saveSettings: async (patch: Partial<SecuritySettings>): Promise<SecuritySettings> =>
    normalizeSettings(check(await loose().rpc<SecuritySettings>("security_settings_save", { p: patch }))),

  pinStatus: async (): Promise<PinStatus | null> => {
    const r = await loose().rpc<PinStatus>("supervisor_pin_status");
    return r.error ? null : r.data;
  },
  setPin: async (pin: string): Promise<PinStatus> => check(await loose().rpc<PinStatus>("supervisor_set_pin", { p_pin: pin })),
  clearPin: async (userId?: string | null): Promise<void> => {
    check(await loose().rpc("supervisor_clear_pin", { p_user_id: userId ?? null }));
  },
  supervisors: async (): Promise<SupervisorRow[]> => {
    const r = await loose().rpc<SupervisorRow[]>("supervisor_list");
    return r.error ? [] : (r.data ?? []);
  },
  authorize: async (i: {
    action: PinAction;
    supervisorId: string;
    pin: string;
    amount: number | null;
    reason: string | null;
    ref?: string | null;
  }): Promise<AuthorizeResult> =>
    check(
      await loose().rpc<AuthorizeResult>("supervisor_authorize", {
        p_action: i.action,
        p_supervisor_id: i.supervisorId,
        p_pin: i.pin,
        p_amount: i.amount,
        p_reason: i.reason,
        p_ref: i.ref ?? null,
      }),
    ),

  auditSearch: async (f: AuditFilters): Promise<{ total: number; rows: AuditRow[] }> =>
    check(
      await loose().rpc<{ total: number; rows: AuditRow[] }>("audit_log_search", {
        p_from: f.from ?? null,
        p_to: f.to ?? null,
        p_actor: f.actor ?? null,
        p_store: f.store ?? null,
        p_action: f.action ?? null,
        p_entity: f.entity ?? null,
        p_q: f.q ?? null,
        p_limit: f.limit ?? 50,
        p_offset: f.offset ?? 0,
      }),
    ),
  auditFacets: async (): Promise<{ actions: string[]; entities: string[] }> => {
    const r = await loose().rpc<{ actions: string[] | null; entities: string[] | null }>("audit_log_facets");
    if (r.error || !r.data) return { actions: [], entities: [] };
    return { actions: r.data.actions ?? [], entities: r.data.entities ?? [] };
  },
};
