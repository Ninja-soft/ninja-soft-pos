// =============================================================================
// Operación de la plataforma desde el panel interno (F7, ADR-084): accesos como
// el negocio, miembros, ficha 360 y anuncios por segmento. Las RPC nuevas
// todavía no están en types/database.ts (regen pendiente al aplicar las
// migraciones 20261107100000 a 20261107100300): se llaman con un cast.
// =============================================================================
import { createClient } from "@/lib/supabase/client";
import { appOrigin } from "@/lib/site";
import type { MemberRole, MemberRow } from "@/supabase/functions/_shared/tenantMembers";
import { parseTenant360, type Tenant360 } from "@/lib/internal/tenant360";
import type { NotificationSeverity, NotificationType } from "@/modules/notifications/api";

type RpcResult = { data: unknown; error: { message: string } | null };
function rpc(fn: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
  const supabase = createClient();
  return (supabase as any).rpc(fn, args) as Promise<RpcResult>;
}

// Lee el código de error del cuerpo de una Edge (FunctionsHttpError).
async function invokeEdge<T extends { ok?: boolean; error?: string }>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(name, { body });
  const res = (data ?? null) as T | null;
  if (error || !res?.ok) {
    let code = res?.error ?? null;
    const ctx = (error as { context?: Response } | null)?.context;
    if (!code && ctx && typeof ctx.json === "function") {
      try {
        code = ((await ctx.json()) as { error?: string }).error ?? null;
      } catch {
        /* cuerpo no JSON */
      }
    }
    throw new Error(code ?? error?.message ?? `${name}_failed`);
  }
  return res;
}

export interface ImpersonationRow {
  id: string;
  staffEmail: string | null;
  targetEmail: string | null;
  reason: string;
  durationMinutes: number;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
}

export interface SegmentSendInput {
  segment: Record<string, unknown>;
  role: string | null;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
  requiresAck: boolean;
  expiresAt: string;
  displayUntil: string;
}

export const opsApi = {
  // ── Accesos como el negocio ───────────────────────────────────────────────
  listImpersonations: async (tenantId: string): Promise<ImpersonationRow[]> => {
    const supabase = createClient();
    const { data, error } = await (supabase as any)
      .from("impersonation_sessions")
      .select(
        "id, reason, duration_minutes, created_at, expires_at, claimed_at, ended_at, end_reason, staff:staff_user_id(email), target:target_user_id(email)",
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    type Row = {
      id: string;
      reason: string;
      duration_minutes: number;
      created_at: string;
      expires_at: string;
      claimed_at: string | null;
      ended_at: string | null;
      end_reason: string | null;
      staff: { email: string } | null;
      target: { email: string } | null;
    };
    return ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      staffEmail: r.staff?.email ?? null,
      targetEmail: r.target?.email ?? null,
      reason: r.reason,
      durationMinutes: r.duration_minutes,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      claimedAt: r.claimed_at,
      endedAt: r.ended_at,
      endReason: r.end_reason,
    }));
  },

  endImpersonation: async (id: string): Promise<void> => {
    const { error } = await rpc("internal_impersonation_end", { p_id: id });
    if (error) throw new Error(error.message);
  },

  // ── Miembros del negocio ──────────────────────────────────────────────────
  listMembers: async (tenantId: string): Promise<MemberRow[]> => {
    const { data, error } = await rpc("internal_tenant_members", { p_tenant: tenantId });
    if (error) throw new Error(error.message);
    return (data ?? []) as MemberRow[];
  },

  memberAdmin: async (vars: {
    tenantId: string;
    userId: string;
    action: "set_role" | "suspend" | "reactivate";
    role?: MemberRole | null;
    reason: string;
  }): Promise<void> => {
    const { error } = await rpc("internal_member_admin", {
      p_tenant: vars.tenantId,
      p_user: vars.userId,
      p_action: vars.action,
      p_role: vars.role ?? null,
      p_reason: vars.reason,
    });
    if (error) throw new Error(error.message);
  },

  inviteMember: async (vars: {
    tenantId: string;
    email: string;
    role: MemberRole;
    displayName: string;
    reason: string;
  }): Promise<{ invited: boolean }> => {
    const res = await invokeEdge<{ ok?: boolean; error?: string; invited?: boolean }>(
      "internal_tenant_members",
      {
        action: "invite",
        tenant_id: vars.tenantId,
        email: vars.email,
        role: vars.role,
        display_name: vars.displayName,
        reason: vars.reason,
        origin: appOrigin(),
      },
    );
    return { invited: Boolean(res.invited) };
  },

  memberEdgeAction: async (vars: {
    tenantId: string;
    userId: string;
    action: "resend_invite" | "reset_access";
    reason: string;
  }): Promise<{ emailSent: boolean }> => {
    const res = await invokeEdge<{ ok?: boolean; error?: string; email_sent?: boolean }>(
      "internal_tenant_members",
      {
        action: vars.action,
        tenant_id: vars.tenantId,
        user_id: vars.userId,
        reason: vars.reason,
        origin: appOrigin(),
      },
    );
    return { emailSent: res.email_sent !== false };
  },

  // ── Ficha 360 ─────────────────────────────────────────────────────────────
  tenant360: async (tenantId: string): Promise<Tenant360> => {
    const { data, error } = await rpc("internal_tenant_360", { p_tenant: tenantId });
    if (error) throw new Error(error.message);
    return parseTenant360(data);
  },

  // ── Anuncios por segmento ─────────────────────────────────────────────────
  notifySegment: async (input: SegmentSendInput): Promise<{ batchId: string; sent: number }> => {
    const { data, error } = await rpc("internal_notify_segment", {
      p_segment: input.segment,
      p_role: input.role,
      p_type: input.type,
      p_severity: input.severity,
      p_title: input.title,
      p_body: input.body || null,
      p_action_label: input.actionLabel || null,
      p_action_url: input.actionUrl || null,
      p_requires_ack: input.requiresAck,
      p_expires_at: input.expiresAt || null,
      p_display_until: input.displayUntil || null,
    });
    if (error) throw new Error(error.message);
    const d = (data ?? {}) as { batch_id?: string; sent?: number };
    return { batchId: d.batch_id ?? "", sent: Number(d.sent ?? 0) };
  },

  deleteNotificationBatch: async (batchId: string): Promise<number> => {
    const { data, error } = await rpc("internal_delete_notification_batch", { p_batch: batchId });
    if (error) throw new Error(error.message);
    return Number(data ?? 0);
  },
};
