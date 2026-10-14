"use client";

// =============================================================================
// "Mi suscripción > Estado de cuenta" (F20-1 · ADR-113, spec docs/40 §14.5).
// Lo que el negocio le debe a NinjaSoft: saldo, vencimientos y movimientos.
// Sólo lectura, para el dueño y el encargado (my_billing_statement valida el
// rol en el servidor). Sin motivos internos ni nombres del staff.
// =============================================================================

import { useState } from "react";
import { CalendarClock, CircleCheck, ReceiptText, Wallet } from "lucide-react";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { ChargesList, MovementsList, PaymentsList, StatementSummary } from "@/components/billing/StatementParts";
import { BILLING_MODE_LABELS, daysOverdue, formatCents, formatDay } from "@/lib/billing/ledger";
import { useMyStatement } from "@/modules/billing/ledger";

type View = "vencimientos" | "movimientos" | "pagos";

const VIEWS: { value: View; label: string }[] = [
  { value: "vencimientos", label: "Cargos" },
  { value: "movimientos", label: "Movimientos" },
  { value: "pagos", label: "Pagos" },
];

export function AccountStatementCard() {
  const { data: s, isLoading, error } = useMyStatement();
  const [view, setView] = useState<View>("vencimientos");

  // Sin la migración aplicada (o sin permiso) no mostramos nada: el panel de
  // suscripción sigue funcionando igual.
  if (error) return null;

  return (
    <section>
      <SectionHeader
        title="Estado de cuenta"
        icon={ReceiptText}
        description="Mi suscripción: lo que pagaste, lo que vence y tu saldo con NinjaSoft. Precios con IVA incluido."
      />

      {isLoading || !s ? (
        <div className="mt-3 space-y-3" aria-busy>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[104px] rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {s.overdue_cents > 0 ? (
            <Callout tone="danger" icon={CalendarClock} title={`Tenés ${formatCents(s.overdue_cents)} vencidos`}>
              Desde el {formatDay(s.oldest_due_date)} ({daysOverdue(s.oldest_due_date, s.as_of)} días). Si ya pagaste, puede tardar
              en verse; si no, escribinos para regularizar.
            </Callout>
          ) : s.balance_cents <= 0 && s.movements.length > 0 ? (
            <Callout tone="success" icon={CircleCheck} title="Estás al día">
              {s.next_due
                ? `Tu próximo vencimiento es el ${formatDay(s.next_due.date)} por ${formatCents(s.next_due.cents)}.`
                : "No tenés vencimientos pendientes."}
            </Callout>
          ) : null}

          <StatementSummary s={s} />

          <p className="text-xs text-muted-foreground">
            Cómo pagás: {BILLING_MODE_LABELS[s.billing_mode] ?? s.billing_mode}
            {s.recurring_cents != null && s.billing_mode !== "exempt"
              ? ` · cuota ${s.subscription?.billing_cycle === "yearly" ? "anual" : "mensual"} ${formatCents(s.recurring_cents)}`
              : ""}
            {s.subscription?.current_period_end ? ` · período actual hasta el ${formatDay(s.subscription.current_period_end)}` : ""}
          </p>

          {s.movements.length === 0 ? (
            <div className="rounded-xl border border-border bg-card">
              <EmptyState
                compact
                icon={ReceiptText}
                title="Todavía no hay movimientos"
                description="Cuando se renueve tu suscripción vas a ver acá cada cargo y cada pago."
              />
            </div>
          ) : (
            <>
              <Segmented<View>
                value={view}
                onChange={setView}
                options={VIEWS}
                fill
                className="sm:w-auto"
                aria-label="Vista del estado de cuenta"
              />
              {view === "vencimientos" &&
                (s.charges.length === 0 ? (
                  <EmptyState compact icon={CalendarClock} title="Sin cargos" />
                ) : (
                  <ChargesList charges={s.charges} today={s.as_of} />
                ))}
              {view === "movimientos" && <MovementsList movements={s.movements} />}
              {view === "pagos" &&
                (s.payments.length === 0 ? (
                  <EmptyState compact icon={Wallet} title="Sin pagos registrados" />
                ) : (
                  <PaymentsList payments={s.payments} />
                ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
AccountStatementCard.displayName = "AccountStatementCard";
