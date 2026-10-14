"use client";

// Modales de operación de la cuenta corriente de la plataforma (F20-1 ·
// ADR-113). Cada uno pide motivo (queda en la auditoría) y muestra el efecto
// sobre el saldo antes de confirmar. El servidor valida rol y topes: la UI
// sólo anticipa.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { Info } from "lucide-react";
import {
  BILLING_MODE_LABELS,
  billingErrorMessage,
  formatCents,
  parsePesosToCents,
  todayAR,
} from "@/lib/billing/ledger";
import { newRequestId, useLedgerMutations, type BillingAccess, type BillingStatement } from "@/modules/billing/ledger";

const MIN_REASON = 5;
const MAX_REASON = 500;

export function ReasonField({
  value,
  onChange,
  label = "Motivo (queda en la auditoría)",
  placeholder = "Ej.: transferencia informada por WhatsApp el 10/10",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const len = value.trim().length;
  return (
    <div>
      <label htmlFor="ledger-reason" className="mb-2 block text-sm font-medium text-muted-foreground">
        {label}
      </label>
      <textarea
        id="ledger-reason"
        rows={3}
        maxLength={MAX_REASON}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Mínimo {MIN_REASON} caracteres. <span className="tabular-nums">{len}/{MAX_REASON}</span>
      </p>
    </div>
  );
}

const reasonOk = (r: string) => r.trim().length >= MIN_REASON && r.trim().length <= MAX_REASON;

/** "Saldo pasa de X a Y" con el efecto previsto. */
function BalancePreview({ from, to }: { from: number; to: number }) {
  return (
    <div className="rounded-lg bg-muted/60 p-3 text-sm">
      <p className="text-muted-foreground">Efecto en la cuenta</p>
      <p className="mt-1 font-semibold tabular-nums">
        Saldo {formatCents(from)} <span className="text-muted-foreground">pasa a</span> {formatCents(to)}
      </p>
      {to < 0 && <p className="mt-1 text-xs text-muted-foreground">Queda saldo a favor: se aplica solo al próximo cargo.</p>}
    </div>
  );
}

function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ── Registrar pago ──────────────────────────────────────────────────────────

type Method = "transfer" | "cash" | "mp" | "other";
const METHODS: { value: Method; label: string }[] = [
  { value: "transfer", label: "Transferencia" },
  { value: "cash", label: "Efectivo" },
  { value: "mp", label: "Mercado Pago" },
  { value: "other", label: "Otro" },
];

export function RegisterPaymentModal({
  open,
  onOpenChange,
  tenantId,
  statement,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  statement: BillingStatement;
}) {
  const { toast } = useToast();
  const m = useLedgerMutations(tenantId);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("transfer");
  const [paidOn, setPaidOn] = useState(todayAR());
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  useResetOnOpen(open, () => {
    setAmount(statement.overdue_cents > 0 ? String(statement.overdue_cents / 100).replace(".", ",") : "");
    setMethod("transfer");
    setPaidOn(todayAR());
    setReference("");
    setReason("");
  });
  const cents = parsePesosToCents(amount);
  const refMissing = method === "mp" && !reference.trim();
  const can = cents !== null && reasonOk(reason) && !refMissing && !m.registerPayment.isPending;

  async function submit() {
    if (!can || cents === null) return;
    try {
      await m.registerPayment.mutateAsync({
        amountCents: cents,
        method,
        paidOn,
        reference: reference.trim() || null,
        reason: reason.trim(),
      });
      toast({ title: "Pago registrado", description: "Se imputó a la deuda más vieja.", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar el pago", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Registrar pago"
      description="Para pagos que no entran solos: transferencias, efectivo o un pago de Mercado Pago fuera del débito automático."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!can} loading={m.registerPayment.isPending}>
            Registrar pago
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Importe ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            error={amount && cents === null ? "Importe inválido" : undefined}
          />
          <Input label="Fecha del pago" type="date" value={paidOn} max={todayAR()} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Medio</p>
          <Segmented<Method> value={method} onChange={setMethod} options={METHODS} fill aria-label="Medio de pago" />
        </div>
        <Input
          label={method === "mp" ? "Número de operación de Mercado Pago" : "Referencia (opcional)"}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={method === "mp" ? "Ej.: 1234567890" : "Ej.: número de comprobante"}
          hint={method === "mp" ? "Evita registrar dos veces un pago que ya entró por el webhook." : undefined}
        />
        <ReasonField value={reason} onChange={setReason} />
        {cents !== null && <BalancePreview from={statement.balance_cents} to={statement.balance_cents - cents} />}
      </div>
    </Modal>
  );
}

// ── Bonificar ───────────────────────────────────────────────────────────────

export function BonusModal({
  open,
  onOpenChange,
  tenantId,
  statement,
  access,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  statement: BillingStatement;
  access: BillingAccess | undefined;
}) {
  const { toast } = useToast();
  const m = useLedgerMutations(tenantId);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newRequestId());
  useResetOnOpen(open, () => {
    setAmount("");
    setReason("");
    setRequestId(newRequestId());
  });
  const cents = parsePesosToCents(amount);
  const cap = useMemo(() => access?.caps.find((c) => c.level === access.role) ?? null, [access]);
  const overOp = cap?.per_operation_cents != null && cents !== null && cents > cap.per_operation_cents;
  const can = cents !== null && reasonOk(reason) && !overOp && !m.bonus.isPending;

  async function submit() {
    if (!can || cents === null) return;
    try {
      await m.bonus.mutateAsync({ amountCents: cents, reason: reason.trim(), requestId });
      toast({ title: "Bonificación registrada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo bonificar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Bonificar"
      description="Crédito a cuenta por decisión comercial. Se imputa a la deuda más vieja o queda a favor para el próximo cargo."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!can} loading={m.bonus.isPending}>
            Bonificar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {cap && (
          <Callout tone="neutral" icon={Info} title="Tu tope">
            {cap.per_operation_cents == null && cap.per_month_cents == null
              ? "Sin tope para tu nivel."
              : `${cap.per_operation_cents == null ? "Sin tope" : formatCents(cap.per_operation_cents)} por operación y ${
                  cap.per_month_cents == null ? "sin tope" : formatCents(cap.per_month_cents)
                } por mes en este negocio (bonificaciones, anulaciones y ajustes a favor).`}
          </Callout>
        )}
        <Input
          label="Importe ($)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0,00"
          error={
            amount && cents === null ? "Importe inválido" : overOp ? "Supera tu tope por operación" : undefined
          }
        />
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: compensación por la caída del 12/10" />
        {cents !== null && <BalancePreview from={statement.balance_cents} to={statement.balance_cents - cents} />}
      </div>
    </Modal>
  );
}

// ── Cargo manual (ajuste al debe) ───────────────────────────────────────────

export function ChargeModal({
  open,
  onOpenChange,
  tenantId,
  statement,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  statement: BillingStatement;
}) {
  const { toast } = useToast();
  const m = useLedgerMutations(tenantId);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(todayAR());
  const [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(newRequestId());
  useResetOnOpen(open, () => {
    setDescription("");
    setAmount("");
    setDue(todayAR());
    setReason("");
    setRequestId(newRequestId());
  });
  const cents = parsePesosToCents(amount);
  const descOk = description.trim().length >= 3 && description.trim().length <= 140;
  const can = cents !== null && descOk && reasonOk(reason) && !m.addCharge.isPending;

  async function submit() {
    if (!can || cents === null) return;
    try {
      await m.addCharge.mutateAsync({ amountCents: cents, description: description.trim(), dueDate: due || null, reason: reason.trim(), requestId });
      toast({ title: "Cargo agregado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo agregar el cargo", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cargo manual"
      description="Un ajuste al debe (por ejemplo, una capacitación o un servicio extra). Precio con IVA incluido."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!can} loading={m.addCharge.isPending}>
            Agregar cargo
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Concepto (lo ve el cliente)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={140}
          placeholder="Ej.: Capacitación de equipo"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Importe ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0,00"
            error={amount && cents === null ? "Importe inválido" : undefined}
          />
          <Input label="Vence" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: acordado con el dueño por email" />
        {cents !== null && <BalancePreview from={statement.balance_cents} to={statement.balance_cents + cents} />}
      </div>
    </Modal>
  );
}

// ── Condiciones de cobro ────────────────────────────────────────────────────

type ModeValue = "auto" | "mp_subscription" | "account" | "manual" | "exempt";

export function TermsModal({
  open,
  onOpenChange,
  tenantId,
  statement,
  access,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  statement: BillingStatement;
  access: BillingAccess | undefined;
}) {
  const { toast } = useToast();
  const m = useLedgerMutations(tenantId);
  const [mode, setMode] = useState<ModeValue>("auto");
  const [exemptReason, setExemptReason] = useState("");
  const [dueDays, setDueDays] = useState("");
  const [reason, setReason] = useState("");
  useResetOnOpen(open, () => {
    setMode((statement.terms?.billing_mode as ModeValue | null) ?? "auto");
    setExemptReason(statement.terms?.exempt_reason ?? "");
    setDueDays(statement.terms?.due_days != null ? String(statement.terms.due_days) : "");
    setReason("");
  });
  const isSuper = access?.role === "super_admin";
  const days = dueDays.trim() === "" ? null : Number(dueDays);
  const daysOk = days === null || (Number.isInteger(days) && days >= 0 && days <= 60);
  const exemptOk = mode !== "exempt" || exemptReason.trim().length >= 5;
  const can = daysOk && exemptOk && reasonOk(reason) && !m.setTerms.isPending;

  const options = [
    { value: "auto" as const, label: "Automática", description: "Débito con Mercado Pago si tiene suscripción en MP; si no, manual." },
    { value: "mp_subscription" as const, label: BILLING_MODE_LABELS.mp_subscription! },
    { value: "account" as const, label: BILLING_MODE_LABELS.account!, description: "Paga por transferencia contra aviso de cobro." },
    { value: "manual" as const, label: BILLING_MODE_LABELS.manual!, description: "El staff registra cada pago." },
    {
      value: "exempt" as const,
      label: BILLING_MODE_LABELS.exempt!,
      description: isSuper ? "No se le generan cargos y no cuenta en los KPIs." : "Sólo un super admin puede marcarlo.",
      disabled: !isSuper,
    },
  ];

  async function submit() {
    if (!can) return;
    try {
      await m.setTerms.mutateAsync({
        mode: mode === "auto" ? null : mode,
        exemptReason: mode === "exempt" ? exemptReason.trim() : null,
        dueDays: days,
        reason: reason.trim(),
      });
      toast({ title: "Condiciones guardadas", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudieron guardar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Condiciones de cobro"
      description="Cómo paga este negocio y cuántos días tiene para pagar cada cargo."
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!can} loading={m.setTerms.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select<ModeValue> label="Modalidad" value={mode} options={options} onChange={setMode} />
        {mode === "exempt" && (
          <Input
            label="Motivo de la exención"
            value={exemptReason}
            onChange={(e) => setExemptReason(e.target.value)}
            placeholder="Ej.: cortesía por ser socio fundador"
          />
        )}
        <Input
          label="Plazo de pago (días desde el inicio del período)"
          inputMode="numeric"
          value={dueDays}
          onChange={(e) => setDueDays(e.target.value.replace(/[^\d]/g, ""))}
          placeholder="Por defecto de la plataforma"
          error={daysOk ? undefined : "De 0 a 60 días"}
          hint="Vacío: usa el plazo por defecto. Rige para los cargos que se generen desde ahora."
        />
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: pasa a pagar por transferencia mensual" />
      </div>
    </Modal>
  );
}
