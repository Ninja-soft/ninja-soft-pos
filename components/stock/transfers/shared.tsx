"use client";

import { AlarmClock, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import {
  DUE_LABEL,
  TRANSFER_STATUS_LABEL,
  TRANSFER_STATUS_TONE,
  dueState,
  localDate,
  type TransferStatus,
} from "@/lib/stock/transfers";
import type { StoreRef } from "@/lib/stock/byStore";

export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  return (
    <Badge tone={TRANSFER_STATUS_TONE[status]}>
      {TRANSFER_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Aviso de programación: "Para despachar hoy", "Atrasado" o la fecha. */
export function DueChip({
  scheduledFor,
  status,
}: {
  scheduledFor: string | null;
  status: TransferStatus;
}) {
  const due = dueState(scheduledFor, status, localDate());
  if (due === "none") return null;
  if (due === "future") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CalendarClock size={12} /> {fmtDate(scheduledFor)}
      </span>
    );
  }
  return (
    <Badge tone={due === "overdue" ? "danger" : "warning"}>
      <AlarmClock size={12} /> {DUE_LABEL[due]}
    </Badge>
  );
}

export function storeName(
  stores: StoreRef[],
  id: string | null | undefined,
): string {
  return stores.find((s) => s.id === id)?.name ?? "Sucursal";
}

/** Fecha (YYYY-MM-DD o ISO) en formato argentino, sin corrimiento por UTC. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

export const EVENT_LABEL: Record<string, string> = {
  created: "Creado",
  updated: "Editado",
  submitted: "Confirmado",
  approved: "Aprobado",
  rejected: "Devuelto a borrador",
  rescheduled: "Reprogramado",
  dispatched: "Despachado",
  partially_received: "Recepción parcial",
  received: "Recibido",
  cancelled: "Cancelado",
};
