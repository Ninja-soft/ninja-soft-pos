import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import type { StatusDetail, StatusEvent, StatusEventKind } from "@/lib/staff/status";

// Personal: estados, historial y reingreso (F17 · H113, ADR-051). RPC nuevas
// sin tipos generados: cliente "suelto". La base valida todo y audita.
type RpcRes<T> = Promise<{ data: T | null; error: { message: string } | null }>;
interface Q<T> extends PromiseLike<{ data: T | null; error: { message: string } | null }> {
  select: (cols: string) => Q<T>;
  eq: (col: string, v: unknown) => Q<T>;
  order: (col: string, opts?: { ascending?: boolean }) => Q<T>;
}
interface Loose {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => RpcRes<T>;
  from: <T = unknown>(table: string) => Q<T>;
}
const loose = () => createClient() as unknown as Loose;

function check<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export interface StaffPersonRow {
  kind: "user" | "profile";
  user_id: string | null;
  profile_id: string | null;
  name: string;
  email: string | null;
  avatar: string | null;
  role: "owner" | "manager" | "cashier" | "viewer" | null;
  membership_status: string;
  joined_at: string | null;
  state: StatusDetail;
}

export interface StatusEventRow extends StatusEvent {
  user_id: string | null;
  cashier_profile_id: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
}

export interface SetStatusInput {
  userId: string | null;
  profileId: string | null;
  kind: Exclude<StatusEventKind, "rehire">;
  subtype?: string | null;
  from?: string | null;
  until?: string | null;
  reason?: string | null;
  notes?: string | null;
}

export const staffApi = {
  people: async (): Promise<StaffPersonRow[]> => {
    const r = await loose().rpc<StaffPersonRow[]>("staff_people");
    if (!r.error) return r.data ?? [];
    // Base sin la migración de ADR-051 (deploy: front primero): miembros y
    // perfiles como antes, todos activos.
    const tenantId = await getCurrentTenantId();
    const sb = createClient();
    const [members, profiles] = await Promise.all([
      sb.rpc("tenant_members"),
      tenantId
        ? sb.from("cashier_profiles").select("id, display_name, avatar, status, created_at").eq("tenant_id", tenantId).is("deleted_at", null)
        : Promise.resolve({ data: [] as never[] }),
    ]);
    const out: StaffPersonRow[] = [];
    for (const m of (members.data ?? []) as {
      user_id: string; email: string | null; full_name: string | null; display_name: string | null;
      role: StaffPersonRow["role"]; status: string; avatar: string | null; joined_at: string | null;
    }[]) {
      out.push({
        kind: "user", user_id: m.user_id, profile_id: null,
        name: m.display_name || m.full_name || m.email || "Miembro", email: m.email, avatar: m.avatar,
        role: m.role, membership_status: m.status, joined_at: m.joined_at, state: { status: "active" },
      });
    }
    for (const p of (profiles.data ?? []) as { id: string; display_name: string; avatar: string | null; status: string; created_at: string }[]) {
      out.push({
        kind: "profile", user_id: null, profile_id: p.id, name: p.display_name, email: null, avatar: p.avatar,
        role: null, membership_status: p.status, joined_at: p.created_at, state: { status: "active" },
      });
    }
    return out;
  },
  events: async (): Promise<StatusEventRow[]> => {
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    const r = await loose()
      .from<StatusEventRow[]>("staff_status_events")
      .select(
        "id, user_id, cashier_profile_id, kind, subtype, starts_on, ends_on, reason, notes, deleted_at, created_at, created_by, ended_at, cancel_reason",
      )
      .eq("tenant_id", tenantId)
      .order("starts_on", { ascending: false });
    if (r.error) return [];
    return r.data ?? [];
  },
  setStatus: async (i: SetStatusInput): Promise<string> =>
    check(
      await loose().rpc<string>("staff_set_status", {
        p_user: i.userId,
        p_profile: i.profileId,
        p_kind: i.kind,
        p_subtype: i.subtype ?? null,
        p_from: i.from ?? null,
        p_until: i.until ?? null,
        p_reason: i.reason ?? null,
        p_notes: i.notes ?? null,
      }),
    ),
  endStatus: async (eventId: string, reason: string | null): Promise<"cancelled" | "ended"> =>
    check(await loose().rpc<"cancelled" | "ended">("staff_end_status", { p_event_id: eventId, p_reason: reason })),
  rehire: async (i: {
    userId: string | null;
    profileId: string | null;
    role?: string | null;
    storeId?: string | null;
    reason?: string | null;
  }): Promise<string> =>
    check(
      await loose().rpc<string>("staff_rehire", {
        p_user: i.userId,
        p_profile: i.profileId,
        p_role: i.role ?? null,
        p_store_id: i.storeId ?? null,
        p_reason: i.reason ?? null,
      }),
    ),
  myStatus: async (): Promise<StatusDetail> => {
    const r = await loose().rpc<StatusDetail>("my_staff_status");
    // Base sin la migración: activo (no bloquea a nadie).
    return r.error || !r.data ? { status: "active" } : r.data;
  },
  ensureCurrentTenant: async (): Promise<boolean> => {
    const r = await loose().rpc<boolean>("ensure_current_tenant");
    return !r.error && r.data === true;
  },
};
