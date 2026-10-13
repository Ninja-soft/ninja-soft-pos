"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bike, Check, Clock, ExternalLink, FileCheck2, MapPin, Phone, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { localActions } from "@/supabase/functions/_shared/deliveryChannels/stateMachine";
import {
  BILLING_LABELS,
  CHANNEL_LABELS,
  EXTERNAL_STATUS_LABELS,
  channelErrorMessage,
  type ChannelOrder,
} from "@/modules/deliveryChannels/api";
import { useChannelMutations } from "@/modules/deliveryChannels/hooks";

const STATUS_TONE: Record<ChannelOrder["external_status"], BadgeTone> = {
  nuevo: "warning",
  aceptado: "info",
  listo: "success",
  retirado: "brand",
  entregado: "success",
  rechazado: "neutral",
  cancelado: "danger",
};

const hhmm = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "";

/** Minutos que faltan (negativo = pasado). Se re-renderiza cada 15 s. */
function useMinutesTo(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - now) / 60_000);
}

/** Etiqueta del canal: marca + código que ve el repartidor. */
export function ChannelBadge({ order }: { order: ChannelOrder }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-ninja-flame/15 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ninja-flameSoft">
      {CHANNEL_LABELS[order.brand]}
      {order.external_display_code ? ` #${order.external_display_code}` : ""}
      {order.provider === "simulador" ? " · sim" : ""}
    </span>
  );
}

/** Estado en la app, tiempos y repartidor en la tarjeta del tablero. */
export function ChannelOrderInfo({ order }: { order: ChannelOrder }) {
  const deadline = useMinutesTo(order.external_status === "nuevo" ? order.accept_deadline_at : null);
  const readyAt =
    order.accepted_at && order.prep_minutes
      ? new Date(new Date(order.accepted_at).getTime() + order.prep_minutes * 60_000).toISOString()
      : null;
  const toReady = useMinutesTo(order.external_status === "aceptado" ? readyAt : null);
  const eta = useMinutesTo(order.courier_eta_at && !["entregado", "cancelado"].includes(order.external_status) ? order.courier_eta_at : null);
  const mapUrl =
    order.tracking_url ??
    (order.courier_lat != null && order.courier_lng != null
      ? `https://www.google.com/maps?q=${order.courier_lat},${order.courier_lng}`
      : null);

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={STATUS_TONE[order.external_status]}>{EXTERNAL_STATUS_LABELS[order.external_status]}</Badge>
        {order.billing_status !== "pendiente" && (
          <Badge tone={order.billing_status === "facturado" ? "success" : order.billing_status === "error" ? "danger" : "neutral"}>
            {BILLING_LABELS[order.billing_status]}
          </Badge>
        )}
        {order.needs_review && <Badge tone="warning">Revisar ítems</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1">
          <Clock size={11} /> Entró {hhmm(order.placed_at)}
        </span>
        {deadline !== null && (
          <span className={deadline <= 1 ? "font-semibold text-danger" : "font-semibold text-warning"}>
            {deadline > 0 ? `Aceptar en ${deadline} min` : "Vence la aceptación"}
          </span>
        )}
        {toReady !== null && <span>{toReady > 0 ? `Listo en ${toReady} min` : "Debería estar listo"}</span>}
        {order.picked_up_at && <span>Retirado {hhmm(order.picked_up_at)}</span>}
      </div>
      {order.courier_name && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-foreground">
          <span className="inline-flex items-center gap-1">
            <Bike size={11} /> {order.courier_name}
          </span>
          {order.courier_phone && (
            <a href={`tel:${order.courier_phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <Phone size={11} /> {order.courier_phone}
            </a>
          )}
          {eta !== null && <span className="font-semibold">{eta > 0 ? `Llega en ${eta} min` : "Llegando"}</span>}
          {mapUrl && (
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-info hover:underline"
            >
              <MapPin size={11} /> Ver en el mapa <ExternalLink size={10} />
            </a>
          )}
        </div>
      )}
      {order.cancel_reason && order.external_status === "cancelado" && <p className="text-danger">{order.cancel_reason}</p>}
      {order.sync_error && (
        <p className="inline-flex items-center gap-1 text-warning">
          <AlertTriangle size={11} /> {order.sync_error}
        </p>
      )}
      {order.billing_error && order.billing_status === "error" && (
        <p className="inline-flex items-center gap-1 text-danger">
          <AlertTriangle size={11} /> {channelErrorMessage(order.billing_error)}
        </p>
      )}
    </div>
  );
}

/** Botones del local según el estado (aceptar con tiempo, rechazar, listo, retirado, facturar). */
export function ChannelOrderActions({ order, canManage }: { order: ChannelOrder; canManage: boolean }) {
  const { toast } = useToast();
  const m = useChannelMutations();
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [prep, setPrep] = useState(String(order.prep_minutes ?? 20));
  const actions = localActions(order.external_status);
  const busy =
    m.accept.isPending || m.reject.isPending || m.ready.isPending || m.pickedUp.isPending || m.delivered.isPending || m.bill.isPending;
  const fail = (title: string) => (e: unknown) => toast({ title, description: channelErrorMessage(e), variant: "error" });
  const billed = (r: { billing_error?: string | null } | unknown) => {
    const err = (r as { billing_error?: string | null } | null)?.billing_error;
    if (err) toast({ title: "Quedó a facturar", description: channelErrorMessage(err), variant: "warning" });
  };
  const canBill =
    ["pendiente", "error"].includes(order.billing_status) &&
    !order.sale_id &&
    ["aceptado", "listo", "retirado", "entregado"].includes(order.external_status);
  const finished = ["retirado", "entregado"].includes(order.external_status);

  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {actions.includes("accept") && (
        <Button size="sm" className="flex-1" disabled={busy} onClick={() => setAcceptOpen(true)}>
          <Check size={14} /> Aceptar
        </Button>
      )}
      {actions.includes("reject") && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejectOpen(true)}>
          <X size={14} /> Rechazar
        </Button>
      )}
      {actions.includes("ready") && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => m.ready.mutate(order.id, { onError: fail("No se pudo marcar listo") })}>
          Listo
        </Button>
      )}
      {actions.includes("picked_up") && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => m.pickedUp.mutate(order.id, { onSuccess: billed, onError: fail("No se pudo marcar retirado") })}
        >
          Retirado
        </Button>
      )}
      {actions.includes("delivered") && order.logistics === "propia" && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => m.delivered.mutate(order.id, { onSuccess: billed, onError: fail("No se pudo marcar entregado") })}
        >
          Entregado
        </Button>
      )}
      {canBill && (
        <Button
          size="sm"
          variant={finished ? "primary" : "secondary"}
          disabled={busy}
          onClick={() =>
            m.bill.mutate(order.id, {
              onSuccess: (r) => toast({ title: `Facturado: venta #${r.number}`, variant: "success" }),
              onError: fail("No se pudo facturar"),
            })
          }
        >
          <FileCheck2 size={14} /> Facturar
        </Button>
      )}
      {canBill && finished && canManage && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCloseOpen(true)}>
          Cerrar sin factura
        </Button>
      )}

      <Modal
        open={acceptOpen}
        onOpenChange={setAcceptOpen}
        title={`Aceptar pedido de ${CHANNEL_LABELS[order.brand]}`}
        description="La comanda sale a cocina y se le avisa a la app con el tiempo de preparación."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAcceptOpen(false)}>
              Cancelar
            </Button>
            <Button
              loading={m.accept.isPending}
              disabled={!prep || Number(prep) < 1 || Number(prep) > 180}
              onClick={() =>
                m.accept.mutate(
                  { id: order.id, prep: Number(prep) },
                  { onSuccess: () => setAcceptOpen(false), onError: fail("No se pudo aceptar") },
                )
              }
            >
              Aceptar
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {[10, 15, 20, 30, 45].map((n) => (
              <Button key={n} size="sm" variant={Number(prep) === n ? "primary" : "secondary"} onClick={() => setPrep(String(n))}>
                {n} min
              </Button>
            ))}
          </div>
          <Input
            label="Tiempo de preparación (min)"
            inputMode="numeric"
            value={prep}
            onChange={(e) => setPrep(e.target.value.replace(/\D/g, "").slice(0, 3))}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title="Rechazar el pedido"
        description="Se le avisa a la app con el motivo. Rechazá sólo si no lo podés preparar: las apps penalizan los rechazos."
        confirmLabel="Rechazar"
        danger
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Sin stock, cocina saturada..."
        loading={m.reject.isPending}
        onConfirm={(reason) =>
          m.reject.mutate(
            { id: order.id, reason },
            { onSuccess: () => setRejectOpen(false), onError: fail("No se pudo rechazar") },
          )
        }
      />
      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title="Cerrar sin factura"
        description="El pedido se da por entregado sin emitir comprobante (por ejemplo, si la app emite la factura). Queda auditado."
        confirmLabel="Cerrar sin factura"
        withReason
        reasonLabel="Motivo"
        loading={m.closeUnbilled.isPending}
        onConfirm={(reason) =>
          m.closeUnbilled.mutate(
            { id: order.id, reason },
            { onSuccess: () => setCloseOpen(false), onError: fail("No se pudo cerrar") },
          )
        }
      />
    </div>
  );
}
