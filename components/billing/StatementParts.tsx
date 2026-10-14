"use client";

// =============================================================================
// Piezas del estado de cuenta de la plataforma (F20-1 · ADR-113), compartidas
// por el panel interno (pestaña "Cuenta corriente") y el panel del cliente
// ("Mi suscripción > Estado de cuenta"). Presentacionales: reciben los datos
// ya cargados por las RPC.
// =============================================================================

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { CalendarClock, ChevronDown, CircleAlert, PiggyBank, Wallet } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { NoData } from "@/components/ui/NoData";
import { InfoHint } from "@/components/ui/InfoHint";
import {
  CHARGE_KIND_LABELS,
  CHARGE_STATUS_LABELS,
  MOVEMENT_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  daysOverdue,
  formatCents,
  formatDay,
  formatPeriod,
} from "@/lib/billing/ledger";
import type { BillingStatement, LedgerCharge, LedgerMovement, LedgerPayment } from "@/modules/billing/ledger";

// ── Resumen ─────────────────────────────────────────────────────────────────

function SummaryTile({
  icon: Icon,
  label,
  value,
  sub,
  tone = "default",
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: "default" | "danger" | "success";
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Icon size={15} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium">{label}</span>
        {hint && (
          <InfoHint title={label} label={`Qué es ${label}`} size={14} className="ml-auto">
            <p className="font-display text-sm font-bold">{label}</p>
            <p className="mt-1.5 text-muted-foreground">{hint}</p>
          </InfoHint>
        )}
      </div>
      <p
        title={value}
        className={cn(
          "mt-2 min-w-0 truncate font-display text-lg font-black tabular-nums leading-tight sm:text-2xl",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
      {sub && <div className="mt-1 line-clamp-2 min-w-0 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function StatementSummary({ s }: { s: BillingStatement }) {
  const mora = daysOverdue(s.oldest_due_date, s.as_of);
  const balanceLabel = s.balance_cents > 0 ? "Saldo a pagar" : s.balance_cents < 0 ? "Saldo a favor" : "Saldo";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <SummaryTile
        icon={Wallet}
        label={balanceLabel}
        value={formatCents(Math.abs(s.balance_cents))}
        tone={s.balance_cents <= 0 ? "success" : "default"}
        sub={s.balance_cents === 0 ? "Al día" : s.balance_cents < 0 ? "Se descuenta del próximo cobro" : "Cargos menos pagos y bonificaciones"}
        hint="Suma de todos los cargos menos los pagos, bonificaciones y anulaciones."
      />
      <SummaryTile
        icon={CircleAlert}
        label="Vencido"
        value={formatCents(s.overdue_cents)}
        tone={s.overdue_cents > 0 ? "danger" : "default"}
        sub={s.overdue_cents > 0 ? `${mora} ${mora === 1 ? "día" : "días"} desde el vencimiento más viejo` : "Nada vencido"}
        hint="Lo que quedó sin pagar de los cargos cuyo vencimiento ya pasó."
      />
      <SummaryTile
        icon={CalendarClock}
        label="A vencer"
        value={formatCents(s.upcoming_cents)}
        sub={s.next_due ? `Próximo: ${formatCents(s.next_due.cents)} el ${formatDay(s.next_due.date)}` : "Sin vencimientos pendientes"}
        hint="Cargos que todavía no vencieron (incluye el prorrateo por cambio de plan, que vence con el próximo cobro)."
      />
      <SummaryTile
        icon={PiggyBank}
        label="A favor"
        value={formatCents(s.credit_cents)}
        tone={s.credit_cents > 0 ? "success" : "default"}
        sub={s.credit_cents > 0 ? "Se aplica solo al próximo cargo" : "Sin saldo a favor"}
        hint="Pagos o bonificaciones que todavía no se imputaron a ningún cargo."
      />
    </div>
  );
}

const AGING = [
  { key: "d1_30", label: "1 a 30 días", cls: "bg-warning" },
  { key: "d31_60", label: "31 a 60 días", cls: "bg-ninja-flameSoft" },
  { key: "d61_90", label: "61 a 90 días", cls: "bg-danger/70" },
  { key: "d90_plus", label: "Más de 90 días", cls: "bg-danger" },
] as const;

/** Deuda vencida por antigüedad: barra plana segmentada y leyenda. */
export function AgingBar({
  aging,
  className,
}: {
  aging: { d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  className?: string;
}) {
  const total = AGING.reduce((s, a) => s + Number(aging[a.key] ?? 0), 0);
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Vencido por antigüedad</p>
        <p className="text-sm tabular-nums text-muted-foreground">{formatCents(total)}</p>
      </div>
      <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Deuda vencida por antigüedad">
        {total > 0 &&
          AGING.map((a) => {
            const v = Number(aging[a.key] ?? 0);
            if (v <= 0) return null;
            return <span key={a.key} className={cn("h-full", a.cls)} style={{ width: `${(v / total) * 100}%` }} />;
          })}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {AGING.map((a) => (
          <div key={a.key} className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", a.cls)} aria-hidden />
              {a.label}
            </dt>
            <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">{formatCents(Number(aging[a.key] ?? 0))}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ── Estados ─────────────────────────────────────────────────────────────────

const CHARGE_TONE: Record<string, BadgeTone> = {
  open: "warning",
  partially_paid: "info",
  paid: "success",
  voided: "neutral",
  written_off: "neutral",
};

export function ChargeStatusBadge({ charge, today }: { charge: LedgerCharge; today: string }) {
  const overdue = (charge.status === "open" || charge.status === "partially_paid") && charge.due_date < today;
  return (
    <Badge tone={overdue ? "danger" : CHARGE_TONE[charge.status] ?? "neutral"}>
      {overdue ? "Vencido" : CHARGE_STATUS_LABELS[charge.status] ?? charge.status}
    </Badge>
  );
}

const PAYMENT_TONE: Record<string, BadgeTone> = {
  approved: "success",
  pending_verification: "warning",
  rejected: "danger",
  refunded: "neutral",
  partially_refunded: "neutral",
  charged_back: "danger",
  in_dispute: "warning",
};

export function PaymentStatusBadge({ status }: { status: string }) {
  return <Badge tone={PAYMENT_TONE[status] ?? "neutral"}>{PAYMENT_STATUS_LABELS[status] ?? status}</Badge>;
}

// ── Movimientos ─────────────────────────────────────────────────────────────

function Amount({ cents }: { cents: number }) {
  return (
    <span className={cn("tabular-nums", cents < 0 ? "text-success" : "text-foreground")}>
      {formatCents(cents, { signed: true })}
    </span>
  );
}

/** Movimientos con saldo corrido. En el celular, una tarjeta por movimiento. */
export function MovementsList({ movements, staff = false }: { movements: LedgerMovement[]; staff?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
            <th className="px-4 py-3 font-medium">Fecha</th>
            <th className="px-4 py-3 font-medium">Concepto</th>
            <th className="px-4 py-3 text-right font-medium">Debe</th>
            <th className="px-4 py-3 text-right font-medium">Haber</th>
            <th className="px-4 py-3 text-right font-medium">Saldo</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className="border-b border-border/60 last:border-0 align-top">
              <td className="whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground">{formatDay(m.effective_date)}</td>
              <td className="px-4 py-3">
                <p className="font-medium">{m.description}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {MOVEMENT_LABELS[m.kind] ?? m.kind}
                  {m.amount_cents > 0 && m.due_date ? ` · vence ${formatDay(m.due_date)}` : ""}
                  {m.amount_cents > 0 && m.open_cents > 0 ? ` · pendiente ${formatCents(m.open_cents)}` : ""}
                  {staff && m.created_by_name ? ` · ${m.created_by_name}` : ""}
                </p>
                {staff && m.reason && <p className="mt-1 text-xs text-muted-foreground">Motivo: {m.reason}</p>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                {m.amount_cents > 0 ? formatCents(m.amount_cents) : <NoData />}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-success">
                {m.amount_cents < 0 ? formatCents(-m.amount_cents) : <NoData />}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">{formatCents(m.balance_after_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border md:hidden">
        {movements.map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-medium">{m.description}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDay(m.effective_date)} · {MOVEMENT_LABELS[m.kind] ?? m.kind}
              </p>
              {staff && m.reason && <p className="mt-1 text-xs text-muted-foreground">Motivo: {m.reason}</p>}
            </div>
            <div className="shrink-0 text-right text-sm">
              <Amount cents={m.amount_cents} />
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">Saldo {formatCents(m.balance_after_cents)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Cargos ──────────────────────────────────────────────────────────────────

export function ChargeRow({
  charge,
  today,
  actions,
  staff = false,
}: {
  charge: LedgerCharge;
  today: string;
  actions?: React.ReactNode;
  staff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const period = formatPeriod(charge.period_start, charge.period_end);
  const paid = charge.status === "voided" ? 0 : charge.total_cents - charge.open_cents;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 basis-full items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:basis-auto sm:flex-1"
        >
          <ChevronDown
            size={16}
            className={cn("mt-0.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block line-clamp-2 text-sm font-medium sm:truncate">{charge.description}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {CHARGE_KIND_LABELS[charge.kind] ?? charge.kind} · vence {formatDay(charge.due_date)}
              {period && charge.kind !== "subscription_period" ? ` · ${period}` : ""}
            </span>
          </span>
        </button>
        <div className="ml-6 flex shrink-0 items-center gap-3 sm:ml-0">
          <div className="text-right">
            <p className="text-sm font-semibold tabular-nums">{formatCents(charge.total_cents)}</p>
            {charge.status !== "voided" && charge.open_cents > 0 && charge.open_cents < charge.total_cents && (
              <p className="text-xs tabular-nums text-muted-foreground">Pagado {formatCents(paid)}</p>
            )}
          </div>
          <ChargeStatusBadge charge={charge} today={today} />
          {actions}
        </div>
      </div>
      {open && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm sm:ml-6">
          <ul className="space-y-1.5">
            {charge.lines.map((l, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-muted-foreground">{l.description}</span>
                <span className={cn("shrink-0 tabular-nums", l.amount_cents < 0 && "text-success")}>
                  {formatCents(l.amount_cents)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2 font-semibold">
            <span>Total (IVA incluido)</span>
            <span className="tabular-nums">{formatCents(charge.total_cents)}</span>
          </div>
          {charge.status !== "voided" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Pagado {formatCents(paid)} · Pendiente {formatCents(charge.open_cents)}
            </p>
          )}
          {staff && charge.void_reason && (
            <p className="mt-2 text-xs text-muted-foreground">Anulado: {charge.void_reason}</p>
          )}
        </div>
      )}
    </li>
  );
}

export function ChargesList({
  charges,
  today,
  staff = false,
  renderActions,
}: {
  charges: LedgerCharge[];
  today: string;
  staff?: boolean;
  renderActions?: (c: LedgerCharge) => React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {charges.map((c) => (
        <ChargeRow key={c.id} charge={c} today={today} staff={staff} actions={renderActions?.(c)} />
      ))}
    </ul>
  );
}

// ── Pagos ───────────────────────────────────────────────────────────────────

export function PaymentsList({
  payments,
  staff = false,
  renderActions,
}: {
  payments: LedgerPayment[];
  staff?: boolean;
  renderActions?: (p: LedgerPayment) => React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {payments.map((p) => {
        const period = formatPeriod(p.period_start, p.period_end);
        return (
          <li key={p.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{PAYMENT_METHOD_LABELS[p.method] ?? p.method}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDay(p.paid_at)}
                {period ? ` · período ${period}` : ""}
                {staff && p.external_id ? ` · operación ${p.external_id}` : ""}
                {staff && p.payer_reference ? ` · ref. ${p.payer_reference}` : ""}
                {staff && p.recorded_by_name ? ` · ${p.recorded_by_name}` : ""}
              </p>
              {staff && p.notes && <p className="mt-1 text-xs text-muted-foreground">{p.notes}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm font-semibold tabular-nums">{formatCents(p.amount_cents)}</span>
              <PaymentStatusBadge status={p.status} />
              {renderActions?.(p)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
