"use client";

// =============================================================================
// Simulador de cambio de plan y de ciclo (F20-10 · H136 · ADR-131, spec docs/40
// §17.4). La cotización la arma la base (internal_billing_proration_preview) con
// el mismo núcleo que la confirmación: lo que se ve acá es lo que se carga.
//   · Upgrade: diferencia prorrateada que vence con el próximo cobro.
//   · Downgrade: al fin del período (default) o inmediato con crédito.
//   · Mensual ↔ anual: el período nuevo empieza hoy, con crédito por lo no usado.
// Si los números cambian entre la vista previa y la confirmación, la base lo
// rechaza (quote_changed) y se vuelve a cotizar.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CircleAlert, Info } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { formatCents, formatDay } from "@/lib/billing/ledger";
import { newRequestId } from "@/modules/billing/ledger";
import {
  CHANGE_KIND_LABELS,
  planChangeErrorMessage,
  useAssignablePlans,
  usePlanChange,
  useCurrentSubscription,
  useProrationPreview,
  type BillingCycle,
  type ChangeKind,
  type ChangeTiming,
  type ProrationQuote,
} from "@/modules/billing/planChange";

const KIND_TONES: Record<ChangeKind, BadgeTone> = {
  upgrade: "brand",
  downgrade: "warning",
  lateral: "neutral",
  cycle_up: "info",
  cycle_down: "info",
};

const formatPercentBp = (bp: number) =>
  `${(bp / 100).toLocaleString("es-AR", { maximumFractionDigits: 2 })} %`;

/** Resumen de la cotización (también lo usan los tests). */
export function QuoteSummary({ quote }: { quote: ProrationQuote }) {
  const lines = quote.charge?.lines ?? [];
  const scheduled = quote.effect === "scheduled";
  return (
    <div className="space-y-4" data-testid="quote-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONES[quote.kind]} className="rounded-md">
          {CHANGE_KIND_LABELS[quote.kind]}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {quote.from.plan_name ?? "Plan actual"} {quote.from.cycle === "yearly" ? "anual" : "mensual"} a{" "}
          {quote.to.plan_name ?? "plan nuevo"} {quote.to.cycle === "yearly" ? "anual" : "mensual"}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm min-[420px]:grid-cols-3">
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Período vigente</dt>
          <dd className="mt-0.5 tabular-nums">
            {formatDay(quote.period_start)} al {formatDay(quote.period_end)}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Días que quedan</dt>
          <dd className="mt-0.5 tabular-nums">
            {quote.days_left} de {quote.days}
          </dd>
        </div>
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <dt className="text-xs text-muted-foreground">Descuento vigente</dt>
          <dd className="mt-0.5 tabular-nums">{quote.percent_bp > 0 ? formatPercentBp(quote.percent_bp) : "Sin descuento"}</dd>
        </div>
      </dl>

      {lines.length > 0 && (
        <div className="slim-scrollbar overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Concepto</th>
                <th className="px-3 py-2 text-right font-medium">Importe</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.source}-${i}`} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">{l.description}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${l.amount_cents < 0 ? "text-success" : ""}`}>
                    {formatCents(l.amount_cents, { signed: l.amount_cents < 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-3 text-sm min-[420px]:grid-cols-2">
        <div className="rounded-lg border border-border px-3 py-2">
          <dt className="text-xs text-muted-foreground">Se carga</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums" data-testid="quote-charge">
            {formatCents(quote.charge_cents)}
          </dd>
          {quote.charge && quote.charge_cents > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">Vence el {formatDay(quote.charge.due_date)}</p>
          )}
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <dt className="text-xs text-muted-foreground">Queda a favor</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums" data-testid="quote-bonus">
            {formatCents(quote.bonus_cents)}
          </dd>
          {quote.bonus_cents > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Bonificación con el tope de tu nivel</p>}
        </div>
      </dl>

      {quote.new_period && (
        <p className="flex items-center gap-2 text-sm">
          <CalendarClock size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          Período nuevo: {formatDay(quote.new_period.start)} al {formatDay(quote.new_period.end)}
        </p>
      )}
      {scheduled && (
        <p className="flex items-center gap-2 text-sm">
          <CalendarClock size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          Queda programado para el {formatDay(quote.effective_on)}.
        </p>
      )}

      {quote.notes.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {quote.notes.map((n, i) => (
            <li key={i} className="flex gap-2">
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
      {(quote.warnings ?? []).length > 0 && (
        <Callout tone="warning" icon={CircleAlert} title="Ojo">
          <ul className="space-y-1">
            {(quote.warnings ?? []).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

export function PlanChangeDialog({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: plans, isLoading: plansLoading } = useAssignablePlans(tenantId, open);
  const [planId, setPlanId] = useState<string | null>(null);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [timing, setTiming] = useState<ChangeTiming>("auto");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newRequestId());
  const [changedMsg, setChangedMsg] = useState<string | null>(null);
  const { data: sub } = useCurrentSubscription(tenantId, open);

  // Al abrir: nuevo request id y formulario desde el plan y ciclo vigentes.
  useEffect(() => {
    if (open) {
      setRequestId(newRequestId());
      setReason("");
      setTiming("auto");
      setChangedMsg(null);
    }
  }, [open]);
  useEffect(() => {
    if (open && sub) {
      setPlanId(sub.plan_id);
      setCycle(sub.billing_cycle);
    }
  }, [open, sub]);

  const noChange = Boolean(sub) && planId === sub?.plan_id && cycle === sub?.billing_cycle;
  const preview = useProrationPreview(tenantId, planId, cycle, timing, open && !noChange && Boolean(sub));
  const quote = noChange ? undefined : preview.data;
  const apply = usePlanChange(tenantId);
  const previewError = preview.error ? planChangeErrorMessage(preview.error) : null;

  const options = useMemo(
    () =>
      (plans ?? []).map((p) => ({
        value: p.id,
        label: p.tenant_id ? `${p.name} (propio)` : p.name,
        description: `${formatCents(Math.round(p.monthly_price_ars * 100))} por mes`,
      })),
    [plans],
  );

  const canConfirm = Boolean(quote) && !noChange && !preview.isFetching && reason.trim().length >= 5 && !apply.isPending && !previewError;

  const confirm = async () => {
    if (!quote || !planId) return;
    try {
      const res = await apply.mutateAsync({
        planId,
        cycle,
        timing,
        reason: reason.trim(),
        requestId,
        expected: { charge_cents: quote.charge_cents, bonus_cents: quote.bonus_cents, timing: quote.timing },
      });
      if (res.status === "scheduled") {
        toast({ title: "Cambio programado", description: `Rige el ${formatDay(res.effective_on ?? quote.effective_on)}.`, variant: "success" });
      } else {
        toast({ title: "Plan cambiado", description: "El cambio ya rige y quedó en la cuenta corriente.", variant: "success" });
      }
      if (res.mpSync && !res.mpSync.ok) {
        toast({
          title: "Falta actualizar el débito automático",
          description: "No pudimos actualizar el monto en Mercado Pago. Reintentalo desde Modalidad y cobro.",
          variant: "warning",
        });
      }
      onOpenChange(false);
    } catch (e) {
      const msg = planChangeErrorMessage(e);
      if (String(e instanceof Error ? e.message : e).includes("quote_changed")) {
        setChangedMsg(msg);
        setRequestId(newRequestId());
        await preview.refetch();
      } else {
        toast({ title: "No se pudo cambiar el plan", description: msg, variant: "error" });
      }
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Simular cambio de plan"
      description="Elegí el plan, el ciclo y cuándo rige. La cotización es la misma que se aplica al confirmar."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={confirm} loading={apply.isPending} disabled={!canConfirm}>
            {quote?.timing === "period_end" ? "Programar cambio" : "Confirmar cambio"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {plansLoading ? (
          <Skeleton className="h-11 rounded-lg" />
        ) : (
          <Select<string>
            label="Plan"
            value={planId}
            options={options}
            onChange={(v) => {
              setPlanId(v);
              setChangedMsg(null);
            }}
            placeholder="Elegí un plan"
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">Ciclo</p>
            <Segmented<BillingCycle>
              aria-label="Ciclo"
              value={cycle}
              onChange={(v) => {
                setCycle(v);
                setChangedMsg(null);
              }}
              fill
              options={[
                { value: "monthly", label: "Mensual" },
                { value: "yearly", label: "Anual" },
              ]}
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">Cuándo rige</p>
            <Segmented<ChangeTiming>
              aria-label="Cuándo rige"
              value={timing}
              onChange={(v) => {
                setTiming(v);
                setChangedMsg(null);
              }}
              scrollOnMobile
              options={[
                { value: "auto", label: "Automático" },
                { value: "immediate", label: "Inmediato" },
                { value: "period_end", label: "Al fin del período" },
              ]}
            />
          </div>
        </div>

        {changedMsg && (
          <Callout tone="warning" icon={CircleAlert} title="Los números cambiaron">
            {changedMsg}
          </Callout>
        )}

        {!planId ? (
          <p className="text-sm text-muted-foreground">Elegí un plan para ver la cotización.</p>
        ) : noChange ? (
          <p className="text-sm text-muted-foreground">Es el plan y el ciclo actuales: elegí otro para simular.</p>
        ) : previewError ? (
          <Callout tone="warning" icon={CircleAlert} title="No se pudo cotizar">
            {previewError}
          </Callout>
        ) : preview.isLoading || !quote ? (
          <Skeleton className="h-48 rounded-lg" />
        ) : (
          <div className={preview.isFetching ? "opacity-60 transition-opacity" : undefined}>
            <QuoteSummary quote={quote} />
          </div>
        )}

        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: pidió pasar a anual por WhatsApp" />
      </div>
    </Modal>
  );
}
