"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notificationsApi, type Notification } from "./api";

const KEY = ["notifications"] as const;

export function useNotifications() {
  return useQuery({
    queryKey: KEY,
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
