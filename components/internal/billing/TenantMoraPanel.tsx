"use client";

// =============================================================================
// Ficha del negocio › Cuenta corriente › Mora y punitorios (F20-9 · ADR-128,
// spec docs/40 §10.3, §10.5, §11 y §14.4).
//   · Estado: días de atraso, vencido, punitorios, próximo paso de la escalera,
//     restricción y promesa vigente.
//   · Condonar (total o parcial) o saldar punitorios, con vista previa, motivo
//     y el tope del nivel (arriba del tope queda para un super admin). La NC
//     queda pendiente de H130 si lo condonado ya tenía ND.
//   · Promesa de pago (cargar, ampliar o cancelar).
//   · Admin: política y escalera propias, promesas del cliente y pausar el
//     devengamiento.
// =============================================================================

import { useMemo, useState } from "react";
import { CalendarClock, FileClock, Gavel, Hand, ListChecks, Pause, Percent, Play, ReceiptText, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { NoData } from "@/components/ui/NoData";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { LadderTimeline } from "@/components/internal/billing/MoraConfig";
import { formatCents, formatDay, parsePesosToCents, todayAR } from "@/lib/billing/ledger";
import { addDays, formatBp } from "@/lib/billing/interest";
import {
  COLLECTION_STATE_LABELS,
  COLLECTION_STATE_TONES,
  DUNNING_ACTION_LABELS,
  PROMISE_STATUS_LABELS,
  promiseWindow,
  validatePromise,
} from "@/lib/billing/mora";
import { newRequestId, type BillingAccess } from "@/modules/billing/ledger";
import { moraErrorMessage, useMoraConfig, useTenantMora, useTenantMoraMutations, type TenantMora } from "@/modules/billing/mora";

type View = "punitorios" | "promesas" | "escalera" | "condonaciones" | "fiscal";

const POLICY_SOURCE: Record<string, string> = { tenant: "propia del negocio", plan: "del plan", default: "por defecto" };
const FISCAL_LABELS: Record<string, string> = {
  interest_collected: "ND por punitorio cobrado",
  interest_month: "ND por punitorios del mes",
  interest_waiver: "NC por condonación",
};

function WaiveModal({
  open,
  onOpenChange,
  tenantId,
  mora,
  access,
  all,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  mora: TenantMora;
  access: BillingAccess | undefined;
  all: boolean;
}) {
  const { toast } = useToast();
  const m = useTenantMoraMutations(tenantId);
  const [mode, setMode] = useState<"total" | "parcial">(all ? "total" : "parcial");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newRequestId());
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setMode(all ? "total" : "parcial");
    setAmount("");
    setReason("");
    setRequestId(newRequestId());
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const open_ = mora.interest_open_cents;
  const cents = mode === "total" ? open_ : parsePesosToCents(amount);
  const cap = useMemo(() => access?.caps.find((c) => c.level === access.role) ?? null, [access]);
  const overCap = cap?.per_operation_cents != null && cents !== null && cents > cap.per_operation_cents;
  const amountOk = cents !== null && cents > 0 && cents <= open_;
  const monthlyNd = mora.fiscal_pending.some((f) => f.kind === "debit_note" && f.concept === "interest_month" && f.status !== "cancelled");

  async function submit() {
    if (!amountOk || reason.trim().length < 5) return;
    try {
      const w = await m.waive.mutateAsync({ movementIds: null, amountCents: mode === "total" ? null : cents, reason: reason.trim(), requestId });
      toast(
        w.status === "pending_approval"
          ? { title: "Quedó para aprobar", description: "Supera tu tope: la aprueba un super admin.", variant: "info" }
          : {
              title: "Punitorios condonados",
              description: w.credit_note_cents > 0 ? `NC por ${formatCents(w.credit_note_cents)} pendiente de la factura con CAE.` : undefined,
              variant: "success",
            },
      );
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo condonar", description: moraErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={all ? "Saldar punitorios" : "Condonar punitorios"}
      description="Crédito a cuenta contra los punitorios pendientes, del más viejo al más nuevo. Cuenta en el tope de bonificaciones de tu nivel."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!amountOk || reason.trim().length < 5} loading={m.waive.isPending}>
            {overCap ? "Pedir aprobación" : "Condonar"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented<"total" | "parcial">
          value={mode}
          onChange={setMode}
          fill
          aria-label="Cuánto"
          options={[
            { value: "total", label: "Todo" },
            { value: "parcial", label: "Una parte" },
          ]}
        />
        {mode === "parcial" && (
          <Input
            label="Importe a condonar ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={(open_ / 200).toFixed(2).replace(".", ",")}
            error={amount && !amountOk ? `Hasta ${formatCents(open_)}` : undefined}
            hint={`La mitad: ${formatCents(Math.floor(open_ / 2))}`}
          />
        )}
        <div className="rounded-lg bg-muted/60 p-3 text-sm">
          <p className="text-muted-foreground">Efecto</p>
          <p className="mt-1 font-semibold tabular-nums">
            Punitorios pendientes {formatCents(open_)} <span className="text-muted-foreground">pasan a</span>{" "}
            {formatCents(Math.max(0, open_ - (amountOk ? cents! : 0)))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {monthlyNd
              ? "Si lo condonado ya tenía nota de débito, queda la nota de crédito pendiente de emitir (H130)."
              : "Lo condonado nunca se facturó (la nota de débito sale al cobrarlo): no lleva nota de crédito."}
          </p>
        </div>
        {overCap && (
          <Callout tone="warning" icon={Hand} title="Supera tu tope por operación">
            Queda registrada para que la apruebe un super admin; el saldo no cambia hasta entonces.
          </Callout>
        )}
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: acordamos condonar la mitad por la demora del soporte" />
      </div>
    </Modal>
  );
}

function PromiseModal({
  open,
  onOpenChange,
  tenantId,
  mora,
  balanceCents,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  mora: TenantMora;
  balanceCents: number;
}) {
  const { toast } = useToast();
  const m = useTenantMoraMutations(tenantId);
  const today = todayAR();
  const maxDays = mora.settings.promise_staff_max_days;
  const w = promiseWindow(today, maxDays);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(addDays(today, 7));
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setAmount(mora.debt.overdue_cents > 0 ? String(mora.debt.overdue_cents / 100).replace(".", ",") : "");
    setDate(addDays(today, Math.min(7, maxDays)));
    setNote("");
    setReason("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const cents = parsePesosToCents(amount) ?? 0;
  const err = validatePromise({ today, date, amountCents: cents, balanceCents, maxDays });
  async function submit() {
    if (err || reason.trim().length < 5) return;
    try {
      await m.createPromise.mutateAsync({ amountCents: cents, date, note: note.trim() || null, reason: reason.trim() });
      toast({ title: "Promesa cargada", description: "La restricción y la suspensión quedan en pausa hasta esa fecha.", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo cargar", description: moraErrorMessage(e), variant: "error" });
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Promesa de pago"
      description={`Monto y fecha (hasta ${maxDays} días). Mientras esté vigente, la escalera no restringe ni suspende; los avisos siguen saliendo.`}
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={Boolean(err) || reason.trim().length < 5} loading={m.createPromise.isPending}>
            Cargar promesa
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Importe ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={amount && err === "invalid_amount" ? `Hasta ${formatCents(balanceCents)}` : undefined} />
          <Input label="Paga el" type="date" min={w.min} max={w.max} value={date} onChange={(e) => setDate(e.target.value)} error={err === "invalid_promise_date" ? `Entre ${formatDay(w.min)} y ${formatDay(w.max)}` : undefined} />
        </div>
        <Input label="Nota (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: cobra los clientes el jueves" />
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: hablé con el dueño por WhatsApp" />
      </div>
    </Modal>
  );
}

function TermsModal({ open, onOpenChange, tenantId, mora }: { open: boolean; onOpenChange: (o: boolean) => void; tenantId: string; mora: TenantMora }) {
  const { toast } = useToast();
  const m = useTenantMoraMutations(tenantId);
  const { data: cfg } = useMoraConfig(open);
  const [policy, setPolicy] = useState<string>("__inherit");
  const [ladder, setLadder] = useState<string>("__inherit");
  const [selfPromise, setSelfPromise] = useState<string>("__inherit");
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setPolicy(mora.terms.interest_policy_id ?? "__inherit");
    setLadder(mora.terms.dunning_ladder_id ?? "__inherit");
    setSelfPromise(mora.terms.self_promise_enabled === null ? "__inherit" : mora.terms.self_promise_enabled ? "yes" : "no");
    setReason("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  async function submit() {
    try {
      await m.setTerms.mutateAsync({
        data: {
          interest_policy_id: policy === "__inherit" ? null : policy,
          dunning_ladder_id: ladder === "__inherit" ? null : ladder,
          self_promise_enabled: selfPromise === "__inherit" ? null : selfPromise === "yes",
        },
        reason: reason.trim(),
      });
      toast({ title: "Condiciones de mora guardadas", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudieron guardar", description: moraErrorMessage(e), variant: "error" });
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Mora de este negocio"
      description="Vacío: hereda lo del plan o lo de la plataforma. Un cambio de política rige para las deudas que empiecen a devengar."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={reason.trim().length < 5} loading={m.setTerms.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="Política de punitorios"
          value={policy}
          onChange={setPolicy}
          options={[
            { value: "__inherit", label: "Heredar (plan o por defecto)" },
            ...(cfg?.policies ?? []).filter((p) => !p.archived_at).map((p) => ({ value: p.id, label: `${p.name} · ${formatBp(p.monthly_rate_bp)}` })),
          ]}
        />
        <Select
          label="Escalera de mora"
          value={ladder}
          onChange={setLadder}
          options={[
            { value: "__inherit", label: "Heredar (por defecto)" },
            ...(cfg?.ladders ?? []).filter((l) => !l.archived_at && l.is_active).map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <Select
          label="El cliente puede cargar su promesa"
          value={selfPromise}
          onChange={setSelfPromise}
          options={[
            { value: "__inherit", label: "Heredar de la plataforma" },
            { value: "yes", label: "Sí" },
            { value: "no", label: "No, sólo el staff" },
          ]}
        />
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: cliente corporativo, escalera más larga" />
      </div>
    </Modal>
  );
}

export function TenantMoraPanel({
  tenantId,
  access,
  balanceCents,
}: {
  tenantId: string;
  access: BillingAccess | undefined;
  balanceCents: number;
}) {
  const { toast } = useToast();
  const { data: mo, isLoading, error } = useTenantMora(tenantId);
  const m = useTenantMoraMutations(tenantId);
  const [view, setView] = useState<View>("punitorios");
  const [modal, setModal] = useState<null | "condonar" | "saldar" | "promesa" | "terminos">(null);
  const [promiseAction, setPromiseAction] = useState<null | "extend" | "cancel">(null);
  const [extendDate, setExtendDate] = useState("");
  const [pauseTo, setPauseTo] = useState<boolean | null>(null);
  const canOperate = Boolean(access?.can_operate);
  const canTerms = Boolean(access?.can_set_terms);
  const executed = useMemo(() => new Set(mo?.executed_step_ids ?? []), [mo]);

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;
  // Sin la migración (o sin permiso) no rompe la ficha.
  if (error || !mo) return null;

  const state = mo.exclusion ? "al_dia" : mo.status?.state ?? (mo.debt.overdue_cents > 0 ? "vencida" : "al_dia");
  const paused = mo.terms.interest_enabled === false;
  const interestOn = mo.settings.interest_enabled && (mo.billing_mode !== "mp_subscription" || mo.settings.interest_on_mp);
  const today = todayAR();

  return (
    <section className="space-y-4" aria-labelledby="mora-ficha">
      <SectionHeader
        title={<span id="mora-ficha">Mora y punitorios</span>}
        icon={Gavel}
        description="Escalera de mora, punitorios devengados, promesas y condonaciones. Todo queda en la historia."
        actions={<Badge tone={COLLECTION_STATE_TONES[state]}>{COLLECTION_STATE_LABELS[state]}</Badge>}
      />

      {mo.exclusion ? (
        <Callout tone="neutral" icon={Gavel} title="Sin mora ni punitorios">
          Este negocio no se cobra: no devenga punitorios ni entra en la escalera.
        </Callout>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm lg:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Atraso</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {mo.debt.overdue_cents > 0 ? `${mo.debt.days_overdue} días` : "Al día"}
              </dd>
              {mo.debt.oldest_due && mo.debt.effective_due !== mo.debt.oldest_due && (
                <dd className="text-xs text-muted-foreground">Vencía {formatDay(mo.debt.oldest_due)}, corrido al {formatDay(mo.debt.effective_due)}</dd>
              )}
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Vencido</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{formatCents(mo.debt.overdue_cents)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Punitorios pendientes</dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{formatCents(mo.interest_open_cents)}</dd>
              <dd className="truncate text-xs text-muted-foreground">
                {!interestOn ? "Punitorios apagados" : paused ? "Devengamiento pausado" : mo.policy ? `${mo.policy.name} (${POLICY_SOURCE[mo.policy_source ?? ""] ?? ""})` : "Sin política"}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Próximo paso</dt>
              <dd className="mt-0.5 font-semibold">
                {mo.next_step ? `${DUNNING_ACTION_LABELS[mo.next_step.action]} · ${formatDay(mo.next_step.date)}` : <NoData />}
              </dd>
              {mo.status?.soft_restricted && <dd className="text-xs text-warning">Con restricción parcial</dd>}
            </div>
          </dl>

          {mo.promise && (
            <Callout tone="info" icon={Hand} title={`Promete pagar ${formatCents(mo.promise.amount_cents)} el ${formatDay(mo.promise.promised_date)}`}>
              Cargada por {mo.promise.channel === "owner" ? "el dueño" : "el staff"}
              {mo.promise.note ? ` · ${mo.promise.note}` : ""}. La restricción y la suspensión quedan en pausa.
              {canOperate && (
                <span className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => { setExtendDate(addDays(today, 7)); setPromiseAction("extend"); }}>
                    Ampliar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPromiseAction("cancel")}>
                    Cancelar promesa
                  </Button>
                </span>
              )}
            </Callout>
          )}

          <div className="flex flex-wrap gap-2">
            {canOperate && (
              <>
                <Button variant="secondary" onClick={() => setModal("condonar")} disabled={mo.interest_open_cents <= 0}>
                  <Percent size={16} aria-hidden /> Condonar punitorios
                </Button>
                <Button variant="secondary" onClick={() => setModal("saldar")} disabled={mo.interest_open_cents <= 0}>
                  <ReceiptText size={16} aria-hidden /> Saldar punitorios
                </Button>
                {!mo.promise && (
                  <Button variant="secondary" onClick={() => setModal("promesa")} disabled={balanceCents <= 0}>
                    <Hand size={16} aria-hidden /> Promesa de pago
                  </Button>
                )}
              </>
            )}
            {canTerms && (
              <>
                <Button variant="ghost" onClick={() => setModal("terminos")}>
                  <Settings2 size={16} aria-hidden /> Política y escalera
                </Button>
                <Button variant="ghost" onClick={() => setPauseTo(!paused)}>
                  {paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />} {paused ? "Reanudar punitorios" : "Pausar punitorios"}
                </Button>
              </>
            )}
          </div>

          {mo.ladder && (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-3 text-sm font-medium">
                Escalera: {mo.ladder.name}
                {mo.debt.effective_due ? (
                  <span className="font-normal text-muted-foreground"> · días desde el {formatDay(mo.debt.effective_due)}</span>
                ) : null}
              </p>
              <LadderTimeline steps={mo.ladder.steps} executed={executed} />
            </div>
          )}

          <Segmented<View>
            value={view}
            onChange={setView}
            scrollOnMobile
            aria-label="Detalle de mora"
            options={[
              { value: "punitorios", label: "Punitorios", icon: <Percent size={15} /> },
              { value: "promesas", label: "Promesas", icon: <Hand size={15} /> },
              { value: "escalera", label: "Pasos", icon: <ListChecks size={15} /> },
              { value: "condonaciones", label: "Condonaciones", icon: <ReceiptText size={15} /> },
              { value: "fiscal", label: "Pendientes H130", icon: <FileClock size={15} /> },
            ]}
          />

          {view === "punitorios" &&
            (mo.accruals.length === 0 ? (
              <EmptyState compact icon={Percent} title="Sin punitorios" description="Se devengan solos sobre la deuda vencida cuando los punitorios están prendidos." />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {mo.accruals.map((a) => (
                  <li key={a.charge_id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="font-medium">{a.description}</p>
                      <p className="font-semibold tabular-nums">{formatCents(a.posted_cents)}</p>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatCents(a.original_cents)} vencido el {formatDay(a.effective_due)} · {a.policy.name} ({formatBp(a.policy.monthly_rate_bp)}) ·
                      devenga desde el {formatDay(a.accrue_from)}
                      {a.pending_cents > 0 ? ` · ${formatCents(a.pending_cents)} sin llegar al mínimo` : ""}
                      {a.cap_reached ? " · llegó al tope" : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ))}

          {view === "promesas" &&
            (mo.promises.length === 0 ? (
              <EmptyState compact icon={Hand} title="Sin promesas" />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {mo.promises.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium tabular-nums">{formatCents(p.amount_cents)}</span> el {formatDay(p.promised_date)}
                      <span className="block text-xs text-muted-foreground">
                        {p.channel === "owner" ? "Dueño" : p.created_by_name ?? "Staff"} · {formatDay(p.created_at)}
                        {p.extended_count > 0 ? ` · ampliada ${p.extended_count} vez${p.extended_count === 1 ? "" : "es"}` : ""}
                      </span>
                    </span>
                    <Badge tone={p.status === "kept" ? "success" : p.status === "broken" ? "danger" : p.status === "open" ? "info" : "neutral"}>
                      {PROMISE_STATUS_LABELS[p.status]}
                    </Badge>
                  </li>
                ))}
              </ul>
            ))}

          {view === "escalera" &&
            (mo.events.length === 0 ? (
              <EmptyState compact icon={CalendarClock} title="La escalera no ejecutó pasos" />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {mo.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{DUNNING_ACTION_LABELS[e.action]}</span> · {e.title}
                      <span className="block text-xs text-muted-foreground">
                        {new Date(e.executed_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })} · {e.days_overdue} días ·{" "}
                        {formatCents(e.due_cents)}
                        {e.notified ? " · avisó al cliente" : ""}
                      </span>
                    </span>
                    {e.closed_at ? <Badge tone="neutral">Deuda saldada</Badge> : <Badge tone="warning">Vigente</Badge>}
                  </li>
                ))}
              </ul>
            ))}

          {view === "condonaciones" &&
            (mo.waivers.length === 0 ? (
              <EmptyState compact icon={ReceiptText} title="Sin condonaciones" />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {mo.waivers.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium tabular-nums">{formatCents(w.applied_cents ?? w.amount_cents)}</span> · {w.reason}
                      <span className="block text-xs text-muted-foreground">
                        {w.requested_by_name ?? "Staff"} · {formatDay(w.created_at)}
                        {w.credit_note_cents > 0 ? ` · NC ${formatCents(w.credit_note_cents)} pendiente (H130)` : ""}
                        {w.decided_by_name ? ` · resolvió ${w.decided_by_name}` : ""}
                      </span>
                    </span>
                    <Badge tone={w.status === "applied" ? "success" : w.status === "rejected" ? "neutral" : "warning"}>
                      {w.status === "applied" ? "Aplicada" : w.status === "rejected" ? "Rechazada" : "Para aprobar"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ))}

          {view === "fiscal" &&
            (mo.fiscal_pending.length === 0 ? (
              <EmptyState compact icon={FileClock} title="Nada pendiente" description="Las ND por punitorios y las NC por condonaciones quedan acá hasta la factura con CAE (H130)." />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {mo.fiscal_pending.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{FISCAL_LABELS[f.concept] ?? f.concept}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDay(f.created_at)}
                        {f.period_month ? ` · ${f.period_month.slice(5, 7)}/${f.period_month.slice(0, 4)}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatCents(f.kind === "credit_note" ? -f.amount_cents : f.amount_cents)}</span>
                      <Badge tone={f.status === "pending_h130" ? "warning" : f.status === "issued" ? "success" : "neutral"}>
                        {f.status === "pending_h130" ? "Pendiente H130" : f.status === "issued" ? "Emitida" : "Cancelada"}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}

      <WaiveModal open={modal === "condonar" || modal === "saldar"} all={modal === "saldar"} onOpenChange={(o) => !o && setModal(null)} tenantId={tenantId} mora={mo} access={access} />
      <PromiseModal open={modal === "promesa"} onOpenChange={(o) => !o && setModal(null)} tenantId={tenantId} mora={mo} balanceCents={balanceCents} />
      <TermsModal open={modal === "terminos"} onOpenChange={(o) => !o && setModal(null)} tenantId={tenantId} mora={mo} />

      <ReasonDialog
        open={promiseAction !== null}
        onOpenChange={(o) => !o && setPromiseAction(null)}
        title={promiseAction === "extend" ? "Ampliar promesa" : "Cancelar promesa"}
        description={promiseAction === "cancel" ? "La escalera retoma desde donde estaba." : `Hasta ${mo.settings.promise_staff_max_days} días desde hoy.`}
        confirmLabel={promiseAction === "extend" ? "Ampliar" : "Cancelar promesa"}
        danger={promiseAction === "cancel"}
        loading={m.updatePromise.isPending}
        extra={
          promiseAction === "extend" ? (
            <Input
              label="Nueva fecha"
              type="date"
              min={addDays(today, 1)}
              max={addDays(today, mo.settings.promise_staff_max_days)}
              value={extendDate}
              onChange={(e) => setExtendDate(e.target.value)}
            />
          ) : undefined
        }
        onConfirm={async (reason) => {
          if (!mo.promise || !promiseAction) return;
          try {
            await m.updatePromise.mutateAsync({ promiseId: mo.promise.id, action: promiseAction, date: promiseAction === "extend" ? extendDate : null, reason });
            toast({ title: promiseAction === "extend" ? "Promesa ampliada" : "Promesa cancelada", variant: "success" });
            setPromiseAction(null);
          } catch (e) {
            toast({ title: "No se pudo actualizar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
      <ReasonDialog
        open={pauseTo !== null}
        onOpenChange={(o) => !o && setPauseTo(null)}
        title={pauseTo ? "Pausar punitorios" : "Reanudar punitorios"}
        description={pauseTo ? "Desde mañana no devenga (por ejemplo, por un reclamo en curso). Lo ya devengado queda." : "Vuelve a devengar desde mañana. Los días pausados no se cobran."}
        confirmLabel={pauseTo ? "Pausar" : "Reanudar"}
        loading={m.pause.isPending}
        onConfirm={async (reason) => {
          if (pauseTo === null) return;
          try {
            await m.pause.mutateAsync({ paused: pauseTo, reason });
            toast({ title: pauseTo ? "Punitorios pausados" : "Punitorios reanudados", variant: "success" });
            setPauseTo(null);
          } catch (e) {
            toast({ title: "No se pudo cambiar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}
TenantMoraPanel.displayName = "TenantMoraPanel";
