"use client";

// =============================================================================
// Pestaña "Cuenta corriente" del detalle del negocio en el panel interno
// (F20-1 · ADR-115, spec docs/40 §14.4). Saldo, vencido, a vencer y a favor;
// movimientos con saldo corrido; vencimientos con su detalle; pagos;
// imputaciones y la historia (auditoría de cobranza). Registrar pago,
// bonificar, cargo manual, anular un cargo y revertir un pago, todo con
// motivo. Operan Cobranzas, admin y super_admin; el resto mira.
// =============================================================================

import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Ban,
  CalendarClock,
  FlaskConical,
  HandCoins,
  History,
  Landmark,
  ListOrdered,
  Plus,
  ReceiptText,
  Settings2,
  Undo2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import {
  AgingBar,
  ChargesList,
  MovementsList,
  PaymentsList,
  StatementSummary,
} from "@/components/billing/StatementParts";
import { BonusModal, ChargeModal, RegisterPaymentModal, TermsModal } from "@/components/internal/billing/LedgerModals";
import { TenantCollectionPanel } from "@/components/internal/billing/TenantCollectionPanel";
import { TenantMoraPanel } from "@/components/internal/billing/TenantMoraPanel";
import {
  BILLING_MODE_LABELS,
  BILLING_ROLE_LABELS,
  EXCLUSION_LABELS,
  billingErrorMessage,
  formatCents,
  formatDay,
} from "@/lib/billing/ledger";
import {
  useBillingAccess,
  useInternalStatement,
  useLedgerMutations,
  type LedgerCharge,
  type LedgerPayment,
  type TimelineEvent,
} from "@/modules/billing/ledger";

type View = "movimientos" | "vencimientos" | "pagos" | "imputaciones" | "historia";

const VIEWS: { value: View; label: string; icon: React.ReactNode }[] = [
  { value: "movimientos", label: "Movimientos", icon: <ListOrdered size={15} /> },
  { value: "vencimientos", label: "Vencimientos", icon: <CalendarClock size={15} /> },
  { value: "pagos", label: "Pagos", icon: <Wallet size={15} /> },
  { value: "imputaciones", label: "Imputaciones", icon: <ArrowLeftRight size={15} /> },
  { value: "historia", label: "Historia", icon: <History size={15} /> },
];

const ACTION_LABELS: Record<string, string> = {
  platform_charge_created: "Cargo generado",
  platform_payment_recorded: "Pago acreditado",
  platform_payment_registered: "Pago registrado a mano",
  platform_bonus_granted: "Bonificación",
  platform_adjustment_charged: "Cargo manual",
  platform_charge_voided: "Cargo anulado",
  platform_payment_reversed: "Pago revertido",
  platform_proration_failed: "No se pudo prorratear el cambio de plan",
  platform_ledger_ingest_failed: "Un pago no entró a la cuenta corriente (se reintenta)",
  tenant_billing_terms_set: "Condiciones de cobro",
  tenant_test_flag_set: "Marca de negocio de prueba",
  plan_changed: "Cambio de plan",
  status_changed: "Cambio de estado",
  subscription_webhook: "Aviso de Mercado Pago",
  subscription_reactivated: "Período renovado",
  subscription_cancelled_on_reanchor: "Baja al vencer",
  trial_extended: "Prueba extendida",
  payment_recorded: "Cobro de Mercado Pago",
  // F20-8 (ADR-120)
  billing_mode_change_requested: "Cambio de modalidad",
  billing_mode_change_applied: "Pasó a débito automático (primer débito)",
  billing_mode_mp_cancelled: "Débito automático cancelado en Mercado Pago",
  billing_mode_mp_cancel_failed: "No se pudo cancelar el débito en Mercado Pago",
  tenant_billing_notice_terms_set: "Aviso de cobro configurado",
  platform_payment_notice_sent: "Aviso de cobro enviado",
  platform_payment_notice_manual: "Aviso de cobro enviado a mano",
  platform_transfer_reported: "Transferencia informada por el negocio",
  platform_transfer_approved: "Transferencia acreditada",
  platform_transfer_rejected: "Transferencia rechazada",
  platform_transfer_report_cancelled: "Transferencia retirada por el negocio",
  subscription_webhook_ignored: "Aviso de Mercado Pago ignorado (no es la modalidad vigente)",
  invite_code_redeemed: "Código de invitación canjeado",
  // F20-9 (ADR-128)
  platform_interest_accrued: "Punitorios devengados",
  platform_interest_waived: "Punitorios condonados",
  platform_interest_waiver_requested: "Condonación pedida (supera el tope)",
  platform_interest_waiver_rejected: "Condonación rechazada",
  platform_interest_failed: "No se pudieron devengar los punitorios (se reintenta)",
  platform_interest_paused: "Punitorios pausados",
  platform_interest_resumed: "Punitorios reanudados",
  platform_promise_created: "Promesa de pago",
  platform_promise_kept: "Promesa cumplida",
  platform_promise_broken: "Promesa incumplida",
  platform_promise_extended: "Promesa ampliada",
  platform_promise_cancelled: "Promesa cancelada",
  platform_dunning_step: "Escalera de mora",
  platform_dunning_lifted: "Restricciones levantadas",
  platform_dunning_failed: "Falló la escalera de mora (se reintenta)",
  platform_fiscal_hook_failed: "No se pudo registrar una ND pendiente",
  tenant_billing_mora_terms_set: "Condiciones de mora",
};

function eventDetail(e: TimelineEvent): string | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const cents = typeof d.amount_cents === "number" ? d.amount_cents : typeof d.total_cents === "number" ? d.total_cents : null;
  if (typeof d.step === "string") return cents !== null ? `${d.step} · ${formatCents(cents)}` : d.step;
  if (e.action === "platform_interest_accrued" && cents !== null && typeof d.month === "string") {
    return `${formatCents(cents)} en ${d.month.slice(5, 7)}/${d.month.slice(0, 4)}`;
  }
  if (cents !== null && typeof d.credit_note_cents === "number" && d.credit_note_cents > 0) {
    return `${formatCents(cents)} · NC ${formatCents(d.credit_note_cents)} pendiente (H130)`;
  }
  if (cents !== null) return formatCents(cents);
  if (typeof d.promised_date === "string" && typeof d.amount_cents !== "number") return `para el ${formatDay(d.promised_date)}`;
  if (typeof d.is_test === "boolean") return d.is_test ? "Marcado de prueba" : "Vuelve a contar como cliente";
  if (typeof d.to_mode === "string") return `a ${BILLING_MODE_LABELS[d.to_mode] ?? d.to_mode}`;
  if (typeof d.billing_mode === "string") return BILLING_MODE_LABELS[d.billing_mode] ?? d.billing_mode;
  if (typeof d.plan === "string") return `Plan ${d.plan}`;
  if (typeof d.status === "string") return `Estado ${d.status}`;
  return null;
}

export function TenantLedgerTab({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { toast } = useToast();
  const { data: s, isLoading, error } = useInternalStatement(tenantId);
  const { data: access } = useBillingAccess();
  const m = useLedgerMutations(tenantId);
  const [view, setView] = useState<View>("movimientos");
  const [modal, setModal] = useState<null | "pago" | "bonif" | "cargo" | "condiciones">(null);
  const [voiding, setVoiding] = useState<LedgerCharge | null>(null);
  const [reversing, setReversing] = useState<LedgerPayment | null>(null);
  const [reverseKind, setReverseKind] = useState<"chargeback" | "refund">("chargeback");
  const [testTo, setTestTo] = useState<boolean | null>(null);

  const canOperate = Boolean(access?.can_operate);
  const today = s?.as_of ?? "";
  const activeAllocations = useMemo(() => (s?.allocations ?? []).filter((a) => !a.released_at), [s]);

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[104px] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error || !s) {
    return (
      <Callout tone="warning" icon={Landmark} title="No se pudo cargar la cuenta corriente">
        {billingErrorMessage(error)}
      </Callout>
    );
  }

  const isTest = Boolean(s.is_test);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Cuenta corriente"
        icon={Landmark}
        description="Lo que el negocio le debe a NinjaSoft por su suscripción. Nada se edita: cada corrección es un movimiento nuevo con motivo."
        actions={access ? <Badge tone="neutral">Tu acceso: {BILLING_ROLE_LABELS[access.role] ?? access.role}</Badge> : undefined}
      />

      {s.exclusion && (
        <Callout tone="neutral" icon={FlaskConical} title={`No se cobra: ${EXCLUSION_LABELS[s.exclusion] ?? s.exclusion}`}>
          No se le generan cargos automáticos y no cuenta en el MRR ni en los demás KPIs. Los pagos que entren igual quedan
          registrados.
        </Callout>
      )}

      <StatementSummary s={s} />

      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-6 gap-y-3 text-sm min-[420px]:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Modalidad</dt>
            <dd className="mt-0.5 truncate font-medium">{BILLING_MODE_LABELS[s.billing_mode] ?? s.billing_mode}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Plan</dt>
            <dd className="mt-0.5 truncate font-medium">
              {s.subscription?.plan_name ?? "Sin plan"}
              {s.subscription ? ` · ${s.subscription.billing_cycle === "yearly" ? "anual" : "mensual"}` : ""}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Cuota con descuentos</dt>
            <dd className="mt-0.5 truncate font-medium tabular-nums">
              {s.recurring_cents == null ? "Sin suscripción" : formatCents(s.recurring_cents)}
              {s.recurring_gross_cents != null && s.recurring_cents != null && s.recurring_gross_cents > s.recurring_cents && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground line-through">{formatCents(s.recurring_gross_cents)}</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Período actual hasta</dt>
            <dd className="mt-0.5 truncate font-medium tabular-nums">
              {s.subscription?.current_period_end ? formatDay(s.subscription.current_period_end) : "Sin período"}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          {access?.can_configure && (
            <label className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
              <Switch checked={isTest} onCheckedChange={(v) => setTestTo(v)} label="Negocio de prueba" />
              Negocio de prueba
            </label>
          )}
          {access?.can_set_terms && (
            <Button variant="secondary" size="sm" onClick={() => setModal("condiciones")}>
              <Settings2 size={15} /> Plazo de pago
            </Button>
          )}
        </div>
      </div>

      {canOperate ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setModal("pago")}>
            <HandCoins size={16} /> Registrar pago
          </Button>
          <Button variant="secondary" onClick={() => setModal("bonif")}>
            <ReceiptText size={16} /> Bonificar
          </Button>
          <Button variant="secondary" onClick={() => setModal("cargo")}>
            <Plus size={16} /> Cargo manual
          </Button>
        </div>
      ) : (
        access && (
          <p className="text-sm text-muted-foreground">
            Para registrar pagos o bonificar hace falta el permiso Cobranzas (lo da un super admin en Staff).
          </p>
        )
      )}

      {s.overdue_cents > 0 && <AgingBar aging={s.aging} />}

      <TenantCollectionPanel tenantId={tenantId} tenantName={tenantName} access={access} />

      <TenantMoraPanel tenantId={tenantId} access={access} balanceCents={s.balance_cents} />

      <div className="space-y-3">
        <Segmented<View> value={view} onChange={setView} options={VIEWS} iconOnlyOnMobile aria-label="Vista de la cuenta corriente" />

        {view === "movimientos" &&
          (s.movements.length === 0 ? (
            <EmptyState compact icon={ListOrdered} title="Sin movimientos" description="Los cargos y pagos aparecen acá apenas se generan." />
          ) : (
            <MovementsList movements={s.movements} staff />
          ))}

        {view === "vencimientos" &&
          (s.charges.length === 0 ? (
            <EmptyState compact icon={CalendarClock} title="Sin cargos" description="El primer cargo se genera al renovarse el período." />
          ) : (
            <ChargesList
              charges={s.charges}
              today={today}
              staff
              renderActions={(c) =>
                canOperate && c.status !== "voided" ? (
                  <Button variant="ghost" size="sm" onClick={() => setVoiding(c)} aria-label={`Anular ${c.description}`}>
                    <Ban size={15} /> <span className="hidden sm:inline">Anular</span>
                  </Button>
                ) : null
              }
            />
          ))}

        {view === "pagos" &&
          (s.payments.length === 0 ? (
            <EmptyState compact icon={Wallet} title="Sin pagos" description="Los débitos de Mercado Pago entran solos; los demás, con Registrar pago." />
          ) : (
            <PaymentsList
              payments={s.payments}
              staff
              renderActions={(p) =>
                canOperate && p.status === "approved" ? (
                  <Button variant="ghost" size="sm" onClick={() => setReversing(p)} aria-label="Revertir pago">
                    <Undo2 size={15} /> <span className="hidden sm:inline">Revertir</span>
                  </Button>
                ) : null
              }
            />
          ))}

        {view === "imputaciones" &&
          (activeAllocations.length === 0 ? (
            <EmptyState compact icon={ArrowLeftRight} title="Sin imputaciones" description="Cada pago o bonificación se imputa a la deuda más vieja." />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {s.allocations.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      <span className="font-medium">{a.credit_description}</span>
                      <span className="text-muted-foreground"> cancela </span>
                      <span className="font-medium">{a.debit_description}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDay(a.created_at)}
                      {a.released_at ? ` · liberada el ${formatDay(a.released_at)}` : ""}
                    </p>
                  </div>
                  <span className={a.released_at ? "tabular-nums text-muted-foreground line-through" : "font-semibold tabular-nums"}>
                    {formatCents(a.amount_cents)}
                  </span>
                </li>
              ))}
            </ul>
          ))}

        {view === "historia" &&
          ((s.timeline ?? []).length === 0 ? (
            <EmptyState compact icon={History} title="Sin historia todavía" />
          ) : (
            <ol className="space-y-0 overflow-hidden rounded-xl border border-border bg-card">
              {(s.timeline ?? []).map((e) => {
                const detail = eventDetail(e);
                return (
                  <li key={e.id} className="flex gap-3 border-b border-border/60 px-4 py-3 last:border-0">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-ninja-flameSoft" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <p className="text-sm font-medium">
                          {ACTION_LABELS[e.action] ?? e.action}
                          {detail ? <span className="font-normal text-muted-foreground"> · {detail}</span> : null}
                        </p>
                        <time className="text-xs tabular-nums text-muted-foreground" dateTime={e.at}>
                          {new Date(e.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                        </time>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {e.actor ?? "Sistema"}
                        {e.reason ? ` · ${e.reason}` : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          ))}
      </div>

      <RegisterPaymentModal open={modal === "pago"} onOpenChange={(o) => setModal(o ? "pago" : null)} tenantId={tenantId} statement={s} />
      <BonusModal open={modal === "bonif"} onOpenChange={(o) => setModal(o ? "bonif" : null)} tenantId={tenantId} statement={s} access={access} />
      <ChargeModal open={modal === "cargo"} onOpenChange={(o) => setModal(o ? "cargo" : null)} tenantId={tenantId} statement={s} />
      <TermsModal
        open={modal === "condiciones"}
        onOpenChange={(o) => setModal(o ? "condiciones" : null)}
        tenantId={tenantId}
        statement={s}
        access={access}
      />

      <ReasonDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Anular cargo"
        description={
          voiding
            ? `${voiding.description} por ${formatCents(voiding.total_cents)}. Lo que se le había imputado vuelve a quedar disponible y se aplica a la deuda más vieja. Cuenta en tu tope de bonificaciones.`
            : undefined
        }
        confirmLabel="Anular cargo"
        danger
        loading={m.voidCharge.isPending}
        onConfirm={async (reason) => {
          if (!voiding) return;
          try {
            await m.voidCharge.mutateAsync({ chargeId: voiding.id, reason });
            toast({ title: "Cargo anulado", variant: "success" });
            setVoiding(null);
          } catch (e) {
            toast({ title: "No se pudo anular", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      <ReasonDialog
        open={reversing !== null}
        onOpenChange={(o) => {
          if (!o) setReversing(null);
          else setReverseKind("chargeback");
        }}
        title="Revertir pago"
        description={
          reversing
            ? `${formatCents(reversing.amount_cents)} del ${formatDay(reversing.paid_at)}. Los cargos que pagaba vuelven a deberse.`
            : undefined
        }
        confirmLabel="Revertir pago"
        danger
        loading={m.reversePayment.isPending}
        extra={
          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">Qué pasó</p>
            <Segmented<"chargeback" | "refund">
              value={reverseKind}
              onChange={setReverseKind}
              fill
              aria-label="Tipo de reversa"
              options={[
                { value: "chargeback", label: "Contracargo" },
                { value: "refund", label: "Reintegro" },
              ]}
            />
          </div>
        }
        onConfirm={async (reason) => {
          if (!reversing) return;
          try {
            await m.reversePayment.mutateAsync({ paymentId: reversing.id, kind: reverseKind, reason });
            toast({ title: "Pago revertido", variant: "success" });
            setReversing(null);
          } catch (e) {
            toast({ title: "No se pudo revertir", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      <ReasonDialog
        open={testTo !== null}
        onOpenChange={(o) => !o && setTestTo(null)}
        title={testTo ? "Marcar como negocio de prueba" : "Volver a contarlo como cliente"}
        description={
          testTo
            ? `${tenantName} deja de generar cargos y sale del MRR, el churn y la conversión.`
            : `${tenantName} vuelve a generar cargos y a contar en los KPIs.`
        }
        confirmLabel={testTo ? "Marcar de prueba" : "Volver a contar"}
        loading={m.setTest.isPending}
        onConfirm={async (reason) => {
          if (testTo === null) return;
          try {
            await m.setTest.mutateAsync({ isTest: testTo, reason });
            toast({ title: testTo ? "Marcado como negocio de prueba" : "Vuelve a contar como cliente", variant: "success" });
            setTestTo(null);
          } catch (e) {
            toast({ title: "No se pudo cambiar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}
TenantLedgerTab.displayName = "TenantLedgerTab";
