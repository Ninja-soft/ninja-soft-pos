"use client";

// =============================================================================
// Mi participación (F21 · ADR-121): cada persona del staff ve SÓLO lo suyo:
// su porcentaje, sus reglas por cliente, lo que lleva este mes, cuánto le
// liquidaría NinjaPOS el mes próximo (con los supuestos), sus liquidaciones y
// pagos, y sus cuentas de cobro (las puede cargar ella misma).
// =============================================================================

import { CalendarClock, CircleAlert, HandCoins, History, Info, Landmark, Percent, TrendingUp } from "lucide-react";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { RUN_STATUS, METHOD_LABEL, formatBp, formatCents, formatDay, monthLabel, ruleText, staffErrorMessage } from "@/lib/staffPayouts/format";
import { explainLine, type SettlementLine } from "@/supabase/functions/_shared/staff/settlement";
import { useMine, useMySummary, type MySummary } from "@/modules/staffPayouts/api";
import { AccountsList } from "./SharesTab";
import { Card, Money, StepsList } from "./parts";

function LineCard({ title, icon: Icon, line, note }: { title: string; icon: typeof CalendarClock; line: SettlementLine | null | undefined; note: string }) {
  return (
    <Card>
      <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon size={15} className="text-ninja-flameSoft" aria-hidden /> {title}
      </p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums">{formatCents(line?.payable_cents ?? 0)}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
      {line && (
        <Disclosure className="mt-3" title="Ver cálculo">
          <StepsList steps={explainLine(line)} />
        </Disclosure>
      )}
    </Card>
  );
}

export function MyParticipationView({ summary, mine }: { summary: MySummary; mine: ReturnType<typeof useMine>["data"] }) {
  const m = summary.member!;
  const current = summary.shares?.find((s) => !s.valid_to) ?? summary.shares?.[0];
  return (
    <div className="space-y-8">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Percent size={15} className="text-ninja-flameSoft" aria-hidden /> Tu participación
          </p>
          <p className="mt-1 font-display text-3xl font-bold tabular-nums">{formatBp(current?.share_bp ?? 0)}</p>
          <p className="text-xs text-muted-foreground">
            del cobrado neto{current ? ` desde el ${formatDay(current.valid_from)}` : ""}
            {current && current.expense_bp !== null ? ` · absorbés ${formatBp(current.expense_bp)} de los gastos` : ""}
          </p>
        </Card>
        <LineCard
          title={mine?.current ? `${monthLabel(mine.current.period)} (estimado al día)` : "Este mes"}
          icon={CalendarClock}
          line={mine?.current?.line}
          note="Con lo cobrado hasta hoy. Puede cambiar hasta el cierre."
        />
        <LineCard
          title={mine?.projection ? `Te liquidaría en ${monthLabel(mine.projection.period).toLowerCase()}` : "Mes próximo"}
          icon={TrendingUp}
          line={mine?.projection?.line}
          note="Proyección, no un monto garantizado."
        />
      </div>

      {mine?.projection?.assumptions && (
        <Callout tone="info" icon={Info} title="Cómo se proyecta el mes próximo">
          <ul className="list-disc space-y-1 pl-4">
            {mine.projection.assumptions.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>Tasa de cobro supuesta: {formatBp(mine.projection.assumptions.collection_rate_bp)}.</li>
          </ul>
        </Callout>
      )}

      {(summary.rules?.length ?? 0) > 0 && (
        <section>
          <SectionHeader icon={Percent} title="Tus reglas por cliente" />
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {summary.rules!.map((r) => (
              <li key={r.id} className="px-4 py-3 text-sm">
                <span className="font-medium">{r.tenant_name}</span>
                <span className="block text-xs text-muted-foreground">
                  {ruleText(r.kind, r.value, formatCents)} · desde {formatDay(r.valid_from)}
                  {r.valid_to ? ` hasta ${formatDay(r.valid_to)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionHeader icon={History} title="Tus liquidaciones" description="Lo que te tocó cada mes cerrado y lo que ya se te pagó." />
        {(summary.lines?.length ?? 0) === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Todavía no hay liquidaciones cerradas.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {summary.lines!.map((l) => {
              const st = RUN_STATUS[l.paid_cents >= l.payable_cents ? "paid" : l.paid_cents > 0 ? "partially_paid" : "closed"]!;
              return (
                <li key={l.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {monthLabel(l.period)} <Badge tone={st.tone}>{st.label}</Badge>
                    </p>
                    <span className="text-sm">
                      <Money cents={l.paid_cents} /> <span className="text-muted-foreground">de</span> <Money cents={l.payable_cents} strong />
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Te tocó {formatCents(l.income_cents + l.signup_cents)} · gastos {formatCents(-l.expense_cents)}
                    {l.adjustment_cents ? ` · ajustes ${formatCents(l.adjustment_cents)}` : ""}
                    {l.carry_out_cents < 0 ? ` · pasa al mes siguiente ${formatCents(l.carry_out_cents)}` : ""}
                  </p>
                  {l.payments.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                      {l.payments.map((p) => (
                        <li key={p.id}>
                          {formatDay(p.paid_on)} · {METHOD_LABEL[p.method] ?? p.method} · {formatCents(p.amount_cents)}
                          {p.account ? ` · ${p.account}` : ""}
                          {p.reference ? ` · ${p.reference}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader icon={Landmark} title="Tus cuentas de cobro" description="Adónde te transfiere NinjaSoft. Podés cargar más de una y elegir la predeterminada." />
        <div className="mt-3 max-w-xl">
          <AccountsList accounts={summary.accounts ?? []} memberId={m.id} />
        </div>
      </section>
    </div>
  );
}

export function MyParticipation() {
  const summary = useMySummary();
  const isMember = Boolean(summary.data?.member);
  const mine = useMine(isMember);
  return (
    <>
      <PageHeader
        eyebrow="Panel interno"
        title="Mi participación"
        icon={HandCoins}
        description="Tu porcentaje del cobrado neto de NinjaSoft, lo que llevás este mes y cuánto te liquidaría NinjaPOS el mes próximo."
      />
      <div className="mt-6">
        {summary.error || mine.error ? (
          <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar" actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void summary.refetch();
                  void mine.refetch();
                }}
              >
                Reintentar
              </Button>
            }>
            {staffErrorMessage(summary.error ?? mine.error)}
          </Callout>
        ) : summary.isLoading || (isMember && mine.isLoading) ? (
          <div className="grid gap-4 lg:grid-cols-3" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[140px] rounded-lg" />
            ))}
          </div>
        ) : !isMember ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState icon={HandCoins} title="No participás del reparto" description="Si creés que es un error, hablá con quien administra NinjaSoft." />
          </div>
        ) : (
          <MyParticipationView summary={summary.data!} mine={mine.data} />
        )}
      </div>
    </>
  );
}
