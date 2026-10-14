"use client";

// =============================================================================
// Ficha del negocio › Cuenta corriente › Modalidad y cobro (F20-8 · ADR-120).
//   · Cambiar modalidad en cualquier sentido (Mercado Pago, cuenta corriente,
//     manual, exento) con la vista previa de lo que implica: al dejar MP se
//     cancela el débito automático; al pasar a MP se genera el checkout y el
//     negocio sigue como estaba hasta el primer débito aprobado.
//   · Aviso de cobro del negocio (frecuencia, días antes, destinatarios),
//     envío manual y últimos avisos.
//   · Transferencias informadas por el negocio e historial de modalidad.
// =============================================================================

import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  BellRing,
  CircleAlert,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  FileClock,
  Hand,
  Landmark,
  Link2,
  RefreshCw,
  Send,
  ShieldOff,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { TransferInbox } from "@/components/internal/billing/TransferInbox";
import { BILLING_MODE_LABELS, billingErrorMessage, formatCents, formatDay } from "@/lib/billing/ledger";
import {
  STATEMENT_FREQUENCY_LABELS,
  modeChangePlan,
  type BillingModeKey,
  type StatementFrequency,
} from "@/lib/billing/paymentNotice";
import type { BillingAccess } from "@/modules/billing/ledger";
import {
  useCollection,
  useCollectionMutations,
  useModeChange,
  type CollectionView,
  type ModeChange,
  type ModeChangeResult,
} from "@/modules/billing/collection";

const MODE_ICON: Record<BillingModeKey, React.ReactNode> = {
  mp_subscription: <CreditCard size={18} aria-hidden />,
  account: <Landmark size={18} aria-hidden />,
  manual: <Hand size={18} aria-hidden />,
  exempt: <ShieldOff size={18} aria-hidden />,
};

const MODE_DESC: Record<BillingModeKey, string> = {
  mp_subscription: "Débito automático todos los períodos. El cliente autoriza la tarjeta en Mercado Pago.",
  account: "Aviso de cobro con los datos bancarios; paga por transferencia y sube el comprobante.",
  manual: "Sin avisos automáticos: el staff registra cada pago.",
  exempt: "No se le generan cargos y no cuenta en los KPIs. Sólo super admin.",
};

const CHANGE_STATUS: Record<ModeChange["status"], { label: string; tone: "success" | "warning" | "neutral" | "danger" }> = {
  applied: { label: "Aplicado", tone: "success" },
  pending_checkout: { label: "Espera el primer débito", tone: "warning" },
  pending_mp_cancel: { label: "Falta cancelar en MP", tone: "danger" },
  cancelled: { label: "Reemplazado", tone: "neutral" },
};

const modeLabel = (m: string | null | undefined) => (m ? BILLING_MODE_LABELS[m] ?? m : "Automática");

function CopyLink({ url }: { url: string }) {
  const { toast } = useToast();
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3 sm:flex-row sm:items-center">
      <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void navigator.clipboard?.writeText(url).then(() => toast({ title: "Link copiado", variant: "success" }))}
        >
          <Copy size={14} aria-hidden /> Copiar
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-ninja-flameSoft hover:bg-muted"
        >
          <ExternalLink size={14} aria-hidden /> Abrir
        </a>
      </div>
    </div>
  );
}

// ── Cambiar modalidad ───────────────────────────────────────────────────────

export function ModeChangeModal({
  open,
  onOpenChange,
  tenantId,
  view,
  isSuper,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  view: NonNullable<CollectionView["tenant"]>;
  isSuper: boolean;
}) {
  const { toast } = useToast();
  const mc = useModeChange(tenantId);
  const current = view.stored_mode;
  const pendingMp = view.terms?.pending_mode === "mp_subscription";
  const [to, setTo] = useState<BillingModeKey | null>(null);
  const [dueDays, setDueDays] = useState("");
  const [exemptReason, setExemptReason] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ModeChangeResult | null>(null);

  const reset = () => {
    setTo(null);
    setDueDays(view.terms?.due_days != null ? String(view.terms.due_days) : "");
    setExemptReason("");
    setReason("");
    setResult(null);
  };

  // Con un pase a MP pendiente: quedarse en la modalidad actual (lo cancela)
  // o pasar a otra; sin pase pendiente: cualquiera menos la actual.
  const options = (["account", "mp_subscription", "manual", "exempt"] as BillingModeKey[]).filter((m) =>
    pendingMp ? m !== "mp_subscription" : m !== current,
  );
  const plan = to ? modeChangePlan(to, view.has_preapproval) : null;
  const days = dueDays.trim() === "" ? null : Number(dueDays);
  const daysOk = days === null || (Number.isInteger(days) && days >= 0 && days <= 60);
  const can =
    to !== null &&
    daysOk &&
    reason.trim().length >= 5 &&
    (to !== "exempt" || (isSuper && exemptReason.trim().length >= 5)) &&
    !mc.change.isPending;

  async function submit() {
    if (!to || !can) return;
    try {
      const r = await mc.change.mutateAsync({
        to,
        dueDays: to === "account" || to === "manual" ? days : null,
        exemptReason: to === "exempt" ? exemptReason.trim() : null,
        reason: reason.trim(),
      });
      setResult(r);
      toast({ title: "Modalidad cambiada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo cambiar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        onOpenChange(o);
      }}
      title={result ? "Listo" : "Cambiar modalidad de cobro"}
      description={result ? undefined : `Hoy: ${modeLabel(current)}${pendingMp ? " (con pase a Mercado Pago pendiente)" : ""}.`}
      className="max-w-lg"
      footer={
        result ? (
          <Button onClick={() => onOpenChange(false)}>Cerrar</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={!can} loading={mc.change.isPending}>
              Cambiar modalidad
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ul className="space-y-3 text-sm">
          <li className="flex gap-2">
            <Badge tone="success">Hecho</Badge>
            <span>
              {result.needs_checkout
                ? `Pase a débito automático pedido. Sigue en ${modeLabel(result.from_mode)} hasta el primer débito aprobado.`
                : `Ahora paga con ${modeLabel(result.to_mode)}.`}
            </span>
          </li>
          {result.mpCancel && (
            <li className="flex gap-2">
              <Badge tone={result.mpCancel.ok ? "success" : "danger"}>{result.mpCancel.ok ? "Hecho" : "Falló"}</Badge>
              <span>
                {result.mpCancel.ok
                  ? "Débito automático cancelado en Mercado Pago: no le va a cobrar más."
                  : `No se pudo cancelar en Mercado Pago (${result.mpCancel.detail ?? "sin detalle"}). Reintentalo desde la ficha antes del próximo débito; mientras tanto, los avisos de MP no cambian el estado del negocio.`}
              </span>
            </li>
          )}
          {result.needs_checkout && (
            <li className="space-y-2">
              {result.checkoutUrl ? (
                <>
                  <p>Mandale este link para que autorice el débito. También lo ve en su panel, en Estado de cuenta.</p>
                  <CopyLink url={result.checkoutUrl} />
                </>
              ) : (
                <Callout tone="warning" icon={CircleAlert} title="No se pudo generar el link de Mercado Pago">
                  {billingErrorMessage(result.checkoutError)} Generalo desde la ficha o que el cliente lo complete en su panel.
                </Callout>
              )}
            </li>
          )}
        </ul>
      ) : (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Nueva modalidad" className="grid gap-2">
            {options.map((m) => (
              <ChoiceCard
                key={m}
                selected={to === m}
                onClick={() => setTo(m)}
                icon={MODE_ICON[m]}
                title={m === current && pendingMp ? `Quedarse en ${modeLabel(m)}` : modeLabel(m)}
                description={m === current && pendingMp ? "Cancela el pase a Mercado Pago que está pendiente." : MODE_DESC[m]}
                disabled={m === "exempt" && !isSuper}
              />
            ))}
          </div>

          {plan && to && (
            <Callout tone="info" icon={ArrowRightLeft} title="Qué va a pasar">
              <ul className="list-disc space-y-1 pl-4">
                {plan.needsCheckout ? (
                  <>
                    <li>Generamos el link de suscripción de Mercado Pago para que el cliente autorice el débito.</li>
                    <li>Hasta el primer débito aprobado sigue en {modeLabel(current)}: lo que ya debe se cobra como hasta ahora.</li>
                    <li>El primer débito paga el próximo período; ahí pasa solo a débito automático.</li>
                  </>
                ) : (
                  <>
                    <li>Rige desde ahora para los cargos que se generen.</li>
                    {plan.cancelsPreapproval && (
                      <li>Cancelamos el débito automático en Mercado Pago para que no le cobre doble.</li>
                    )}
                    {to === "account" && <li>Recibe el aviso de cobro con los datos bancarios y paga por transferencia.</li>}
                  </>
                )}
                <li>Queda en la auditoría y el cliente lo ve en su panel.</li>
              </ul>
            </Callout>
          )}

          {(to === "account" || to === "manual") && (
            <Input
              label="Plazo de pago (días desde el inicio del período)"
              inputMode="numeric"
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="Por defecto de la plataforma"
              error={daysOk ? undefined : "De 0 a 60 días"}
            />
          )}
          {to === "exempt" && (
            <Input
              label="Motivo de la exención"
              value={exemptReason}
              onChange={(e) => setExemptReason(e.target.value)}
              placeholder="Ej.: cortesía por ser socio fundador"
            />
          )}
          <ReasonField value={reason} onChange={setReason} placeholder="Ej.: pidió pagar por transferencia mensual" />
        </div>
      )}
    </Modal>
  );
}

// ── Aviso de cobro del negocio ──────────────────────────────────────────────

const parseEmails = (t: string) =>
  t
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

export function NoticeTermsModal({
  open,
  onOpenChange,
  tenantId,
  view,
  defaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  view: NonNullable<CollectionView["tenant"]>;
  defaults: CollectionView["settings"];
}) {
  const { toast } = useToast();
  const m = useCollectionMutations();
  const t = view.terms;
  const [inherit, setInherit] = useState(true);
  const [freq, setFreq] = useState<StatementFrequency>("per_period");
  const [lead, setLead] = useState("");
  const [every, setEvery] = useState("");
  const [day, setDay] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [reason, setReason] = useState("");

  const reset = () => {
    setInherit(!t?.statement_frequency && t?.notice_lead_days == null);
    setFreq(t?.statement_frequency ?? defaults.statement_frequency_default);
    setLead(String(t?.notice_lead_days ?? defaults.notice_lead_days_default));
    setEvery(String(t?.statement_every_days ?? defaults.statement_every_days_default));
    setDay(String(t?.statement_day ?? defaults.statement_day_default));
    setTo((t?.send_to ?? []).join(", "));
    setCc((t?.cc ?? []).join(", "));
    setReason("");
  };

  const toList = parseEmails(to);
  const ccList = parseEmails(cc);
  const badEmail = [...toList, ...ccList].find((e) => !emailOk(e));
  const n = (v: string) => Number(v);
  const numsOk =
    inherit ||
    (n(lead) >= 0 && n(lead) <= 30 && Number.isInteger(n(lead)) &&
      (freq !== "every_n_days" || (n(every) >= 1 && n(every) <= 60)) &&
      (freq !== "monthly_day" || (n(day) >= 1 && n(day) <= 31)));
  const can = !badEmail && toList.length <= 5 && ccList.length <= 5 && numsOk && reason.trim().length >= 5 && !m.setNoticeTerms.isPending;

  async function submit() {
    if (!can) return;
    try {
      await m.setNoticeTerms.mutateAsync({
        tenantId,
        frequency: inherit ? null : freq,
        everyDays: inherit || freq !== "every_n_days" ? null : n(every),
        day: inherit || freq !== "monthly_day" ? null : n(day),
        leadDays: inherit ? null : n(lead),
        sendTo: toList,
        cc: ccList,
        reason: reason.trim(),
      });
      toast({ title: "Aviso de cobro guardado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        onOpenChange(o);
      }}
      title="Aviso de cobro de este negocio"
      description="Cada cuánto le llega el aviso con los datos bancarios y a qué emails."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!can} loading={m.setNoticeTerms.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented<"inherit" | "own">
          value={inherit ? "inherit" : "own"}
          onChange={(v) => setInherit(v === "inherit")}
          fill
          aria-label="Configuración del aviso"
          options={[
            { value: "inherit", label: "La de la plataforma" },
            { value: "own", label: "Propia" },
          ]}
        />
        {inherit ? (
          <p className="text-sm text-muted-foreground">
            {STATEMENT_FREQUENCY_LABELS[defaults.statement_frequency_default]}
            {defaults.statement_frequency_default !== "monthly_day" ? `, ${defaults.notice_lead_days_default} días antes del vencimiento` : ""}.
            {!defaults.notices_enabled ? " Hoy los avisos automáticos están apagados en la plataforma." : ""}
          </p>
        ) : (
          <div className="space-y-3">
            <Segmented<StatementFrequency>
              value={freq}
              onChange={setFreq}
              aria-label="Frecuencia"
              options={[
                { value: "per_period", label: "Una vez" },
                { value: "every_n_days", label: "Repetir" },
                { value: "monthly_day", label: "Resumen mensual" },
              ]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {freq !== "monthly_day" && (
                <Input label="Días antes del vencimiento" inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/[^\d]/g, ""))} />
              )}
              {freq === "every_n_days" && (
                <Input label="Repetir cada (días)" inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value.replace(/[^\d]/g, ""))} />
              )}
              {freq === "monthly_day" && (
                <Input label="Día del mes" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/[^\d]/g, ""))} />
              )}
            </div>
          </div>
        )}
        <Input
          label="Enviar a (opcional)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Vacío: los dueños del negocio"
          hint="Separá los emails con coma. Hasta 5."
          error={badEmail ? `Email inválido: ${badEmail}` : undefined}
        />
        <Input label="Con copia a (opcional)" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="contador@negocio.com" />
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: el contador pidió recibir los avisos" />
      </div>
    </Modal>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

function noticeSummary(view: NonNullable<CollectionView["tenant"]>, d: CollectionView["settings"]): string {
  const t = view.terms;
  const freq = t?.statement_frequency ?? d.statement_frequency_default;
  const lead = t?.notice_lead_days ?? d.notice_lead_days_default;
  if (freq === "monthly_day") return `Resumen mensual el día ${t?.statement_day ?? d.statement_day_default}`;
  if (freq === "every_n_days") return `${lead} días antes del vencimiento y cada ${t?.statement_every_days ?? d.statement_every_days_default} días hasta que pague`;
  return `Una vez por cuota, ${lead} días antes del vencimiento`;
}

export function TenantCollectionPanel({
  tenantId,
  tenantName,
  access,
}: {
  tenantId: string;
  tenantName: string;
  access: BillingAccess | undefined;
}) {
  const { toast } = useToast();
  const { data, isLoading, error } = useCollection(tenantId);
  const mc = useModeChange(tenantId);
  const m = useCollectionMutations();
  const [modeOpen, setModeOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const view = data?.tenant;
  const canOperate = Boolean(access?.can_operate);
  const canSetTerms = Boolean(access?.can_set_terms);
  const failedCancel = useMemo(
    () => view?.mode_changes.find((c) => c.status === "pending_mp_cancel") ?? null,
    [view],
  );

  if (error) {
    return (
      <Callout tone="warning" icon={Wallet} title="No se pudo cargar la modalidad de cobro">
        {billingErrorMessage(error)}
      </Callout>
    );
  }
  if (isLoading || !data || !view) return <Skeleton className="h-48 rounded-xl" />;

  const pendingMp = view.terms?.pending_mode === "mp_subscription";
  const isAccount = view.effective_mode === "account";

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          title="Modalidad y cobro"
          icon={Wallet}
          description="Cómo paga este negocio y cómo le llega el aviso de cobro."
          actions={
            canSetTerms ? (
              <Button size="sm" variant="secondary" onClick={() => setModeOpen(true)}>
                <ArrowRightLeft size={15} aria-hidden /> Cambiar modalidad
              </Button>
            ) : undefined
          }
        />
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                {MODE_ICON[view.effective_mode] ?? <Wallet size={18} aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Modalidad</p>
                <p className="font-semibold">{modeLabel(view.effective_mode)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {view.has_preapproval ? "Tiene débito automático en Mercado Pago." : "Sin débito automático en Mercado Pago."}
                  {view.terms?.due_days != null ? ` Paga a ${view.terms.due_days} días.` : ""}
                </p>
              </div>
              {pendingMp && <Badge tone="warning">Pase a MP pendiente</Badge>}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <BellRing size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Aviso de cobro</p>
                <p className="font-semibold">{isAccount ? noticeSummary(view, data.settings) : "Sólo en cuenta corriente"}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  A {view.recipients.length > 0 ? view.recipients.join(", ") : "nadie (sin email del dueño)"}
                  {!data.settings.notices_enabled ? " · automáticos apagados" : ""}
                </p>
              </div>
            </div>
            {canOperate && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setNoticeOpen(true)}>
                  <Clock size={14} aria-hidden /> Configurar
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setSendOpen(true)}>
                  <Send size={14} aria-hidden /> Enviar aviso ahora
                </Button>
              </div>
            )}
          </div>
        </div>

        {pendingMp && (
          <Callout
            tone="warning"
            icon={Link2}
            title="Esperando que el cliente autorice el débito automático"
            className="mt-3"
            actions={
              canSetTerms ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={mc.checkout.isPending}
                  onClick={async () => {
                    const r = await mc.checkout.mutateAsync();
                    if (r.url) setLink(r.url);
                    else toast({ title: "No se pudo generar el link", description: billingErrorMessage(r.error), variant: "error" });
                  }}
                >
                  <Link2 size={14} aria-hidden /> Generar link
                </Button>
              ) : undefined
            }
          >
            Desde el {formatDay(view.terms?.pending_since)}. Sigue en {modeLabel(view.stored_mode)} hasta el primer débito aprobado. El
            cliente también puede completarlo desde su panel.
            {link && <div className="mt-2"><CopyLink url={link} /></div>}
          </Callout>
        )}

        {failedCancel && (
          <Callout
            tone="danger"
            icon={CircleAlert}
            title="Falta cancelar el débito automático en Mercado Pago"
            className="mt-3"
            actions={
              canSetTerms ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={mc.retryCancel.isPending}
                  onClick={async () => {
                    const r = await mc.retryCancel.mutateAsync(failedCancel.id);
                    toast(
                      r.ok
                        ? { title: "Débito cancelado en Mercado Pago", variant: "success" }
                        : { title: "Mercado Pago no respondió", description: r.detail ?? undefined, variant: "error" },
                    );
                  }}
                >
                  <RefreshCw size={14} aria-hidden /> Reintentar
                </Button>
              ) : undefined
            }
          >
            El negocio ya está en {modeLabel(failedCancel.to_mode)}, pero el preapproval {failedCancel.mp_preapproval_id} puede volver a
            cobrar. {failedCancel.mp_detail ? `Último error: ${failedCancel.mp_detail}.` : ""} Si cobra, el pago entra a la cuenta
            corriente como saldo a favor.
          </Callout>
        )}
      </section>

      {(isAccount || view.reports.length > 0) && (
        <section>
          <SectionHeader
            title="Transferencias informadas"
            icon={Landmark}
            description={`Lo que ${tenantName} informó con Ya transferí.`}
          />
          <div className="mt-3">
            <TransferInbox reports={view.reports} accounts={data.bank_accounts} canOperate={canOperate} showTenant={false} />
          </div>
        </section>
      )}

      {(view.mode_changes.length > 0 || view.notices.length > 0) && (
        <section>
          <SectionHeader title="Historial de cobro" icon={FileClock} />
          <ol className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {[
              ...view.mode_changes.map((c) => ({ at: c.created_at, kind: "mode" as const, c })),
              ...view.notices.map((n) => ({ at: n.created_at, kind: "notice" as const, n })),
            ]
              .sort((a, b) => b.at.localeCompare(a.at))
              .slice(0, 25)
              .map((e) =>
                e.kind === "mode" ? (
                  <li key={`m-${e.c.id}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {modeLabel(e.c.from_mode)} <span aria-hidden>→</span> {modeLabel(e.c.to_mode)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {e.c.source === "invite_code" ? "Código de invitación" : (e.c.created_by_name ?? "Sistema")}
                        {e.c.reason ? ` · ${e.c.reason}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={CHANGE_STATUS[e.c.status].tone}>{CHANGE_STATUS[e.c.status].label}</Badge>
                      <time className="text-xs tabular-nums text-muted-foreground">{formatDay(e.c.created_at)}</time>
                    </div>
                  </li>
                ) : (
                  <li key={`n-${e.n.id}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {e.n.kind === "manual" ? "Aviso enviado a mano" : e.n.kind === "statement" ? "Resumen mensual" : "Aviso de cobro"} ·{" "}
                        <span className="tabular-nums">{formatCents(e.n.amount_cents)}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {e.n.due_date ? `Vence ${formatDay(e.n.due_date)} · ` : ""}A {e.n.recipients.join(", ")}
                      </p>
                    </div>
                    <time className="text-xs tabular-nums text-muted-foreground">{formatDay(e.n.created_at)}</time>
                  </li>
                ),
              )}
          </ol>
        </section>
      )}

      <ModeChangeModal open={modeOpen} onOpenChange={setModeOpen} tenantId={tenantId} view={view} isSuper={access?.role === "super_admin"} />
      <NoticeTermsModal open={noticeOpen} onOpenChange={setNoticeOpen} tenantId={tenantId} view={view} defaults={data.settings} />
      <ReasonDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        title="Enviar aviso de cobro ahora"
        description={`Le mandamos a ${view.recipients.join(", ") || "los dueños"} el saldo pendiente con los datos bancarios y a dónde mandar el comprobante.`}
        confirmLabel="Enviar aviso"
        loading={m.sendNotice.isPending}
        onConfirm={async (reason) => {
          try {
            const r = await m.sendNotice.mutateAsync({ tenantId, reason });
            toast({ title: `Aviso enviado por ${formatCents(r.amount_cents)}`, variant: "success" });
            setSendOpen(false);
          } catch (e) {
            toast({ title: "No se pudo enviar", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}
TenantCollectionPanel.displayName = "TenantCollectionPanel";
