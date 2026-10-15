import { createClient } from "@/lib/supabase/client";
import { getCurrentUser } from "@/lib/supabase/currentUser";
import { activeTenantIdOf } from "@/lib/tenant/scope";
import type { Tables } from "@/types/database";

export type NotificationRow = Tables<"notifications">;

export type NotificationSeverity =
  | "info"
  | "success"
  | "warning"
  | "critical"
  | "blocking";

export type NotificationType =
  | "news"
  | "plan"
  | "billing"
  | "usage"
  | "security"
  | "afip"
  | "maintenance"
  | "support"
  // Cobros en espera (ADR-048) y contracargos / devoluciones de MP (ADR-064):
  // los emite el sistema, no el composer interno.
  | "cobros"
  | "disputas"
  // Pedidos desde el catálogo público (ADR-130).
  | "pedidos";

/**
 * De dónde viene (ADR-152): `business` = del negocio activo (incluye las
 * personales, que siempre llevan negocio); `platform` = aviso de NinjaSoft
 * sin negocio (se ve igual en todos los negocios del usuario y se marca así).
 */
export type NotificationScope = "business" | "platform";

/** Notificación con el estado de lectura propio del usuario resuelto. */
export type Notification = NotificationRow & {
  read: boolean;
  archived: boolean;
  acked: boolean;
  scope: NotificationScope;
};

type ReadState = {
  read_at: string | null;
  archived_at: string | null;
  acked_at: string | null;
};

/**
 * Defensa en profundidad sobre la RLS: sólo quedan las del negocio activo y
 * las de plataforma. Una notificación de otro negocio del mismo usuario nunca
 * se muestra, aunque una policy o un cache la dejen pasar.
 */
export function scopeNotifications<T extends Pick<NotificationRow, "target_tenant_id">>(
  rows: T[],
  activeTenantId: string | null,
): (T & { scope: NotificationScope })[] {
  return rows
    .filter((n) => n.target_tenant_id === null || (activeTenantId !== null && n.target_tenant_id === activeTenantId))
    .map((n) => ({ ...n, scope: n.target_tenant_id === null ? "platform" : "business" }));
}

async function currentUserId(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No hay sesión activa");
  return user.id;
}

export const notificationsApi = {
  /**
   * Lista las notificaciones visibles para el usuario (la RLS las acota) junto
   * con su estado de lectura propio. notification_reads embebido devuelve 0..1
   * filas por RLS, así que mapeamos el primer elemento.
   */
  list: async (includeArchived = false): Promise<Notification[]> => {
    const supabase = createClient();
    const user = await getCurrentUser();
    if (!user) return [];
    // El estado de lectura embebido se pide SÓLO del usuario actual: la RLS de
    // notification_reads deja ver al staff (en /internal) las de todos.
    const { data, error } = await supabase
      .from("notifications")
      .select("*, notification_reads(read_at, archived_at, acked_at, user_id)")
      .eq("notification_reads.user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    const rows = (data ?? []) as unknown as (NotificationRow & {
      notification_reads: (ReadState & { user_id: string })[] | null;
    })[];

    const mapped: Notification[] = scopeNotifications(rows, activeTenantIdOf(user)).map((n) => {
      const r = n.notification_reads?.find((x) => x.user_id === user.id);
      const { notification_reads: _ignored, ...rest } = n;
      return {
        ...rest,
        read: !!r?.read_at,
        archived: !!r?.archived_at,
        acked: !!r?.acked_at,
      };
    });

    return includeArchived ? mapped : mapped.filter((n) => !n.archived);
  },

  markRead: async (notificationId: string): Promise<void> => {
    const supabase = createClient();
    const user_id = await currentUserId();
    const { error } = await supabase
      .from("notification_reads")
      .upsert(
        { notification_id: notificationId, user_id, read_at: new Date().toISOString() },
        { onConflict: "notification_id,user_id" },
      );
    if (error) throw error;
  },

  markAllRead: async (notificationIds: string[]): Promise<void> => {
    if (notificationIds.length === 0) return;
    const supabase = createClient();
    const user_id = await currentUserId();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("notification_reads")
      .upsert(
        notificationIds.map((notification_id) => ({
          notification_id,
          user_id,
          read_at: now,
        })),
        { onConflict: "notification_id,user_id" },
      );
    if (error) throw error;
  },

  archive: async (notificationId: string): Promise<void> => {
    const supabase = createClient();
    const user_id = await currentUserId();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("notification_reads")
      .upsert(
        { notification_id: notificationId, user_id, read_at: now, archived_at: now },
        { onConflict: "notification_id,user_id" },
      );
    if (error) throw error;
  },

  ack: async (notificationId: string): Promise<void> => {
    const supabase = createClient();
    const user_id = await currentUserId();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("notification_reads")
      .upsert(
        { notification_id: notificationId, user_id, read_at: now, acked_at: now },
        { onConflict: "notification_id,user_id" },
      );
    if (error) throw error;
  },
};
