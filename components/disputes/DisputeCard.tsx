"use client";

// Contracargo, reclamo o devolución de Mercado Pago (ADR-064): estado, monto,
// motivo, plazo para presentar la documentación y línea de tiempo. Lo usan la
// conciliación de procesadores y la pestaña Cobros del detalle de la venta.

import { AlertTriangle, CalendarClock, Check } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import {
  DISPUTE_KIND_LABEL,
  DISPUTE_STATUS_LABEL,
  deadlineInfo,
  disputeReasonLabel,
  disputeTimeline,
  docStatusLabel,
  type PaymentDisputeRow,
  type Tone,
} from "@/lib/reports/paymentDisputes";
import { useAckDispute } from "@/modules/reports/paymentDisputes";

const BADGE: Record<Tone, BadgeTone> = { success: "success", warning: "warning", danger: "danger", neutral: "neutral" };
const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted-foreground/50",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const longDay = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });

export function DisputeCard({ d, canAck = true, compact = false }: { d: PaymentDisputeRow; canAck?: boolean; compact?: boolean }) {
  const { toast } = useToast();
  const ack = useAckDispute();
  const st = DISPUTE_STATUS_LABEL[d.status];
  const dl = deadlineInfo(d);
  const reason = disputeReasonLabel(d.reason);
  const doc = d.kind === "chargeback" ? docStatusLabel(d.documentation_status) : null;
  const timeline = disputeTimeline(d);

  async function onAck() {
    try {
      await ack.mutateAsync(d.id);
      toast({ title: "Marcado como visto", variant: "success" });
    } catch {
      toast({ title: "No se pudo marcar", variant: "error" });
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{DISPUTE_KIND_LABEL[d.kind]}</span>
          <Badge tone={BADGE[st.tone]}>{st.label}</Badge>
          {d.kind === "refund" && d.origin === "pos" && <Badge tone="neutral">Registrada en el POS</Badge>}
        </div>
        <span className="font-semibold tabular-nums text-danger">-{formatCurrency(d.amount)}</span>
      </div>

      {(reason || doc || d.coverage_eligible != null) && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {reason && (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Motivo</dt>
              <dd className="truncate">{reason}</dd>
            </div>
          )}
          {doc && (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Documentación</dt>
              <dd className="truncate">{doc}</dd>
            </div>
          )}
          {d.coverage_eligible != null && (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Cobertura de Mercado Pago</dt>
              <dd>{d.coverage_eligible ? "Puede aplicar" : "No aplica"}</dd>
            </div>
          )}
          {d.provider_case_id && d.kind !== "refund" && (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">N° de caso</dt>
              <dd className="truncate font-mono text-xs">{d.provider_case_id}</dd>
            </div>
          )}
        </dl>
      )}

      {dl && (
        <Callout
          tone={dl.overdue ? "neutral" : dl.urgent ? "danger" : "warning"}
          icon={dl.overdue ? AlertTriangle : CalendarClock}
          title={
            dl.overdue
              ? "Venció el plazo para presentar la documentación"
              : `Tenés hasta el ${longDay(dl.at)} para presentar la documentación`
          }
        >
          {dl.overdue
            ? "Si no la presentaste, Mercado Pago resuelve con lo que tiene."
            : `Quedan ${dl.daysLeft} ${dl.daysLeft === 1 ? "día" : "días"}. Presentala desde tu cuenta de Mercado Pago (Actividad, el pago con contracargo): ticket o factura, comprobante de entrega y lo que pruebe la venta.`}
        </Callout>
      )}
      {d.kind === "chargeback" && !d.resolved_at && !dl && !compact && (
        <p className="text-xs text-muted-foreground">
          Mercado Pago todavía no informó el plazo. Revisá el pago en tu cuenta de Mercado Pago por si pide documentación.
        </p>
      )}

      {!compact && timeline.length > 0 && (
        <ol className="space-y-1.5 text-sm">
          {timeline.map((e, i) => (
            <li key={`${e.label}-${i}`} className="flex items-center gap-2">
              <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", DOT[e.tone])} />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when(e.at)}</span>
            </li>
          ))}
        </ol>
      )}

      {canAck && !d.acknowledged_at && (
        <Button size="sm" variant="secondary" onClick={onAck} loading={ack.isPending}>
          <Check size={14} /> Marcar como visto
        </Button>
      )}
    </div>
  );
}
DisputeCard.displayName = "DisputeCard";
