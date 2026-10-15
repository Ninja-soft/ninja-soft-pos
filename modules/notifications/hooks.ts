"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notificationsApi, type Notification } from "./api";
import { useActiveTenantId } from "@/lib/tenant/useActiveTenantId";

const KEY = ["notifications"] as const;

// La key lleva el negocio activo (ADR-152): con otro negocio es otra entrada
// de caché, nunca la lista del anterior. Las mutaciones invalidan por prefijo.
export function useNotifications() {
  const tenantId = useActiveTenantId();
  return useQuery({
    queryKey: [...KEY, tenantId ?? "none"],
    enabled: tenantId !== undefined,
    queryFn: () => notificationsApi.list(false),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useNotificationActions() {
  const qc = useQueryClient();
  const inv = () => qc.invalidateQueries({ queryKey: KEY });

  return {
    markRead: useMutation({
      mutationFn: (id: string) => notificationsApi.markRead(id),
      onSuccess: inv,
    }),
    markAllRead: useMutation({
      mutationFn: (ids: string[]) => notificationsApi.markAllRead(ids),
      onSuccess: inv,
    }),
    archive: useMutation({
      mutationFn: (id: string) => notificationsApi.archive(id),
      onSuccess: inv,
    }),
    ack: useMutation({
      mutationFn: (id: string) => notificationsApi.ack(id),
      onSuccess: inv,
    }),
  };
}

/** Cantidad de notificaciones no leídas en la lista dada. */
export function unreadCount(items: Notification[] | undefined): number {
  return (items ?? []).filter((n) => !n.read).length;
}
