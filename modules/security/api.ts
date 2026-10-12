import { createClient } from "@/lib/supabase/client";
import { normalizeSettings, type PinAction, type SecuritySettings } from "@/lib/security/pinPolicy";
import type { PinMode } from "@/lib/security/otp";

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
  /** Tiene algún modo listo para autorizar (ADR-060). */
  has_pin: boolean;
  has_fixed?: boolean;
  methods?: PinMode[];
  pin_set_at: string | null;
  expired: boolean;
  locked: boolean;
}

export type AuthorizeResult =
  | { ok: true; token: string; expires_at: string; mode?: PinMode }
  | { ok: false; error: string; attempts_left?: number; locked_until?: string; modes?: PinMode[] };

// PIN autenticador (ADR-060). Los secretos nunca llegan: sólo el código vigente
// del propio supervisor y, al enrolar la app, el secreto en base32 una vez.
export interface MyPins {
  can_have_pin: boolean;
  feature: boolean;
  modes: PinMode[];
  default_mode: PinMode;
  rotation_hours: number;
  one_time_max_minutes: number;
  locked_until: string | null;
  fixed: { has_pin: boolean; set_at: string | null; expires_at: string | null; expired: boolean };
  rotating: { enabled: boolean; set_at: string | null };
  totp: { enabled: boolean; step: number | null; confirmed_at: string | null; pending: boolean };
  one_time_active: number;
}

export interface RotatingCode {
  code: string;
  period_hours: number;
  valid_from: string;
  valid_until: string;
  server_time: string;
}

export interface TotpEnrollment {
  secret_base32: string;
  step: number;
  account: string;
  digits: number;
  algorithm: string;
}

export interface OneTimeCreated {
  id: string;
  code: string;
  expires_at: string;
  action: PinAction | null;
  max_amount: number | null;
  note: string | null;
}

export interface OneTimeRow {
  id: string;
  action: PinAction | null;
  max_amount: number | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_action: PinAction | null;
  used_amount: number | null;
  used_by_name: string | null;
  revoked_at: string | null;
}

export interface AuthHistoryRow {
  id: string;
  created_at: string;
  event: "supervisor_authorized" | "supervisor_pin_failed" | "supervisor_pin_locked";
  pin_action: PinAction | null;
  amount: number | null;
  auth_mode: PinMode | null;
  reason: string | null;
  requested_by_name: string | null;
}

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

  // ── Mis PINes (ADR-060) ────────────────────────────────────────────────────
  myPins: async (): Promise<MyPins | null> => {
    const r = await loose().rpc<MyPins>("supervisor_my_pins");
    // Base sin la migración: la sección no se muestra.
    return r.error ? null : r.data;
  },
  rotatingEnable: async (regenerate = false): Promise<MyPins> =>
    check(await loose().rpc<MyPins>("supervisor_rotating_enable", { p_regenerate: regenerate })),
  rotatingDisable: async (): Promise<MyPins> => check(await loose().rpc<MyPins>("supervisor_rotating_disable")),
  rotatingCode: async (): Promise<RotatingCode> => check(await loose().rpc<RotatingCode>("supervisor_rotating_code")),
  totpBegin: async (step: 30 | 60): Promise<TotpEnrollment> =>
    check(await loose().rpc<TotpEnrollment>("supervisor_totp_begin", { p_step: step })),
  totpConfirm: async (code: string): Promise<MyPins> =>
    check(await loose().rpc<MyPins>("supervisor_totp_confirm", { p_code: code })),
  totpDisable: async (): Promise<MyPins> => check(await loose().rpc<MyPins>("supervisor_totp_disable")),
  oneTimeCreate: async (i: {
    minutes: number;
    action?: PinAction | null;
    maxAmount?: number | null;
    note?: string | null;
  }): Promise<OneTimeCreated> =>
    check(
      await loose().rpc<OneTimeCreated>("supervisor_one_time_create", {
        p_minutes: i.minutes,
        p_action: i.action ?? null,
        p_max_amount: i.maxAmount ?? null,
        p_note: i.note ?? null,
      }),
    ),
  oneTimeRevoke: async (id: string): Promise<void> => {
    check(await loose().rpc("supervisor_one_time_revoke", { p_id: id }));
  },
  oneTimeList: async (): Promise<OneTimeRow[]> => {
    const r = await loose().rpc<OneTimeRow[]>("supervisor_one_time_list", { p_limit: 30 });
    return r.error ? [] : (r.data ?? []);
  },
  myHistory: async (): Promise<AuthHistoryRow[]> => {
    const r = await loose().rpc<AuthHistoryRow[]>("supervisor_my_history", { p_limit: 30 });
    return r.error ? [] : (r.data ?? []);
  },
  unlock: async (userId: string): Promise<void> => {
    check(await loose().rpc("supervisor_unlock", { p_user_id: userId }));
  },
  resetMethods: async (userId?: string | null): Promise<void> => {
    check(await loose().rpc("supervisor_methods_reset", { p_user_id: userId ?? null }));
  },

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
