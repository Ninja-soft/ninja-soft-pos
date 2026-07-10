"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Popover from "@radix-ui/react-popover";
import { Archive, Bell } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { formatRelative } from "@/lib/utils/format";
import {
  useNotificationActions,
  useNotifications,
  unreadCount,
} from "@/modules/notifications/hooks";
import type {
  Notification,
  NotificationSeverity,
  NotificationType,
} from "@/modules/notifications/api";

const SEVERITY_BORDER: Record<NotificationSeverity, string> = {
  info: "border-l-blue-500",
  success: "border-l-emerald-500",
  warning: "border-l-amber-500",
  critical: "border-l-red-500",
  blocking: "border-l-red-700",
};

const TYPE_LABELS: Record<NotificationType, string> = {
  news: "Novedad",
  plan: "Plan",
  billing: "Facturación",
  usage: "Uso",
  security: "Seguridad",
  afip: "AFIP",
  maintenance: "Mantenimiento",
  support: "Soporte",
};

function severityBorder(severity: string): string {
  return SEVERITY_BORDER[severity as NotificationSeverity] ?? "border-l-blue-500";
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type as NotificationType] ?? type;
}

function isExternal(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function NotificationItem({
  n,
  onRead,
  onArchive,
  onAck,
  onClose,
}: {
  n: Notification;
  onRead: (id: string) => void;
  onArchive: (id: string) => void;
  onAck: (id: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const needsAck = n.requires_ack && !n.acked;

  function handleAction() {
    onRead(n.id);
    if (!n.action_url) return;
    if (isExternal(n.action_url)) {
      window.open(n.action_url, "_blank", "noopener,noreferrer");
    } else {
      router.push(n.action_url as never);
    }
    onClose();
  }

  return (
    <div
      className={cn(
        "group relative border-l-2 px-3 py-2.5 transition hover:bg-muted/60",
        severityBorder(n.severity),
        !n.read && "bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => !n.read && onRead(n.id)}
        className="block w-full text-left"
      >
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 text-sm leading-snug text-foreground",
              !n.read && "font-semibold",
            )}
          >
            {n.title}
          </span>
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {typeLabel(n.type)}
          </span>
        </div>
        {n.body && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {n.body}
          </p>
        )}
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {formatRelative(n.created_at)}
        </span>
      </button>

      <div className="mt-2 flex items-center gap-2">
        {n.action_url && (
          <button
            type="button"
            onClick={handleAction}
            className="rounded-md bg-ninja-flame/15 px-2.5 py-1 text-xs font-medium text-ninja-flameSoft transition hover:bg-ninja-flame/25"
          >
            {n.action_label ?? "Ver"}
          </button>
        )}
        {needsAck && (
          <button
            type="button"
            onClick={() => onAck(n.id)}
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
          >
            Entendido
          </button>
        )}
        <button
          type="button"
          title="Archivar"
          aria-label="Archivar"
          onClick={() => onArchive(n.id)}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Archive size={14} />
          Archivar
        </button>
      </div>
    </div>
  );
}

export function NotificationBell({ floating = false }: { floating?: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: items } = useNotifications();
  const { markRead, markAllRead, archive, ack } = useNotificationActions();

  const unread = unreadCount(items);
  const badge = unread > 9 ? "9+" : String(unread);

  const unreadIds = useMemo(
    () => (items ?? []).filter((n) => !n.read).map((n) => n.id),
    [items],
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Notificaciones"
          className={cn(
            "relative grid place-items-center border border-border bg-card text-muted-foreground transition hover:bg-muted hover:text-foreground",
            floating
              ? "h-10 w-10 rounded-full shadow-ninjaSoft"
              : "h-9 w-9 rounded-lg",
          )}
        >
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-ninja-flame px-1 text-[10px] font-bold leading-[18px] text-white">
              {badge}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[380px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-ninjaSoft backdrop-blur-xl data-[state=open]:animate-fade-in"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold text-foreground">
              Notificaciones
            </span>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate(unreadIds)}
                className="text-xs font-medium text-ninja-flameSoft transition hover:underline"
              >
                Marcar todas leídas
              </button>
            )}
          </div>

          <div className="slim-scrollbar max-h-96 divide-y divide-border overflow-y-auto">
            {(items ?? []).length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Sin notificaciones
              </p>
            ) : (
              (items ?? []).map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  onRead={(id) => markRead.mutate(id)}
                  onArchive={(id) => archive.mutate(id)}
                  onAck={(id) => ack.mutate(id)}
                  onClose={() => setOpen(false)}
                />
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Banner para notificaciones bloqueantes no reconocidas. Se renderiza arriba del
 * contenido del shell. Devuelve null cuando no hay nada bloqueante pendiente.
 */
export function BlockingNotificationBanner() {
  const { data: items } = useNotifications();
  const { ack } = useNotificationActions();

  const blocking = (items ?? []).find(
    (n) => n.severity === "blocking" && !n.acked,
  );
  if (!blocking) return null;

  return (
    <div className="flex items-center gap-3 border-b border-red-700/40 bg-red-700/15 px-4 py-2.5 text-sm text-foreground">
      <Bell size={16} className="shrink-0 text-danger" />
      <span className="min-w-0 flex-1 font-medium">{blocking.title}</span>
      <button
        type="button"
        onClick={() => ack.mutate(blocking.id)}
        className="shrink-0 rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-red-600"
      >
        Entendido
      </button>
    </div>
  );
}
