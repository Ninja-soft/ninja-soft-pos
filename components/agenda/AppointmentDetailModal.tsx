"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  Pencil,
  Play,
  Receipt,
  User,
  UserX,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useAppointmentMutations } from "@/modules/agenda/hooks";
import {
  STATUS_LABELS,
  STATUS_BADGE,
  isChargeable,
  type Appointment,
  type AppointmentStatus,
} from "@/modules/agenda/api";
import { formatCurrency } from "@/lib/utils/format";
import { formatDayLong, hhmm } from "@/modules/agenda/dates";

// Detalle de un turno: datos, cambio de estado, reprogramar (abre el editor),
// cancelar (con motivo) y COBRAR (lleva al POS con el servicio cargado · H38).
export function AppointmentDetailModal({
  appointment,
  professionalName,
  onClose,
  onEdit,
}: {
  appointment: Appointment | null;
  professionalName: string | null;
  onClose: () => void;
  onEdit: (a: Appointment) => void;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const { setStatus } = useAppointmentMutations();
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  if (!appointment) return null;
  const a = appointment;
  const start = new Date(a.starts_at);

  async function changeStatus(status: AppointmentStatus) {
    try {
      await setStatus.mutateAsync({ id: a.id, status });
      toast({ title: `Turno: ${STATUS_LABELS[status]}`, variant: "success" });
      if (status === "cancelado") setCancelling(false);
    } catch (e) {
      toast({
        title: "No se pudo cambiar el estado",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    }
  }

  async function confirmCancel() {
    try {
      await setStatus.mutateAsync({
        id: a.id,
        status: "cancelado",
        cancelReason: cancelReason.trim() || null,
      });
      toast({ title: "Turno cancelado", variant: "success" });
      setCancelling(false);
      setCancelReason("");
      onClose();
    } catch {
      toast({ title: "No se pudo cancelar", variant: "error" });
    }
  }

  // Cobrar: lleva al POS con ?appointment=<id>. El POS carga el servicio en el
  // carrito, permite agregar productos extra y, al cobrar, enlaza la venta al
  // turno (link_appointment_sale → 'realizado'). No duplica el flujo de cobro.
  function charge() {
    router.push(`/pos?appointment=${a.id}`);
  }

  const pct = a.commission_pct;
  const commissionAmount =
    pct != null ? (a.service_price * pct) / 100 : null;

  return (
    <Modal
      open={appointment !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Turno"
    >
      <div className="space-y-4">
        {/* Encabezado: servicio + estado */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold">{a.service_name}</h3>
            <p className="font-price text-2xl font-black tabular-nums text-foreground">
              {formatCurrency(a.service_price)}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_BADGE[a.status]}`}
          >
            {STATUS_LABELS[a.status]}
          </span>
        </div>

        {/* Datos */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CalendarClock size={15} className="shrink-0" />
            <span className="capitalize text-foreground">{formatDayLong(start)}</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock size={15} className="shrink-0" />
            <span className="text-foreground">
              {hhmm(start)} · {a.duration_min} min
            </span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <User size={15} className="shrink-0" />
            <span className="text-foreground">
              {professionalName ?? "Sin profesional"}
              {a.customers?.name ? ` · Cliente: ${a.customers.name}` : ""}
            </span>
          </div>
          {commissionAmount != null && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Banknote size={15} className="shrink-0" />
              <span className="text-foreground">
                Comisión {pct}% = {formatCurrency(commissionAmount)}
              </span>
            </div>
          )}
          {a.is_walk_in && (
            <span className="inline-block rounded bg-ninja-flame/15 px-2 py-0.5 text-xs font-semibold text-ninja-flameSoft">
              Walk-in
            </span>
          )}
          {a.sale_id && a.sales?.number != null && (
            <div className="flex items-center gap-2 text-emerald-300">
              <Receipt size={15} className="shrink-0" />
              <span>Cobrado · Venta #{a.sales.number}</span>
            </div>
          )}
          {a.notes && (
            <p className="border-t border-border pt-2 text-muted-foreground">{a.notes}</p>
          )}
          {a.status === "cancelado" && a.cancel_reason && (
            <p className="border-t border-border pt-2 text-red-300">
              Motivo: {a.cancel_reason}
            </p>
          )}
        </div>

        {/* Cancelación con motivo (paso intermedio) */}
        {cancelling ? (
          <div className="space-y-3 rounded-lg border border-red-400/30 bg-red-400/5 p-3">
            <Input
              label="Motivo de la cancelación (opcional)"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="No vino / reprogramó / otro"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCancelling(false)}>
                Volver
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={confirmCancel}
                loading={setStatus.isPending}
              >
                Cancelar turno
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Cobrar (destacado) cuando el turno es cobrable */}
            {isChargeable(a) && (
              <Button className="w-full" onClick={charge}>
                <Banknote size={16} /> Cobrar este turno
              </Button>
            )}

            {/* Acciones de estado (las que aplican según el estado actual) */}
            <div className="grid grid-cols-2 gap-2">
              {(a.status === "reservado") && (
                <Button variant="secondary" size="sm" onClick={() => changeStatus("confirmado")}>
                  <CheckCircle2 size={15} /> Confirmar
                </Button>
              )}
              {(a.status === "reservado" || a.status === "confirmado") && (
                <Button variant="secondary" size="sm" onClick={() => changeStatus("en_curso")}>
                  <Play size={15} /> Iniciar
                </Button>
              )}
              {a.status !== "realizado" && a.status !== "cancelado" && (
                <Button variant="secondary" size="sm" onClick={() => changeStatus("realizado")}>
                  <CheckCircle2 size={15} /> Marcar realizado
                </Button>
              )}
              {(a.status === "reservado" || a.status === "confirmado") && (
                <Button variant="secondary" size="sm" onClick={() => changeStatus("no_show")}>
                  <UserX size={15} /> No vino
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => onEdit(a)}>
                <Pencil size={15} /> Reprogramar / editar
              </Button>
              {a.status !== "cancelado" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setCancelling(true)}
                >
                  <CircleSlash size={15} /> Cancelar
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
