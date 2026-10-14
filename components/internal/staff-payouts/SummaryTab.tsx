"use client";

// Resumen del mes (F21 · ADR-121): cobrado neto, gastos, a repartir, cuánto
// le toca a cada persona y la proyección del mes próximo con sus supuestos.

import { CalendarClock, HandCoins, Info, PiggyBank, Receipt, TrendingUp, Users } from "lucide-react";
import { KpiTile } from "@/components/internal/dashboard/KpiTile";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Disclosure } from "@/components/ui/Disclosure";
import { formatCompactArs } from "@/lib/internal/saasKpis";
import { formatBp, formatCents, formatDay, monthLabel } from "@/lib/staffPayouts/format";
import type { SettlementResult } from "@/supabase/functions/_shared/staff/settlement";
import type { PreviewResponse } from "@/modules/staffPayouts/api";
import { Card, Money, ResultNotices } from "./parts";

function PeopleTable({ current, projection, houseLabel }: { current: SettlementResult; projection: SettlementResult; houseLabel: string }) {
  const ids = [...new Set([...current.lines.map((l) => l.member_id), ...projection.lines.map((l) => l.member_id)])];
  const nameOf = (id: string) => current.lines.find((l) => l.member_id === id)?.name ?? projection.lines.find((l) => l.member_id === id)?.name ?? id;
  if (ids.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState compact icon={Users} title="Todavía no hay participaciones" description="Cargá a las personas y su porcentaje en la pestaña Participaciones." />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-3 font-medium">Persona</th>
            <th className="px-4 py-3 text-right font-medium">%</th>
            <th className="px-4 py-3 text-right font-medium">Le toca</th>
            <th className="px-4 py-3 text-right font-medium">Gastos</th>
            <th className="px-4 py-3 text-right font-medium">Neto del mes</th>
            <th className="px-4 py-3 text-right font-medium">Mes próximo</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const c = current.lines.find((l) => l.member_id === id);
            const p = projection.lines.find((l) => l.member_id === id);
            return (
              <tr key={id} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-3 font-medium">{nameOf(id)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatBp(c?.share_bp_end ?? p?.share_bp_end ?? 0)}</td>
                <td className="px-4 py-3 text-right"><Money cents={(c?.income_cents ?? 0) + (c?.signup_cents ?? 0)} /></td>
                <td className="px-4 py-3 text-right"><Money cents={-(c?.expense_cents ?? 0)} /></td>
                <td className="px-4 py-3 text-right"><Money cents={c?.net_cents ?? 0} strong /></td>
                <td className="px-4 py-3 text-right text-muted-foreground"><Money cents={p?.payable_cents ?? 0} /></td>
              </tr>
            );
          })}
          <tr className="bg-fg-4">
            <td className="px-4 py-3 font-medium">{houseLabel} (la casa)</td>
            <td className="px-4 py-3 text-right text-muted-foreground">resto</td>
            <td className="px-4 py-3 text-right"><Money cents={current.house.income_cents + current.house.signup_cents} /></td>
            <td className="px-4 py-3 text-right"><Money cents={-current.house.expense_cents} /></td>
            <td className="px-4 py-3 text-right"><Money cents={current.house.net_cents} strong /></td>
            <td className="px-4 py-3 text-right text-muted-foreground"><Money cents={projection.house.net_cents} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function SummaryTab({ preview }: { preview: PreviewResponse }) {
  const current = preview.current ?? preview.draft.result;
  const proj = preview.projection.result;
  const a = preview.projection.assumptions;
  const payableNext = proj.lines.reduce((s, l) => s + l.payable_cents, 0);

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          icon={CalendarClock}
          title={`${monthLabel(current.period)} (en curso)`}
          description="Estimado al día de hoy con lo que ya se cobró. Se cierra a partir del día 1 del mes siguiente."
        />
        <div className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Cobrado neto"
            icon={Receipt}
            value={formatCompactArs(current.base.net_cents / 100)}
            exact={formatCents(current.base.net_cents)}
            definition="Pagos aprobados del mes menos comisiones de cobro y menos reintegros y contracargos del mes (spec §20, decisión §22 #15)."
            sub={`${formatCents(current.base.gross_cents)} cobrado bruto`}
          />
          <KpiTile
            label="Gastos del mes"
            icon={PiggyBank}
            value={formatCompactArs(current.expenses_cents / 100)}
            exact={formatCents(current.expenses_cents)}
            definition="Gastos que caen en el mes: recurrentes, únicos y la cuota de los prorrateados, en pesos (los en dólares con la cotización del mes)."
            sub={`${current.expenses.length} ${current.expenses.length === 1 ? "gasto" : "gastos"}`}
          />
          <KpiTile
            label="A repartir"
            icon={HandCoins}
            value={formatCompactArs(current.to_share_cents / 100)}
            exact={formatCents(current.to_share_cents)}
            definition="Cobrado neto menos la reserva de impuestos y los gastos. Se reparte entre las personas y la casa."
            tone={current.to_share_cents < 0 ? "danger" : "default"}
          />
          <KpiTile
            label={`A liquidar en ${monthLabel(proj.period).toLowerCase()}`}
            icon={TrendingUp}
            value={formatCompactArs(payableNext / 100)}
            exact={formatCents(payableNext)}
            definition="Proyección: lo que NinjaPOS liquidaría a las personas el mes próximo si se cobra lo esperado, menos los gastos recurrentes. Es un estimado, no un monto garantizado."
            sub="Proyección con los supuestos de abajo"
          />
        </div>
      </section>

      <ResultNotices warnings={current.warnings} errors={current.errors} />

      <section>
        <SectionHeader icon={Users} title="Por persona" description="Lo que le toca a cada uno en el mes en curso y lo que cobraría el mes próximo." />
        <div className="mt-3">
          <PeopleTable current={current} projection={proj} houseLabel={preview.house_label} />
        </div>
      </section>

      <section>
        <SectionHeader icon={TrendingUp} title={`Proyección de ${monthLabel(proj.period).toLowerCase()}`} />
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <Card>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Esperado de {a.tenants} {a.tenants === 1 ? "cliente" : "clientes"}</dt>
                <dd><Money cents={a.expected_cents ?? 0} /></dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Tasa de cobro supuesta</dt>
                <dd className="tabular-nums">{formatBp(a.collection_rate_bp)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Comisión de cobro estimada</dt>
                <dd className="tabular-nums">{formatBp(a.fee_rate_bp)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Cobrado neto proyectado</dt>
                <dd><Money cents={proj.base.net_cents} /></dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Gastos recurrentes</dt>
                <dd><Money cents={-proj.expenses_cents} /></dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-border pt-2 font-semibold">
                <dt>A repartir</dt>
                <dd><Money cents={proj.to_share_cents} /></dd>
              </div>
            </dl>
          </Card>
          <Callout tone="info" icon={Info} title="Supuestos">
            <ul className="list-disc space-y-1 pl-4">
              {a.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Callout>
        </div>
        {(a.detail?.length ?? 0) > 0 && (
          <Disclosure className="mt-3" title={`Detalle por cliente (${a.detail!.length})`}>
            <ul className="divide-y divide-border/60 text-sm">
              {a.detail!.map((t) => (
                <li key={t.tenant_id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate">
                    {t.tenant_name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t.cycle === "yearly" ? "anual, renueva" : "mensual, vence"} {formatDay(t.due_date)}
                    </span>
                  </span>
                  <Money cents={t.expected_cents} />
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </section>
    </div>
  );
}
